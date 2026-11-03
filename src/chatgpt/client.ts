import { randomUUID } from 'node:crypto';
import { AuthError, CodexAuth, LOGIN_HINT } from './auth';
import { ChatMessage, ChatRequest, ProviderModelInfo, StreamChunk, Usage } from './types';

const BASE = 'https://chatgpt.com/backend-api/codex';
const CLI_VERSION = '0.166.0';

/** Offline fallback when the account catalog cannot be fetched. */
export const MODEL_CATALOG: ProviderModelInfo[] = [
  { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', context_length: 500_000, vision: true, reasoning: true },
  { id: 'gpt-6-astra', name: 'GPT-6-Astra', context_length: 272_000, vision: true, reasoning: true },
  { id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra', context_length: 500_000, vision: true, reasoning: true },
  { id: 'gpt-6-luna', name: 'GPT-6-Luna', context_length: 272_000, vision: true, reasoning: true },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', context_length: 272_000, vision: true, reasoning: true },
];

interface ApiModel {
  slug: string;
  display_name?: string;
  context_window?: number;
  input_modalities?: string[];
  visibility?: string;
  supported_in_api?: boolean;
  priority?: number;
  supported_reasoning_levels?: Array<{ effort?: string }>;
}

export class ChatGptError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'ChatGptError';
  }
}

export class ChatGptClient {
  readonly auth: CodexAuth;

  constructor(auth?: CodexAuth) {
    this.auth = auth ?? new CodexAuth();
  }

  async hasKey(): Promise<boolean> {
    try {
      const state = await this.auth.status();
      // An expired session with no refresh token cannot answer a request; treat
      // it like a missing key so the router explains the fix instead of
      // starting a call that is guaranteed to fail.
      return state.signedIn && !(state.needsRefresh && state.canRefresh === false);
    } catch {
      return false;
    }
  }

  async listModels(): Promise<ProviderModelInfo[]> {
    const state = await this.auth.status();
    if (!state.signedIn) throw new ChatGptError('Not signed in to ChatGPT', 401);

    try {
      const { accessToken, accountId } = await this.auth.get();
      const response = await fetch(`${BASE}/models?client_version=${CLI_VERSION}`, {
        headers: authHeaders(accessToken, accountId),
      });
      if (!response.ok) throw new ChatGptError(`model list failed (${response.status})`, response.status);
      const json = (await response.json()) as { models?: ApiModel[] };
      const models = (json.models ?? [])
        .filter((model) => model.slug && model.supported_in_api !== false && model.visibility !== 'hide')
        .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
        .map((model) => ({
          id: model.slug,
          name: model.display_name ?? model.slug,
          context_length: model.context_window,
          vision: (model.input_modalities ?? []).includes('image'),
          reasoning: Boolean(model.supported_reasoning_levels?.length),
        }));
      if (models.length > 0) return models;
    } catch {
      // fall through to the offline list
    }
    return MODEL_CATALOG;
  }

  /** Cheap authenticated call used by the "check sign-in" command. */
  async validate(): Promise<{ ok: boolean; message: string }> {
    const state = await this.auth.status();
    if (!state.signedIn) return { ok: false, message: state.error ?? `Not signed in. Run "${LOGIN_HINT}".` };
    if (state.needsRefresh && state.canRefresh === false) {
      return { ok: false, message: state.error ?? `Session expired. Run "${LOGIN_HINT}".` };
    }
    try {
      await this.auth.get();
      const who = state.email ? `${state.email}${state.plan ? ` (${state.plan})` : ''}` : 'ChatGPT account';
      return { ok: true, message: `signed in as ${who}` };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  async *streamChat(body: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamChunk> {
    const payload = toResponsesRequest(body);
    const response = await this.post(payload, signal, true);

    const decoder = new TextDecoder();
    let buffer = '';
    let data: string[] = [];

    const flush = (): StreamChunk[] => {
      const raw = data.join('\n').trim();
      data = [];
      if (!raw || raw === '[DONE]') return [];
      try {
        return this.toChunks(JSON.parse(raw) as Record<string, unknown>);
      } catch (error) {
        if (error instanceof ChatGptError) throw error;
        return [];
      }
    };

    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);

        if (line === '') {
          for (const out of flush()) yield out;
          continue;
        }
        if (line.startsWith('data:')) data.push(line.slice(5).trim());
      }
    }
    for (const out of flush()) yield out;
  }

