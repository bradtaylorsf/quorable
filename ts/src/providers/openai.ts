/**
 * OpenAI direct provider (/v1/chat/completions) and the openai-compatible
 * variant (base-URL override — covers Ollama, LM Studio, vLLM, Together,
 * Groq). Cost: OpenAI is priced from the table via "openai/<model>";
 * openai-compatible endpoints price at zero unless the table knows them
 * (local models are free by definition).
 */

import { getPricing, MODEL_PRICING, tokenCost } from "../engine/costs.js";
import { postJson, type HttpCallConfig } from "./http.js";
import {
  ProviderError,
  type ChatMessage,
  type ChatOptions,
  type NormalizedResponse,
  type Provider,
  type ProviderKind,
} from "./types.js";

export const OPENAI_BASE = "https://api.openai.com/v1";

interface OpenAIBody {
  choices?: { message?: { content?: string } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export class OpenAIProvider implements Provider {
  readonly kind: ProviderKind;

  constructor(
    private readonly apiKey: string,
    private readonly cfg: HttpCallConfig,
    private readonly baseUrl: string = OPENAI_BASE,
    kind: ProviderKind = "openai",
    private readonly jsonModeSupported = true,
  ) {
    this.kind = kind;
    if (!apiKey && kind === "openai") {
      throw new ProviderError(
        "OPENAI_API_KEY not set. Run `quorable keys set openai` or export it.",
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
    // Weak local models often reject response_format; the schema instruction
    // + validatedCall repair loop is the safety net there.
    if (opts.jsonMode && this.jsonModeSupported) {
      payload["response_format"] = { type: "json_object" };
    }
    if (opts.maxTokens !== undefined) payload["max_tokens"] = opts.maxTokens;

    const headers: Record<string, string> = {};
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    const body = (await postJson(
      `${this.baseUrl}/chat/completions`,
      headers,
      payload,
      this.cfg,
    )) as OpenAIBody;

    const content = body.choices?.[0]?.message?.content;
    if (content === undefined || content === null) {
      throw new ProviderError("Unexpected response structure: missing content");
    }
    const promptTokens = body.usage?.prompt_tokens ?? 0;
    const completionTokens = body.usage?.completion_tokens ?? 0;

    let costUsd = 0;
    if (this.kind === "openai") {
      const [inPrice, outPrice] = getPricing(`openai/${model}`);
      costUsd = tokenCost(promptTokens, inPrice) + tokenCost(completionTokens, outPrice);
    } else {
      // openai_compatible: local models are free; honor the table if the
      // exact id happens to be priced (e.g. Together/Groq-hosted ids).
      const priced = MODEL_PRICING[model];
      if (priced) {
        costUsd = tokenCost(promptTokens, priced[0]) + tokenCost(completionTokens, priced[1]);
      }
    }

    return {
      content,
      promptTokens,
      completionTokens,
      totalTokens: body.usage?.total_tokens ?? promptTokens + completionTokens,
      costUsd,
    };
  }
}
