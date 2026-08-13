/**
 * Shared HTTP plumbing for providers: retry policy (parity with the
 * parent's tenacity config — up to N attempts, exponential backoff 1..30s,
 * only on 429/500/503/timeout), request timeout, prompt hashing, and
 * CostTracker recording.
 */

import { createHash } from "node:crypto";

import pRetry, { AbortError } from "p-retry";

import type { CallRecord, CostTracker } from "../engine/costs.js";
import {
  isRetryableStatus,
  ProviderError,
  type ChatMessage,
  type NormalizedResponse,
} from "./types.js";

export function promptHash(messages: ChatMessage[]): string {
  const joined = messages.map((m) => m.content ?? "").join("");
  return createHash("sha256").update(joined, "utf-8").digest("hex");
}

export interface HttpCallConfig {
  timeoutSeconds: number;
  retryAttempts: number;
}

/**
 * POST JSON with retry + timeout. Throws ProviderError after exhaustion.
 * Failures upstream become result rows, never crashes.
 */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  payload: unknown,
  cfg: HttpCallConfig,
): Promise<unknown> {
  const attempt = async (): Promise<unknown> => {
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(cfg.timeoutSeconds * 1000),
      });
    } catch (exc) {
      // Timeouts and network errors are retryable.
      throw new ProviderError(
        `request failed: ${exc instanceof Error ? exc.message : exc}`,
      );
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      const error = new ProviderError(
        `HTTP ${resp.status}: ${body.slice(0, 500)}`,
        resp.status,
      );
      if (!isRetryableStatus(resp.status)) {
        throw new AbortError(error);
      }
      throw error;
    }
    return resp.json();
  };

  try {
    return await pRetry(attempt, {
      retries: Math.max(0, cfg.retryAttempts - 1),
      factor: 2,
      minTimeout: 1000,
      maxTimeout: 30_000,
      randomize: false,
    });
  } catch (exc) {
    if (exc instanceof AbortError) throw (exc as { originalError?: Error }).originalError ?? exc;
    if (exc instanceof ProviderError) throw exc;
    throw new ProviderError(exc instanceof Error ? exc.message : String(exc));
  }
}

/** Record one normalized call into a tracker (when provided). */
export function recordCall(
  tracker: CostTracker | null,
  model: string,
  messages: ChatMessage[],
  latencySeconds: number,
  response: NormalizedResponse,
): void {
  if (!tracker) return;
  const record: CallRecord = {
    model,
    promptHash: promptHash(messages),
    latencySeconds: Math.round(latencySeconds * 1000) / 1000,
    promptTokens: response.promptTokens,
    completionTokens: response.completionTokens,
    totalTokens: response.totalTokens,
    costUsd: response.costUsd,
  };
  tracker.record(record);
}
