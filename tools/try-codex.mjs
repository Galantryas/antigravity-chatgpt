// Manual check of the ChatGPT/Codex endpoint used by the extension.
// Usage: node tools/try-codex.mjs [model]
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const AUTH = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const model = process.argv[2] || 'gpt-6.1-sol';

const claims = (token) => {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
};

const file = JSON.parse(await readFile(AUTH, 'utf8'));
let tokens = file.tokens;
if (!tokens?.refresh_token) throw new Error(`no ChatGPT tokens in ${AUTH}; run "codex login"`);

if ((claims(tokens.access_token).exp ?? 0) * 1000 - Date.now() < 60_000) {
  console.log('refreshing token…');
  const res = await fetch('https://auth.openai.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      scope: 'openid profile email',
    }),
  });
  if (!res.ok) throw new Error(`refresh failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  tokens = { ...tokens, ...json };
  await writeFile(AUTH, JSON.stringify({ ...file, tokens, last_refresh: new Date().toISOString() }, null, 2));
}

const accountId = tokens.account_id || claims(tokens.id_token)['https://api.openai.com/auth']?.chatgpt_account_id;
console.log('account:', claims(tokens.id_token).email, 'plan:', claims(tokens.id_token)['https://api.openai.com/auth']?.chatgpt_plan_type);

const body = {
  model,
  instructions: 'You are a terse test harness.',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hello and call the ping tool once.' }] }],
  tools: [
    {
      type: 'function',
      name: 'ping',
      description: 'Ping',
      parameters: { type: 'object', properties: { note: { type: 'string' } } },
      strict: false,
    },
  ],
  tool_choice: 'auto',
  parallel_tool_calls: true,
  reasoning: { effort: 'low', summary: 'auto' },
  stream: true,
  store: false,
  include: ['reasoning.encrypted_content'],
};

const res = await fetch('https://chatgpt.com/backend-api/codex/responses', {
  method: 'POST',
  headers: {
    authorization: `Bearer ${tokens.access_token}`,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    originator: 'codex_cli_rs',
    'user-agent': 'codex_cli_rs/0.166.0',
    session_id: crypto.randomUUID(),
    ...(accountId ? { 'chatgpt-account-id': accountId } : {}),
  },
  body: JSON.stringify(body),
});

console.log('status:', res.status, res.headers.get('content-type'));
if (!res.ok) {
  console.log((await res.text()).slice(0, 2000));
  process.exit(1);
}

const decoder = new TextDecoder();
let buffer = '';
for await (const chunk of res.body) {
  buffer += decoder.decode(chunk, { stream: true });
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line.startsWith('data:')) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    let ev;
    try {
      ev = JSON.parse(raw);
    } catch {
      continue;
    }
    if (ev.type === 'response.output_text.delta') process.stdout.write(ev.delta);
    else if (ev.type === 'response.function_call_arguments.done') console.log(`\n[tool] ${ev.name ?? ''} ${ev.arguments}`);
    else if (ev.type === 'response.completed') {
      console.log('\n[usage]', JSON.stringify(ev.response?.usage));
      process.exit(0);
    } else if (ev.type === 'response.failed' || ev.type === 'error') {
      console.log('\n[error]', JSON.stringify(ev).slice(0, 2000));
      process.exit(1);
    }
    if (process.env.RAW) console.log('\n>>', JSON.stringify(ev).slice(0, 600));
  }
}
