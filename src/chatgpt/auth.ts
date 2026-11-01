import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const AUTH_DIR = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
export const AUTH_FILE = join(AUTH_DIR, 'auth.json');
export const LOGIN_HINT = 'codex login';

/** Public OAuth client id used by the Codex CLI. */
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const REFRESH_SCOPE = 'openid profile email';

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
  /** Set when a refresh was attempted and failed. */
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

function decodeClaims(token: string | undefined): JwtClaims {
  if (!token) return {};
  const payload = token.split('.')[1];
  if (!payload) return {};
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as JwtClaims;
  } catch {
    return {};
  }
}

async function readAuthFile(): Promise<CodexAuthFile | undefined> {
  try {
    return JSON.parse(await readFile(AUTH_FILE, 'utf8')) as CodexAuthFile;
  } catch {
    return undefined;
  }
}

async function writeAuthFile(file: CodexAuthFile): Promise<void> {
  await mkdir(AUTH_DIR, { recursive: true });
  await writeFile(AUTH_FILE, JSON.stringify(file, null, 2), 'utf8');
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
  private lastStatus: AuthState = { signedIn: false, needsRefresh: true };

  async status(): Promise<AuthState> {
    const file = await readAuthFile();
    const tokens = file?.tokens;
    if (!tokens?.access_token && !tokens?.refresh_token) {
      this.lastStatus = {
        signedIn: false,
        needsRefresh: true,
        error: file ? 'auth.json has no ChatGPT session (API key mode)' : 'not signed in',
      };
      return this.lastStatus;
    }

    const claims = decodeClaims(tokens.id_token);
    const auth = claims['https://api.openai.com/auth'];
    const expiresAt = (decodeClaims(tokens.access_token).exp ?? 0) * 1000;
    const needsRefresh = !expiresAt || expiresAt - Date.now() < 60_000;

    this.lastStatus = {
      signedIn: Boolean(tokens.refresh_token || tokens.access_token),
      email: claims.email,
      plan: auth?.chatgpt_plan_type,
      accountId: tokens.account_id ?? auth?.chatgpt_account_id,
      expiresAt: expiresAt || undefined,
      needsRefresh,
      error: needsRefresh && !tokens.refresh_token ? 'refresh token missing' : undefined,
    };
    return this.lastStatus;
  }

  /** Tokens ready for an API call, refreshing them first when they are stale. */
  async get(): Promise<{ accessToken: string; accountId?: string }> {
    const file = await readAuthFile();
    const tokens = file?.tokens;
    if (!tokens?.access_token && !tokens?.refresh_token) {
      throw new AuthError(`Not signed in to ChatGPT. Run "${LOGIN_HINT}".`, 401);
    }

    const state = await this.status();
    let current = tokens;
    if (state.needsRefresh) current = await this.refresh(tokens);

    if (!current.access_token) throw new AuthError(`No access token. Run "${LOGIN_HINT}".`, 401);
    return {
      accessToken: current.access_token,
      accountId: current.account_id ?? decodeClaims(current.id_token)['https://api.openai.com/auth']?.chatgpt_account_id,
    };
  }

  /** Forces a refresh; called after the API answers 401. */
  async forceRefresh(): Promise<void> {
    const file = await readAuthFile();
    if (!file?.tokens?.refresh_token) throw new AuthError(`Session expired. Run "${LOGIN_HINT}".`, 401);
    await this.refresh(file.tokens);
  }

  private refresh(tokens: CodexTokens): Promise<CodexTokens> {
    this.refreshInFlight ??= this.doRefresh(tokens).finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
  }

  private async doRefresh(tokens: CodexTokens): Promise<CodexTokens> {
    if (!tokens.refresh_token) throw new AuthError(`Session expired. Run "${LOGIN_HINT}".`, 401);

    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        scope: REFRESH_SCOPE,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new AuthError(`Token refresh failed (${response.status}). Run "${LOGIN_HINT}". ${text.slice(0, 200)}`, response.status);
    }

    const json = (await response.json()) as { access_token?: string; refresh_token?: string; id_token?: string };
    if (!json.access_token) throw new AuthError(`Token refresh returned no access token. Run "${LOGIN_HINT}".`, 401);

    const file = (await readAuthFile()) ?? {};
    const next: CodexTokens = {
      ...tokens,
      access_token: json.access_token,
      refresh_token: json.refresh_token ?? tokens.refresh_token,
      id_token: json.id_token ?? tokens.id_token,
    };
    next.account_id = tokens.account_id ?? decodeClaims(next.id_token)['https://api.openai.com/auth']?.chatgpt_account_id;

    await writeAuthFile({ ...file, tokens: next, last_refresh: new Date().toISOString() });
    return next;
  }
}
