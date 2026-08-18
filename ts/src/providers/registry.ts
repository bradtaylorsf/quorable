/**
 * Provider registry: model spec → Provider instance, key resolution, and
 * the M1 capability check (fail with a menu of substitutes, not a stack
 * trace, when a configured model's provider has no connected key).
 */

import { readEnvVar } from "../config/home.js";
import type { EndpointConfig } from "../config/schema.js";
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
  type ModelResolution,
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
  /** Named endpoints from `providers.endpoints`, addressable as `<name>:<model>`. */
  endpoints?: Record<string, EndpointConfig> | undefined;
  /** Spec → declared vendor bucket, for agreement statistics. */
  vendors?: Record<string, string> | undefined;
  /** Quorable home, for reading endpoint keys out of its .env. */
  home?: string | undefined;
  timeoutSeconds: number;
  retryAttempts: number;
}

/** The endpoint-name + vendor context every spec parse needs. */
export function resolutionOf(settings: ProviderSettings): ModelResolution {
  return {
    endpoints: Object.keys(settings.endpoints ?? {}),
    vendors: settings.vendors ?? {},
  };
}

/**
 * A named endpoint's key: literal `api_key`, else `api_key_env` (process
 * env, then ~/.quorable/.env), else the shared openai_compatible key. Empty
 * is legitimate — local servers usually want no Authorization header.
 */
export function keyForEndpoint(
  endpoint: EndpointConfig,
  keys: ProviderKeys,
  home?: string,
): string {
  if (endpoint.api_key) return endpoint.api_key;
  if (endpoint.api_key_env) return readEnvVar(endpoint.api_key_env, home);
  return keys.openai_compatible ?? "";
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

export function createProvider(ref: ModelRef, settings: ProviderSettings): Provider {
  const cfg: HttpCallConfig = {
    timeoutSeconds: settings.timeoutSeconds,
    retryAttempts: settings.retryAttempts,
  };
  const kind = ref.provider;
  switch (kind) {
    case "openrouter":
      return new OpenRouterProvider(keyForProvider(kind, settings.keys), cfg);
    case "anthropic":
      return new AnthropicProvider(keyForProvider(kind, settings.keys), cfg);
    case "openai":
      return new OpenAIProvider(keyForProvider(kind, settings.keys), cfg);
    case "openai_compatible": {
      if (ref.endpoint) {
        const endpoint = settings.endpoints?.[ref.endpoint];
        if (!endpoint) {
          throw new ProviderError(
            `Model '${ref.raw}' names endpoint '${ref.endpoint}', which is not ` +
              `defined under providers.endpoints.`,
          );
        }
        return new OpenAIProvider(
          keyForEndpoint(endpoint, settings.keys, settings.home),
          cfg,
          endpoint.base_url,
          "openai_compatible",
          endpoint.json_mode,
        );
      }
      const base = settings.localBaseUrl ?? "http://localhost:11434/v1";
      return new OpenAIProvider(
        keyForProvider(kind, settings.keys),
        cfg,
        base,
        "openai_compatible",
        false,
      );
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
    this.ref = parseModelRef(spec, resolutionOf(settings));
    this.provider = createProvider(this.ref, settings);
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
  const resolution = resolutionOf(settings);
  const connected = (["openrouter", "anthropic", "openai"] as ProviderKind[]).filter(
    (kind) => keyForProvider(kind, settings.keys) !== "",
  );
  for (const spec of specs) {
    let ref: ModelRef;
    try {
      ref = parseModelRef(spec, resolution);
    } catch (exc) {
      problems.push(exc instanceof Error ? exc.message : String(exc));
      continue;
    }
    if (ref.provider === "openai_compatible") {
      // Local endpoints need no key — but one that DECLARES an api_key_env
      // has said it needs that var, so an empty value is a real problem.
      if (!ref.endpoint) continue;
      const endpoint = settings.endpoints?.[ref.endpoint];
      if (!endpoint) {
        problems.push(
          `Model '${spec}' names endpoint '${ref.endpoint}', which is not defined ` +
            `under providers.endpoints.`,
        );
        continue;
      }
      if (endpoint.api_key_env && !keyForEndpoint(endpoint, settings.keys, settings.home)) {
        problems.push(
          `Model '${spec}' uses endpoint '${ref.endpoint}', which needs ` +
            `${endpoint.api_key_env} and none is set. Export it or add it to ` +
            `~/.quorable/.env.`,
        );
      }
      continue;
    }
    const key = keyForProvider(ref.provider, settings.keys);
    if (!key) {
      const envVar = KEY_ENV_VARS[ref.provider];
      const localHint = Object.keys(settings.endpoints ?? {});
      const hint =
        connected.length > 0
          ? ` Connected providers: ${connected.join(", ")} — requalify the model ` +
            `(e.g. "${connected[0]}:<model-id>") or connect the key.`
          : localHint.length > 0
            ? ` No hosted providers are connected. Configured local endpoints: ` +
              `${localHint.join(", ")} — requalify the model (e.g. ` +
              `"${localHint[0]}:<model-id>") or run \`quorable keys set <provider>\`.`
            : " No providers are connected yet — run `quorable keys set <provider>`.";
      problems.push(
        `Model '${spec}' needs a ${ref.provider} key (${envVar}) and none is set.${hint}`,
      );
    }
  }
  return problems;
}
