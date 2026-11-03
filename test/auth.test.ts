import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAuth } from '../src/chatgpt/auth.ts';

function jwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

async function withAuthFile(contents: unknown, run: (auth: CodexAuth) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'antigravity-chatgpt-auth-'));
  const file = join(dir, 'auth.json');
  if (contents !== undefined) {
    await writeFile(file, typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf8');
  }
  try {
    await run(new CodexAuth(file));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('status does not throw when auth.json is missing', async () => {
  await withAuthFile(undefined, async (auth) => {
    const state = await auth.status();
    assert.equal(state.signedIn, false);
    assert.equal(state.needsRefresh, true);
    assert.equal(state.canRefresh, false);
    assert.match(state.error ?? '', /not signed in/);
  });
});

test('status does not throw on a malformed token field', async () => {
  await withAuthFile(
    {
      auth_mode: 'chatgpt',
      tokens: {
        access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
        id_token: 42,
        refresh_token: 'refresh',
      },
    },
    async (auth) => {
      const state = await auth.status();
      assert.equal(state.signedIn, true);
      assert.equal(state.needsRefresh, false);
      assert.equal(state.canRefresh, true);
    },
  );
});

test('status flags an expired session that cannot be refreshed', async () => {
  await withAuthFile(
    {
      tokens: {
        access_token: jwt({ exp: Math.floor(Date.now() / 1000) - 60 }),
      },
    },
    async (auth) => {
      const state = await auth.status();
      assert.equal(state.signedIn, true);
      assert.equal(state.needsRefresh, true);
      assert.equal(state.canRefresh, false);
      assert.match(state.error ?? '', /refresh token missing/);
    },
  );
});

test('status reads the account from the id token', async () => {
  await withAuthFile(
    {
      tokens: {
        access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
        id_token: jwt({
          email: 'user@example.com',
          'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: 'acct' },
        }),
        refresh_token: 'refresh',
      },
    },
    async (auth) => {
      const state = await auth.status();
      assert.equal(state.email, 'user@example.com');
      assert.equal(state.plan, 'plus');
      assert.equal(state.accountId, 'acct');
    },
  );
});

test('status tolerates a UTF-8 BOM in auth.json', async () => {
  await withAuthFile(
    `\uFEFF${JSON.stringify({
      tokens: {
        access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
        refresh_token: 'refresh',
      },
    })}`,
    async (auth) => {
      const state = await auth.status();
      assert.equal(state.signedIn, true);
      assert.equal(state.canRefresh, true);
    },
  );
});

test('status survives a partially written auth.json', async () => {
  await withAuthFile('{"tokens": {"access_token": ', async (auth) => {
    const state = await auth.status();
    assert.equal(state.signedIn, false);
    assert.match(state.error ?? '', /not signed in/);
  });
});

test('get rejects a session with no tokens', async () => {
  await withAuthFile({ auth_mode: 'apikey', tokens: null }, async (auth) => {
    await assert.rejects(() => auth.get(), /Not signed in/);
  });
});

test('forceRefresh rejects a session with no refresh token', async () => {
  await withAuthFile(
    { tokens: { access_token: jwt({ exp: Math.floor(Date.now() / 1000) - 60 }) } },
    async (auth) => {
      await assert.rejects(() => auth.forceRefresh(), /Session expired/);
    },
  );
});
