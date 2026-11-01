import { ChatMessage, ChatRequest, ToolDefinition } from '../../chatgpt/types';
import type { ModelEntry } from '../../chatgpt/models';

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args?: unknown };
  functionResponse?: { name: string; response?: unknown };
  inlineData?: { mimeType: string; data: string };
}

export interface GeminiContent {
  role?: 'user' | 'model';
  parts?: GeminiPart[];
}

export interface GeminiRequest {
  contents?: GeminiContent[];
  systemInstruction?: { parts?: Array<{ text?: string }> };
  tools?: Array<{ functionDeclarations?: Array<{ name: string; description?: string; parameters?: unknown }> }>;
  generationConfig?: {
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
    thinkingConfig?: { includeThoughts?: boolean; thinkingLevel?: string; thinkingBudget?: number };
  };
  sessionId?: string;
  labels?: Record<string, string>;
}

export interface GeminiEnvelope {
  model?: string;
  requestId?: string;
  requestType?: string;
  request?: GeminiRequest;
}

/** Gemini proto-JSON uses uppercase enums for schema types; OpenAI wants JSON Schema. */
const NUMERIC_SCHEMA_KEYS = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
]);

export function toJsonSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema;
  const source = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    // Not part of JSON Schema; the ChatGPT backend rejects unknown keywords on
    // some models, and it carries no meaning for the model anyway.
    if (key === 'propertyOrdering' || key === 'property_ordering') continue;
    if (key === 'type' && typeof value === 'string') out.type = value.toLowerCase();
    else if (NUMERIC_SCHEMA_KEYS.has(key) && typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) {
      out[key] = Number(value);
    } else if (key === 'properties' && value && typeof value === 'object') {
      out.properties = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([name, child]) => [name, toJsonSchema(child)]),
      );
    } else if ((key === 'items' || key === 'additionalProperties') && value && typeof value === 'object') {
      out[key] = toJsonSchema(value);
    } else if ((key === 'anyOf' || key === 'oneOf' || key === 'allOf') && Array.isArray(value)) {
      out[key] = value.map(toJsonSchema);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function toTools(tools: GeminiRequest['tools']): ToolDefinition[] {
  const definitions: ToolDefinition[] = [];
  for (const tool of tools ?? []) {
    for (const declaration of tool.functionDeclarations ?? []) {
      definitions.push({
        type: 'function',
        function: {
          name: declaration.name,
          description: declaration.description,
          parameters: toJsonSchema(declaration.parameters),
        },
      });
    }
  }
  return definitions;
}

function inlineImage(part: GeminiPart): { type: 'image_url'; image_url: { url: string } } | undefined {
  if (!part.inlineData?.data) return undefined;
  const mime = part.inlineData.mimeType || 'image/png';
  return { type: 'image_url', image_url: { url: `data:${mime};base64,${part.inlineData.data}` } };
}

/**
 * Converts a Cloud Code generation request into an OpenRouter chat completion.
 *
 * Antigravity puts tool results in `role: "model"` contents as
 * `functionResponse` parts, so those contents become OpenAI `tool` messages.
 * Tool call ids are synthesised deterministically from position because the
 * Gemini format does not carry them.
 */
export function toChatRequest(envelope: GeminiEnvelope, entry: ModelEntry): ChatRequest {
  const request = envelope.request ?? {};
  const messages: ChatMessage[] = [];
  const pendingCalls: Array<{ id: string; name: string }> = [];

  const system = (request.systemInstruction?.parts ?? [])
    .map((part) => part.text ?? '')
    .filter(Boolean)
    .join('\n');
  if (system) messages.push({ role: 'system', content: system });

  for (const [contentIndex, content] of (request.contents ?? []).entries()) {
    const parts = content.parts ?? [];
    const responses = parts.filter((part) => part.functionResponse);
    const calls = parts.filter((part) => part.functionCall);

    if (responses.length > 0) {
      for (const part of responses) {
        const name = part.functionResponse?.name ?? '';
        const matchIndex = pendingCalls.findIndex((call) => call.name === name);
        const id = matchIndex >= 0 ? pendingCalls.splice(matchIndex, 1)[0].id : `call_${contentIndex}_${name}`;
        messages.push({
          role: 'tool',
          tool_call_id: id,
          content: JSON.stringify(part.functionResponse?.response ?? {}),
        });
      }
      // A content that only carries tool results has nothing else to send.
      if (calls.length === 0 && !parts.some((part) => part.text && !part.functionResponse)) continue;
    }

    const role: ChatMessage['role'] = content.role === 'model' ? 'assistant' : 'user';
    const texts: string[] = [];
    const images: Array<{ type: 'image_url'; image_url: { url: string } }> = [];
    const toolCalls: NonNullable<ChatMessage['tool_calls']> = [];

    for (const [partIndex, part] of parts.entries()) {
      if (part.functionCall) {
        const id = `call_${contentIndex}_${partIndex}`;
        pendingCalls.push({ id, name: part.functionCall.name });
        toolCalls.push({
          id,
          type: 'function',
          function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) },
        });
        continue;
      }
      if (part.functionResponse) continue;
      if (part.thought) continue;
      if (part.text) texts.push(part.text);
      const image = inlineImage(part);
      if (image) images.push(image);
    }

    if (texts.length === 0 && images.length === 0 && toolCalls.length === 0) continue;

    const message: ChatMessage = { role };
    if (images.length > 0) {
      const contentParts: NonNullable<ChatMessage['content']> = [];
      if (texts.length > 0) contentParts.push({ type: 'text', text: texts.join('\n') });
      contentParts.push(...images);
      message.content = contentParts;
    } else if (texts.length > 0) {
      message.content = texts.join('\n');
    }
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    messages.push(message);
  }

  const config = request.generationConfig ?? {};
  const chat: ChatRequest = {
    model: entry.modelId,
    messages,
    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
    ...(config.topP !== undefined ? { top_p: config.topP } : {}),
    ...(config.maxOutputTokens ? { max_tokens: config.maxOutputTokens } : {}),
  };

  const tools = toTools(request.tools);
  if (tools.length > 0) chat.tools = tools;

  const level = config.thinkingConfig?.thinkingLevel?.toLowerCase();
  if (level === 'low' || level === 'medium' || level === 'high') chat.reasoning = { effort: level };

  return chat;
}
