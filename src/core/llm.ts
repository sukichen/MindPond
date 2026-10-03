/**
 * Minimal LLM interface for agent-memory.
 *
 * Extracted from rpbot's llm-client.ts — only the surface the memory
 * pipeline actually uses: chat(messages, options) -> {choices[...]}.
 *
 * HARD RULE (user mandate 2026-09-03): maxTokens defaults to 131072 (128k).
 * Thinking models (glm-5.3-flash etc.) burn reasoning into the same budget;
 * small budgets yield empty content ("thinking burnout"). Never lower it.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  /** Default 131072 — HARD RULE, do not configure smaller. */
  maxTokens?: number;
  maxThinkingTokens?: number;
}

export interface ChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
      reasoning_content?: string;
    };
    finish_reason?: string;
  }>;
}

export const DEFAULT_MAX_TOKENS = 131072;

export interface LLMClient {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>;
}

/**
 * OpenAI-compatible client (works with ARK /v3, vLLM, OpenAI, etc.).
 * Env: LLM_BASE_URL (default ARK plan endpoint), LLM_API_KEY, LLM_MODEL.
 */
export class OpenAICompatClient implements LLMClient {
  private baseUrl: string;
  private apiKey: string;
  private model: string;

  constructor(opts?: { baseUrl?: string; apiKey?: string; model?: string }) {
    this.baseUrl = (opts?.baseUrl ?? process.env.LLM_BASE_URL ?? 'https://ark.cn-beijing.volces.com/api/plan/v3').replace(/\/$/, '');
    this.apiKey = opts?.apiKey ?? process.env.LLM_API_KEY ?? '';
    this.model = opts?.model ?? process.env.LLM_MODEL ?? 'glm-5.3-flash';
    if (!this.apiKey) {
      throw new Error('LLM_API_KEY not set (env or constructor)');
    }
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResponse> {
    const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: options.temperature ?? 0.3,
      max_tokens: maxTokens,
    };
    if (options.maxThinkingTokens !== undefined) {
      body.thinking = { type: 'enabled', budget_tokens: options.maxThinkingTokens };
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM chat failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    }
    return (await res.json()) as ChatResponse;
  }
}

/** Lazy singleton — created on first use so importing modules never throws.
 *  Server can start without LLM key (search/save/expand don't need LLM;
 *  extract/weave will throw a clear error when actually invoked). */
let cachedClient: LLMClient | null = null;

export function getLLMClient(): LLMClient {
  if (!cachedClient) {
    cachedClient = new OpenAICompatClient();
  }
  return cachedClient;
}
