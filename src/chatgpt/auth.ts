import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const AUTH_DIR = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
export const AUTH_FILE = join(AUTH_DIR, 'auth.json');
export const LOGIN_HINT = 'codex login';

/** Public OAuth client id used by the Codex CLI. */
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const REFRESH_SCOPE = 'openid profile email';
const REFRESH_TIMEOUT_MS = 20_000;

interface CodexTokens {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  account_id?: string;
}

interface CodexAuthFile {
  OPENAI_API_KEY?: string | null;
  tokens?: CodexTokens | null;
  last_refresh?: string;
  auth_mode?: string;
  [key: string]: unknown;
}

export interface AuthState {
  signedIn: boolean;
  email?: string;
  plan?: string;
  accountId?: string;
  /** Unix ms the current access token expires, when it can be read. */
  expiresAt?: number;
  /** True when the access token is missing or about to expire. */
  needsRefresh: boolean;
  /** True when a refresh token is available to renew the session. */
  canRefresh: boolean;
  /** Set when the session is missing, expired, or a refresh was attempted and failed. */
  error?: string;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

interface JwtClaims {
  exp?: number;
  email?: string;
  'https://api.openai.com/auth'?: {
    chatgpt_account_id?: string;
    chatgpt_plan_type?: string;
    chatgpt_user_id?: string;
  };
}

function decodeClaims(token: unknown): JwtClaims {
  if (typeof token !== 'string' || token.length === 0) return {};
  const payload = token.split('.')[1];
  if (!payload) return {};
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as JwtClaims;
  } catch {
    return {};
  }
}

/** Rejects a partially written or hand-edited auth.json without throwing. */
function tokensOf(file: CodexAuthFile | undefined): CodexTokens | undefined {
  const tokens = file?.tokens;
  if (!tokens || typeof tokens !== 'object') return undefined;
  const present = (value: unknown) => typeof value === 'string' && value.length > 0;
  if (!present(tokens.access_token) && !present(tokens.refresh_token)) return undefined;
  return tokens;
}

async function readAuthFile(path: string): Promise<CodexAuthFile | undefined> {
  try {
    const text = await readFile(path, 'utf8');
    // A BOM is invalid to JSON.parse; some editors add one on Windows.
    const parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as CodexAuthFile) : undefined;
  } catch {
    return undefined;
  }
}

async function writeAuthFile(path: string, file: CodexAuthFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(file, null, 2), 'utf8');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads and refreshes the tokens written by `codex login`.
 *
 * The extension never runs its own OAuth flow: it borrows the official CLI's
 * credential file and keeps it fresh in place, so signing out in either place
 * signs out both.
 */
export class CodexAuth {
  private refreshInFlight?: Promise<CodexTokens>;
  private lastStatus: AuthState = { signedIn: false, needsRefresh: true, canRefresh: false };

  constructor(private readonly authFile: string = AUTH_FILE) {}

  /**
   * Never throws: activation, the settings panel and the proxy all call this
   * on paths where a malformed or half-written auth.json must not take the
   * extension (or the IDE) down.
   */
  async status(): Promise<AuthState> {
    try {
      const file = await readAuthFile(this.authFile);
      const tokens = tokensOf(file);
      if (!tokens) {
        this.lastStatus = {
          signedIn: false,
          needsRefresh: true,
          canRefresh: false,
          error: file ? 'auth.json has no ChatGPT session (API key mode)' : 'not signed in',
        };
        return this.lastStatus;
      }

      const claims = decodeClaims(tokens.id_token);
      const auth = claims['https://api.openai.com/auth'];
      const exp = decodeClaims(tokens.access_token).exp;
      const expiresAt = typeof exp === 'number' ? exp * 1000 : 0;
      const canRefresh = Boolean(tokens.refresh_token);
      const needsRefresh = !expiresAt || expiresAt - Date.now() < 60_000;

      this.lastStatus = {
        signedIn: Boolean(tokens.access_token || tokens.refresh_token),
        email: typeof claims.email === 'string' ? claims.email : undefined,
        plan: auth?.chatgpt_plan_type,
        accountId: tokens.account_id ?? auth?.chatgpt_account_id,
        expiresAt: expiresAt || undefined,
        needsRefresh,
        canRefresh,
        error: needsRefresh && !canRefresh ? 'refresh token missing; run "codex login" again' : undefined,
      };
      return this.lastStatus;
    } catch (error) {
      this.lastStatus = {
        signedIn: false,
        needsRefresh: true,
        canRefresh: false,
        error: `could not read ${this.authFile}: ${messageOf(error)}`,
      };
      return this.lastStatus;
    }
  }

  /** Tokens ready for an API call, refreshing them first when they are stale. */
  async get(): Promise<{ accessToken: string; accountId?: string }> {
    const file = await readAuthFile(this.authFile);
    const tokens = tokensOf(file);
    if (!tokens) {
      throw new AuthError(`Not signed in to ChatGPT. Run "${LOGIN_HINT}".`, 401);
    }

    const state = await this.status();
    let current = tokens;
    if (state.needsRefresh) current = await this.refresh(tokens);

    if (typeof current.access_token !== 'string' || !current.access_token) {
      throw new AuthError(`No access token. Run "${LOGIN_HINT}".`, 401);
    }
    return {
      accessToken: current.access_token,
      accountId: current.account_id ?? decodeClaims(current.id_token)['https://api.openai.com/auth']?.chatgpt_account_id,
    };
  }

  /** Forces a refresh; called after the API answers 401. */
  async forceRefresh(): Promise<void> {
    const file = await readAuthFile(this.authFile);
    const tokens = tokensOf(file);
    if (!tokens?.refresh_token) throw new AuthError(`Session expired. Run "${LOGIN_HINT}".`, 401);
    await this.refresh(tokens);
  }

  private refresh(tokens: CodexTokens): Promise<CodexTokens> {
    this.refreshInFlight ??= this.doRefresh(tokens).finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
  }

  private async doRefresh(tokens: CodexTokens): Promise<CodexTokens> {
    if (!tokens.refresh_token) throw new AuthError(`Session expired. Run "${LOGIN_HINT}".`, 401);

    let response: Response;
    try {
      response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
          scope: REFRESH_SCOPE,
        }),
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      });
    } catch (error) {
      throw new AuthError(
        `Could not reach the ChatGPT token service (${messageOf(error)}). Check your connection, then run "${LOGIN_HINT}".`,
        503,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new AuthError(`Token refresh failed (${response.status}). Run "${LOGIN_HINT}". ${text.slice(0, 200)}`, response.status);
    }

    const json = (await response.json()) as { access_token?: string; refresh_token?: string; id_token?: string };
    if (!json.access_token) throw new AuthError(`Token refresh returned no access token. Run "${LOGIN_HINT}".`, 401);

    const file = (await readAuthFile(this.authFile)) ?? {};
    const next: CodexTokens = {
      ...tokens,
      access_token: json.access_token,
      refresh_token: json.refresh_token ?? tokens.refresh_token,
      id_token: json.id_token ?? tokens.id_token,
    };
    next.account_id = tokens.account_id ?? decodeClaims(next.id_token)['https://api.openai.com/auth']?.chatgpt_account_id;

    await writeAuthFile(this.authFile, { ...file, tokens: next, last_refresh: new Date().toISOString() });
    return next;
  }
}
