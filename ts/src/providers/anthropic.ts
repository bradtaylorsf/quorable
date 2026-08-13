/**
 * Anthropic direct provider (/v1/messages).
 *
 * Anthropic has no response_format parameter; JSON mode leans on the schema
 * instruction in the prompt plus validatedCall's fence-strip/repair safety
 * net. Cost is computed from the local pricing table (Anthropic reports
 * tokens, not dollars) — model ids are looked up as "anthropic/<model>" so
 * one table serves OpenRouter and direct calls.
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

export const ANTHROPIC_BASE = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 16_000;

interface AnthropicBody {
  content?: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class AnthropicProvider implements Provider {
  readonly kind = "anthropic" as const;

  constructor(
    private readonly apiKey: string,
    private readonly cfg: HttpCallConfig,
    private readonly baseUrl: string = ANTHROPIC_BASE,
  ) {
    if (!apiKey) {
      throw new ProviderError(
        "ANTHROPIC_API_KEY not set. Run `quorable keys set anthropic` or export it.",
      );
    }
  }

  async chat(
    model: string,
    messages: ChatMessage[],
    opts: ChatOptions,
  ): Promise<NormalizedResponse> {
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const conversation = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));

    const payload: Record<string, unknown> = {
      model,
      messages: conversation,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    };
    if (system) payload["system"] = system;

    const body = (await postJson(
      `${this.baseUrl}/v1/messages`,
      { "x-api-key": this.apiKey, "anthropic-version": ANTHROPIC_VERSION },
      payload,
      this.cfg,
    )) as AnthropicBody;

    const content = (body.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
    if (!body.content) {
      throw new ProviderError("Unexpected response structure: missing content");
    }

    const promptTokens = body.usage?.input_tokens ?? 0;
    const completionTokens = body.usage?.output_tokens ?? 0;
    const [inPrice, outPrice] = getPricing(`anthropic/${model}`);
    return {
      content,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      costUsd: tokenCost(promptTokens, inPrice) + tokenCost(completionTokens, outPrice),
    };
  }
}
