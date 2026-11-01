/** A model the ChatGPT account can drive, as shown in the Antigravity picker. */
export interface ProviderModelInfo {
  id: string;
  name: string;
  context_length?: number;
  vision?: boolean;
  reasoning?: boolean;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  reasoning?: { effort?: 'low' | 'medium' | 'high' };
  [key: string]: unknown;
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

export interface StreamDelta {
  content?: string | null;
  reasoning?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

export interface StreamChunk {
  id?: string;
  model?: string;
  choices?: Array<{ index: number; delta?: StreamDelta; finish_reason?: string | null }>;
  usage?: Usage | null;
  error?: { code?: number; message?: string; metadata?: unknown };
}
