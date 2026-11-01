import { ChatGptError } from '../../chatgpt/client';
import { StreamChunk, Usage } from '../../chatgpt/types';

interface GeminiMessagePart {
  text?: string;
  thought?: boolean;
  functionCall?: { name: string; args: unknown };
}

interface GeminiCandidate {
  content: { role: 'model'; parts: GeminiMessagePart[] };
  finishReason?: string;
}

function usageMetadata(usage: Usage | undefined): Record<string, number> | undefined {
  if (!usage) return undefined;
  const out: Record<string, number> = {};
  if (usage.prompt_tokens !== undefined) out.promptTokenCount = usage.prompt_tokens;
  if (usage.completion_tokens !== undefined) out.candidatesTokenCount = usage.completion_tokens;
  if (usage.total_tokens !== undefined) out.totalTokenCount = usage.total_tokens;
  const cached = usage.prompt_tokens_details?.cached_tokens;
  if (cached) out.cachedContentTokenCount = cached;
  const thoughts = usage.completion_tokens_details?.reasoning_tokens;
  if (thoughts) out.thoughtsTokenCount = thoughts;
  return out;
}

/**
 * Turns OpenRouter stream chunks into the Cloud Code SSE envelope the language
 * server expects: `data: {"response":{candidates,usageMetadata},"traceId","metadata":{}}`.
 */
export class GeminiStreamTranslator {
  private readonly toolCalls = new Map<number, { id: string; name: string; args: string }>();
  private usage?: Usage;
  private finishReason: string | undefined;

  constructor(private readonly traceId: string) {}

  push(chunk: StreamChunk): string[] {
    const frames: string[] = [];

    if (chunk.error) return [errorFrame(chunk.error.code ?? 500, chunk.error.message ?? 'ChatGPT error')];
    if (chunk.usage) this.usage = chunk.usage;

    const choice = chunk.choices?.[0];
    if (!choice) return frames;

    const delta = choice.delta ?? {};
    if (delta.reasoning) frames.push(this.frame([{ content: { role: 'model', parts: [{ thought: true, text: delta.reasoning }] } }]));
    if (delta.content) frames.push(this.frame([{ content: { role: 'model', parts: [{ text: delta.content }] } }]));

    for (const call of delta.tool_calls ?? []) {
      const existing = this.toolCalls.get(call.index) ?? { id: call.id ?? `call_${call.index}`, name: '', args: '' };
      if (call.id) existing.id = call.id;
      if (call.function?.name) existing.name = call.function.name;
      if (call.function?.arguments) existing.args += call.function.arguments;
      this.toolCalls.set(call.index, existing);
    }

    if (choice.finish_reason) this.finishReason = choice.finish_reason;
    return frames;
  }

  /** Emits pending tool calls and the terminating frame. */
  finish(): string[] {
    const frames: string[] = [];

    if (this.toolCalls.size > 0) {
      const parts: GeminiMessagePart[] = [...this.toolCalls.values()]
        .filter((call) => call.name)
        .map((call) => ({ functionCall: { name: call.name, args: parseArgs(call.args) } }));
      if (parts.length > 0) frames.push(this.frame([{ content: { role: 'model', parts } }]));
      this.toolCalls.clear();
    }

    const finishReason = this.finishReason === 'length' ? 'MAX_TOKENS' : 'STOP';
    frames.push(
      this.frame(
        [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason }],
        usageMetadata(this.usage),
      ),
    );
    return frames;
  }

  private frame(candidates: GeminiCandidate[], usage?: Record<string, number>): string {
    const response = {
      candidates,
      ...(usage ? { usageMetadata: usage } : {}),
    };
    return `data: ${JSON.stringify({ response, traceId: this.traceId, metadata: {} })}\n\n`;
  }
}

export function errorFrame(code: number, message: string): string {
  return `data: ${JSON.stringify({ error: { code, message, status: statusFor(code) }, metadata: {} })}\n\n`;
}

export function errorFrameFrom(error: unknown): string {
  if (error instanceof ChatGptError) return errorFrame(error.status || 500, error.message);
  return errorFrame(500, (error as Error)?.message ?? 'proxy error');
}

/** Non-streaming `generateContent` equivalent of a finished stream. */
export function toGenerateContentResponse(frames: string[]): unknown {
  const candidates: unknown[] = [];
  let usageMetadata: unknown;

  for (const frame of frames) {
    const payload = frame.replace(/^data:\s*/, '').trim();
    if (!payload) continue;
    try {
      const parsed = JSON.parse(payload) as {
        response?: { candidates?: unknown[]; usageMetadata?: unknown };
        error?: unknown;
      };
      if (parsed.error) return { error: parsed.error };
      if (parsed.response?.candidates) candidates.push(...parsed.response.candidates);
      if (parsed.response?.usageMetadata) usageMetadata = parsed.response.usageMetadata;
    } catch {
      // ignore malformed frames
    }
  }

  return { candidates: mergeCandidateParts(candidates), ...(usageMetadata ? { usageMetadata } : {}) };
}

function mergeCandidateParts(candidates: unknown[]): unknown[] {
  if (candidates.length === 0) return [];
  const parts: unknown[] = [];
  let finishReason: string | undefined;
  for (const candidate of candidates as Array<{ content?: { parts?: unknown[] }; finishReason?: string }>) {
    parts.push(...(candidate.content?.parts ?? []));
    if (candidate.finishReason) finishReason = candidate.finishReason;
  }
  return [{ content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) }];
}

function statusFor(code: number): string {
  switch (code) {
    case 400:
      return 'INVALID_ARGUMENT';
    case 401:
      return 'UNAUTHENTICATED';
    case 402:
    case 403:
      return 'PERMISSION_DENIED';
    case 404:
      return 'NOT_FOUND';
    case 429:
      return 'RESOURCE_EXHAUSTED';
    default:
      return code >= 500 ? 'UNAVAILABLE' : 'UNKNOWN';
  }
}

function parseArgs(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}
