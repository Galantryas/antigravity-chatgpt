// Replays a captured Cloud Code generation request against the ChatGPT backend.
// Build: npx esbuild tools/replay.ts --bundle --platform=node --format=esm --outfile=out/replay.mjs
// Run:   node out/replay.mjs captures/<file>.req.txt [model]
import { readFile } from 'node:fs/promises';
import { toChatRequest, GeminiEnvelope } from '../src/proxy/translate/request.ts';
import { toResponsesRequest } from '../src/chatgpt/client.ts';
import { readFile as fsRead } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const capture = process.argv[2];
const model = process.argv[3] || 'gpt-6.1-sol';
const envelope = JSON.parse(await readFile(capture, 'utf8')) as GeminiEnvelope;

const chat = toChatRequest(envelope, {
  alias: 'debug',
  displayName: 'debug',
  modelId: model,
  vision: true,
  reasoning: true,
});
const body = toResponsesRequest(chat);
console.log(`messages=${chat.messages.length} tools=${chat.tools?.length ?? 0} body=${JSON.stringify(body).length}B`);

const AUTH = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');
const file = JSON.parse(await fsRead(AUTH, 'utf8'));
const tokens = file.tokens;

const res = await fetch('https://chatgpt.com/backend-api/codex/responses', {
  method: 'POST',
  headers: {
    authorization: `Bearer ${tokens.access_token}`,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    originator: 'codex_cli_rs',
    'user-agent': 'codex_cli_rs/0.166.0',
    session_id: crypto.randomUUID(),
    'chatgpt-account-id': tokens.account_id,
  },
  body: JSON.stringify(body),
});
console.log('status', res.status);
if (!res.ok) {
  console.log((await res.text()).slice(0, 3000));
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
      console.log('RAW', raw.slice(0, 300));
      continue;
    }
    if (ev.type === 'response.output_text.delta') process.stdout.write(ev.delta);
    else if (ev.type === 'response.function_call_arguments.done') console.log(`\n[tool:${ev.arguments}]`);
    else if (ev.type === 'response.completed') {
      console.log('\n[usage]', JSON.stringify(ev.response?.usage?.total_tokens));
      process.exit(0);
    } else if (ev.type === 'error' || ev.type === 'response.failed') {
      console.log('\n[EVENT]', JSON.stringify(ev).slice(0, 3000));
      process.exit(2);
    }
  }
}
