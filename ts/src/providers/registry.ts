/**
 * Provider registry: model spec → Provider instance, key resolution, and
 * the M1 capability check (fail with a menu of substitutes, not a stack
 * trace, when a configured model's provider has no connected key).
 */

import type { CostTracker } from "../engine/costs.js";
import { recordCall, type HttpCallConfig } from "./http.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { OpenRouterProvider } from "./openrouter.js";
import {
  parseModelRef,
  ProviderError,
  type ChatMessage,
  type ChatOptions,
  type ModelRef,
  type NormalizedResponse,
  type Provider,
  type ProviderKind,
} from "./types.js";

export interface ProviderKeys {
  openrouter?: string | undefined;
  anthropic?: string | undefined;
  openai?: string | undefined;
  /** openai-compatible endpoints may need a key (Together/Groq) or none (Ollama). */
  openai_compatible?: string | undefined;
}

export interface ProviderSettings {
  keys: ProviderKeys;
  /** Base URL for openai_compatible / local models (e.g. http://localhost:11434/v1). */
  localBaseUrl?: string | undefined;
  timeoutSeconds: number;
  retryAttempts: number;
}

export const KEY_ENV_VARS: Record<ProviderKind, string | null> = {
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openai_compatible: null, // key optional
};

export function keyForProvider(kind: ProviderKind, keys: ProviderKeys): string {
  const envVar = KEY_ENV_VARS[kind];
  // Process env always wins over stored keys (plan §6.2 decision).
  if (envVar && process.env[envVar]) return process.env[envVar]!;
  return keys[kind] ?? "";
}

export function createProvider(kind: ProviderKind, settings: ProviderSettings): Provider {
  const cfg: HttpCallConfig = {
    timeoutSeconds: settings.timeoutSeconds,
    retryAttempts: settings.retryAttempts,
  };
  const key = keyForProvider(kind, settings.keys);
  switch (kind) {
    case "openrouter":
      return new OpenRouterProvider(key, cfg);
    case "anthropic":
      return new AnthropicProvider(key, cfg);
    case "openai":
      return new OpenAIProvider(key, cfg);
    case "openai_compatible": {
      const base = settings.localBaseUrl ?? "http://localhost:11434/v1";
      return new OpenAIProvider(key, cfg, base, "openai_compatible", false);
    }
  }
}

/**
 * A model client bound to a spec string: parses the ref, owns the provider,
 * and records every call into the shared CostTracker (the cost governor's
 * source of truth).
 */
export class ModelClient {
  readonly ref: ModelRef;
  private readonly provider: Provider;

  constructor(
    spec: string,
    private readonly settings: ProviderSettings,
    private readonly tracker: CostTracker | null = null,
  ) {
    this.ref = parseModelRef(spec);
    this.provider = createProvider(this.ref.provider, settings);
  }

  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<NormalizedResponse> {
    const start = performance.now();
    const response = await this.provider.chat(this.ref.model, messages, opts);
    recordCall(this.tracker, this.ref.raw, messages, (performance.now() - start) / 1000, response);
    return response;
  }
}

/**
 * M1 capability check: verify every configured model's provider has a
 * usable key. Returns human-actionable problems (with substitution hints
 * from connected providers) instead of letting the run die mid-flight.
 */
export function checkModelAvailability(
  specs: string[],
  settings: ProviderSettings,
): string[] {
  const problems: string[] = [];
  const connected = (["openrouter", "anthropic", "openai"] as ProviderKind[]).filter(
    (kind) => keyForProvider(kind, settings.keys) !== "",
  );
  for (const spec of specs) {
    const ref = parseModelRef(spec);
    if (ref.provider === "openai_compatible") continue; // key optional
    const key = keyForProvider(ref.provider, settings.keys);
    if (!key) {
      const envVar = KEY_ENV_VARS[ref.provider];
      const hint =
        connected.length > 0
          ? ` Connected providers: ${connected.join(", ")} — requalify the model ` +
            `(e.g. "${connected[0]}:<model-id>") or connect the key.`
          : " No providers are connected yet — run `quorable keys set <provider>`.";
      problems.push(
        `Model '${spec}' needs a ${ref.provider} key (${envVar}) and none is set.${hint}`,
      );
    }
  }
  return problems;
}