  private toChunks(event: Record<string, unknown>): StreamChunk[] {
    const type = String(event.type ?? '');
    const out: StreamChunk[] = [];

    switch (type) {
      case 'response.output_text.delta': {
        if (typeof event.delta === 'string' && event.delta) {
          out.push({ choices: [{ index: 0, delta: { content: event.delta } }] });
        }
        return out;
      }
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': {
        if (typeof event.delta === 'string' && event.delta) {
          out.push({ choices: [{ index: 0, delta: { reasoning: event.delta } }] });
        }
        return out;
      }
      case 'response.output_item.added': {
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.type === 'function_call') {
          const index = this.toolIndex(String(item.id ?? item.call_id ?? randomUUID()));
          out.push({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index,
                      id: String(item.call_id ?? item.id ?? `call_${index}`),
                      type: 'function',
                      function: { name: String(item.name ?? ''), arguments: '' },
                    },
                  ],
                },
              },
            ],
          });
        }
        return out;
      }
      case 'response.function_call_arguments.delta': {
        const index = this.toolIndex(String(event.item_id ?? ''));
        if (typeof event.delta === 'string' && event.delta) {
          out.push({
            choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: event.delta } }] } }],
          });
        }
        return out;
      }
      case 'response.completed': {
        const response = event.response as Record<string, unknown> | undefined;
        out.push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: toUsage(response?.usage) });
        return out;
      }
      case 'response.failed': {
        const response = event.response as Record<string, unknown> | undefined;
        const error = response?.error as Record<string, unknown> | undefined;
        throw new ChatGptError(String(error?.message ?? 'ChatGPT response failed'), 500, JSON.stringify(event));
      }
      case 'error': {
        const nested = event.error as Record<string, unknown> | undefined;
        const message = String(event.message ?? nested?.message ?? 'ChatGPT stream error');
        throw new ChatGptError(message, Number(event.code) || 400, JSON.stringify(event));
      }
      default:
        return out;
    }
  }

  private toolIndexes = new Map<string, number>();

  private toolIndex(itemId: string): number {
    const existing = this.toolIndexes.get(itemId);
    if (existing !== undefined) return existing;
    // One stream at a time per client instance, so a local counter is enough.
    const next = this.toolIndexes.size;
    this.toolIndexes.set(itemId, next);
    return next;
  }

  private async post(payload: unknown, signal: AbortSignal, retryOn401: boolean): Promise<Response> {
    this.toolIndexes.clear();
    const { accessToken, accountId } = await this.auth.get();

    const response = await fetch(`${BASE}/responses`, {
      method: 'POST',
      signal,
      headers: authHeaders(accessToken, accountId),
      body: JSON.stringify(payload),
    });

    if (response.ok) return response;

    const text = await response.text().catch(() => '');
    if (response.status === 401 && retryOn401) {
      await this.auth.forceRefresh().catch(() => undefined);
      return this.post(payload, signal, false);
    }
    throw new ChatGptError(errorMessage(response.status, text), response.status, text);
  }
}

function authHeaders(accessToken: string, accountId?: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    originator: 'codex_cli_rs',
    'user-agent': `codex_cli_rs/${CLI_VERSION}`,
    session_id: randomUUID(),
    ...(accountId ? { 'chatgpt-account-id': accountId } : {}),
  };
}

function errorMessage(status: number, body: string): string {
  const trimmed = body.slice(0, 400);
  switch (status) {
    case 401:
      return `ChatGPT rejected the session (401). Run "codex login". ${trimmed}`;
    case 403:
      return `ChatGPT refused the request (403). The model may not be included in this plan. ${trimmed}`;
    case 404:
      return `Model not found (404). Check the model id in Antigravity ChatGPT settings. ${trimmed}`;
    case 429:
      return `ChatGPT rate limit (429). Wait a moment, then send again. ${trimmed}`;
    default:
      return `ChatGPT HTTP ${status}: ${trimmed}`;
  }
}

function toUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const usage = raw as Record<string, unknown>;
  const detail = (key: string) => {
    const value = usage[key];
    return value && typeof value === 'object' ? (value as Record<string, number>) : undefined;
  };
  return {
    prompt_tokens: numberOrUndefined(usage.input_tokens),
    completion_tokens: numberOrUndefined(usage.output_tokens),
    total_tokens: numberOrUndefined(usage.total_tokens),
    prompt_tokens_details: { cached_tokens: numberOrUndefined(detail('input_tokens_details')?.cached_tokens) },
    completion_tokens_details: {
      reasoning_tokens: numberOrUndefined(detail('output_tokens_details')?.reasoning_tokens),
    },
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/** Extracts plain text from a chat message made of string or part arrays. */
function textOf(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content;
  return (message.content ?? [])
    .map((part) => (part.type === 'text' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

function imagesOf(message: ChatMessage): string[] {
  if (!Array.isArray(message.content)) return [];
  return message.content.filter((part) => part.type === 'image_url').map((part) => part.image_url.url);
}

/**
 * Chat Completions → Responses API.
 *
 * Antigravity already speaks Chat Completions through the existing translator,
 * so keeping that boundary means only the provider client changes when the
 * upstream API moves.
 */
export function toResponsesRequest(request: ChatRequest): Record<string, unknown> {
  const instructions = request.messages
    .filter((message) => message.role === 'system')
    .map(textOf)
    .filter(Boolean)
    .join('\n\n');

  const input: unknown[] = [];
  for (const message of request.messages) {
    if (message.role === 'system') continue;

    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id ?? 'call_unknown',
        output: textOf(message) || '{}',
      });
      continue;
    }

    if (message.role === 'assistant') {
      const text = textOf(message);
      if (text) {
        input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
      }
      for (const call of message.tool_calls ?? []) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments || '{}',
        });
      }
      continue;
    }

    const content: unknown[] = [];
    const text = textOf(message);
    if (text) content.push({ type: 'input_text', text });
    for (const url of imagesOf(message)) content.push({ type: 'input_image', image_url: url });
    if (content.length === 0) content.push({ type: 'input_text', text: '' });
    input.push({ type: 'message', role: 'user', content });
  }

  const body: Record<string, unknown> = {
    model: request.model,
    ...(instructions ? { instructions } : {}),
    input,
    stream: true,
    store: false,
    include: ['reasoning.encrypted_content'],
  };

  const tools = request.tools?.map((tool) => ({
    type: 'function',
    name: tool.function.name,
    ...(tool.function.description ? { description: tool.function.description } : {}),
    parameters: tool.function.parameters ?? { type: 'object', properties: {} },
    strict: false,
  }));
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
    body.parallel_tool_calls = true;
  }

  if (request.reasoning?.effort) {
    body.reasoning = { effort: request.reasoning.effort, summary: 'auto' };
  }

  return body;
}

export { AuthError };
