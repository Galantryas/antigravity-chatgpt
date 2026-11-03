import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatGptClient } from '../src/chatgpt/client.ts';
import { GeminiStreamTranslator } from '../src/proxy/translate/response.ts';
import type { ChatRequest } from '../src/chatgpt/types.ts';

function fakeAuth() {
  return {
    status: async () => ({ signedIn: true, needsRefresh: false }),
    get: async () => ({ accessToken: 'token', accountId: 'acct' }),
    forceRefresh: async () => undefined,
  } as never;
}

function sse(events: unknown[]): Response {
  const text = events.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

const request: ChatRequest = {
  model: 'gpt-6.1-sol',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: {} } } }],
};

test('hasKey rejects an expired session that cannot be refreshed', async () => {
  const client = new ChatGptClient({
    status: async () => ({ signedIn: true, needsRefresh: true, canRefresh: false }),
  } as never);
  assert.equal(await client.hasKey(), false);
});

test('validate explains an expired session without a refresh token', async () => {
  const client = new ChatGptClient({
    status: async () => ({
      signedIn: true,
      needsRefresh: true,
      canRefresh: false,
      error: 'refresh token missing; run "codex login" again',
    }),
  } as never);
  const result = await client.validate();
  assert.equal(result.ok, false);
  assert.match(result.message, /refresh token missing/);
});

test('hasKey survives an auth status that throws', async () => {
  const client = new ChatGptClient({
    status: async () => {
      throw new Error('boom');
    },
  } as never);
  assert.equal(await client.hasKey(), false);
});

test('responses SSE becomes chat chunks with text, tool call and usage', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    sse([
      { type: 'response.created', response: { id: 'resp_1' } },
      { type: 'response.output_text.delta', delta: 'Let me ' },
      { type: 'response.output_text.delta', delta: 'look.' },
      {
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '' },
      },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"Path":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"a.txt"}' },
      { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } },
    ])) as typeof fetch;

  try {
    const client = new ChatGptClient(fakeAuth());
    const translator = new GeminiStreamTranslator('trace');
    const frames: string[] = [];
    for await (const chunk of client.streamChat(request, new AbortController().signal)) {
      frames.push(...translator.push(chunk));
    }
    frames.push(...translator.finish());

    const parsed = frames.map((frame) => JSON.parse(frame.replace(/^data: /, '')));
    const text = parsed
      .flatMap((frame) => frame.response.candidates[0].content.parts)
      .filter((part: { text?: string }) => typeof part.text === 'string' && part.text)
      .map((part: { text: string }) => part.text)
      .join('');
    assert.equal(text, 'Let me look.');

    const call = parsed
      .flatMap((frame) => frame.response.candidates[0].content.parts)
      .find((part: { functionCall?: unknown }) => part.functionCall);
    assert.deepEqual(call.functionCall, { name: 'read_file', args: { Path: 'a.txt' } });

    const final = parsed.at(-1);
    assert.equal(final.response.candidates[0].finishReason, 'STOP');
    assert.deepEqual(final.response.usageMetadata, {
      promptTokenCount: 10,
      candidatesTokenCount: 4,
      totalTokenCount: 14,
    });
  } finally {
    globalThis.fetch = original;
  }
});

test('a failed response event surfaces as an error', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    sse([{ type: 'response.failed', response: { error: { message: 'nope' } } }])) as typeof fetch;
  try {
    const client = new ChatGptClient(fakeAuth());
    await assert.rejects(async () => {
      for await (const _chunk of client.streamChat(request, new AbortController().signal)) {
        // drain
      }
    }, /nope/);
  } finally {
    globalThis.fetch = original;
  }
});

test('requests use the chatgpt backend and codex headers', async () => {
  const original = globalThis.fetch;
  let seenUrl = '';
  let seenHeaders: Record<string, string> = {};
  let seenBody: Record<string, unknown> = {};
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seenUrl = String(url);
    seenHeaders = init.headers as Record<string, string>;
    seenBody = JSON.parse(String(init.body)) as Record<string, unknown>;
    return sse([{ type: 'response.output_text.delta', delta: 'ok' }, { type: 'response.completed', response: {} }]);
  }) as unknown as typeof fetch;

  try {
    const client = new ChatGptClient(fakeAuth());
    for await (const _chunk of client.streamChat(request, new AbortController().signal)) {
      // drain
    }
    assert.match(seenUrl, /^https:\/\/chatgpt\.com\/backend-api\/codex\/responses$/);
    assert.equal(seenHeaders.authorization, 'Bearer token');
    assert.equal(seenHeaders['chatgpt-account-id'], 'acct');
    assert.equal(seenHeaders.originator, 'codex_cli_rs');
    assert.equal(seenBody.model, 'gpt-6.1-sol');
    assert.equal(seenBody.store, false);
  } finally {
    globalThis.fetch = original;
  }
});
