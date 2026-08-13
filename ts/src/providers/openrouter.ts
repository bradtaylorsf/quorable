/**
 * OpenRouter provider — the direct port of the parent's client.py.
 * Cost comes from the response's usage.cost field (OpenRouter reports real
 * dollars); json mode uses response_format: json_object.
 */

import { getPricing, tokenCost } from "../engine/costs.js";
import { postJson, type HttpCallConfig } from "./http.js";
import {
  ProviderError,
  type ChatMessage,
  type ChatOptions,
  type NormalizedResponse,
  type Provider,
} from "./types.js";

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

interface OpenRouterBody {
  choices?: { message?: { content?: string } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
  };
  cost?: number;
}

export class OpenRouterProvider implements Provider {
  readonly kind = "openrouter" as const;

  constructor(
    private readonly apiKey: string,
    private readonly cfg: HttpCallConfig,
    private readonly baseUrl: string = OPENROUTER_BASE,
  ) {
    if (!apiKey) {
      throw new ProviderError(
        "OPENROUTER_API_KEY not set. Run `quorable keys set openrouter` or export it.",
      );
    }
  }

  async chat(
    model: string,
    messages: ChatMessage[],
    opts: ChatOptions,
  ): Promise<NormalizedResponse> {
    const payload: Record<string, unknown> = {
      model,
      messages,
      temperature: opts.temperature,
    };
    if (opts.jsonMode) {
      payload["response_format"] = { type: "json_object" };
    }
    if (opts.maxTokens !== undefined) {
      payload["max_tokens"] = opts.maxTokens;
    }

    const body = (await postJson(
      `${this.baseUrl}/chat/completions`,
      { Authorization: `Bearer ${this.apiKey}` },
      payload,
      this.cfg,
    )) as OpenRouterBody;

    const content = body.choices?.[0]?.message?.content;
    if (content === undefined || content === null) {
      throw new ProviderError("Unexpected response structure: missing content");
    }
    const usage = body.usage ?? {};
    const promptTokens = usage.prompt_tokens ?? 0;
    const completionTokens = usage.completion_tokens ?? 0;
    let costUsd = 0;
    if (typeof usage.cost === "number") costUsd = usage.cost;
    else if (typeof body.cost === "number") costUsd = body.cost;
    else {
      // Defensive: OpenRouter always reports cost, but price from the table
      // rather than silently under-counting if it ever doesn't.
      const [inPrice, outPrice] = getPricing(model);
      costUsd = tokenCost(promptTokens, inPrice) + tokenCost(completionTokens, outPrice);
    }

    return {
      content,
      promptTokens,
      completionTokens,
      totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
      costUsd,
    };
  }
}
