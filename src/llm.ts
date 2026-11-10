/**
 * Minimal streaming client for any OpenAI-compatible chat-completions API.
 * Raw fetch + SSE parsing, no SDK - the whole repo has zero runtime
 * dependencies, and every line is explainable.
 */

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments string, as streamed by the API. */
  arguments: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
}

export interface ChatParams {
  messages: ChatMessage[];
  tools?: unknown[];
  onToken?: (token: string) => void;
}

export interface LlmClient {
  chat(params: ChatParams): Promise<ChatResult>;
}

export class OpenAICompatibleClient implements LlmClient {
  constructor(
    private opts: { baseUrl: string; apiKey: string; model: string },
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async chat(params: ChatParams): Promise<ChatResult> {
    const res = await this.fetchImpl(`${this.opts.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.opts.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.opts.model,
        messages: params.messages,
        tools: params.tools,
        stream: true,
        temperature: 0.3,
      }),
    });
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      throw new Error(`LLM request failed: HTTP ${res.status} ${body.slice(0, 300)}`);
    }
    return readSseStream(res.body, params.onToken);
  }
}

/**
 * Parse the SSE stream: accumulate text deltas and tool-call deltas.
 * Tool calls arrive fragmented across chunks (id first, then name, then
 * arguments in pieces), keyed by `index`.
 */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onToken?: (token: string) => void,
): Promise<ChatResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const toolCalls: ToolCall[] = [];

  const handleData = (data: string) => {
    if (data === '[DONE]') return;
    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      return; // ignore non-JSON heartbeats/comments
    }
    const delta = json.choices?.[0]?.delta;
    if (!delta) return;
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      content += delta.content;
      onToken?.(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const i: number = tc.index ?? 0;
        if (!toolCalls[i]) toolCalls[i] = { id: '', name: '', arguments: '' };
        const slot = toolCalls[i]!;
        if (tc.id) slot.id += tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.arguments += tc.function.arguments;
      }
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of event.split('\n')) {
        if (line.startsWith('data:')) handleData(line.slice(5).trim());
      }
    }
  }
  return { content, toolCalls: toolCalls.filter(Boolean) };
}
