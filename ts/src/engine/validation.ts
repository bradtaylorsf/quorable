/**
 * Structured output validation with retry recovery, ported from
 * validation.py: fence-strip → sanitize → zod-validate → one retry with the
 * validation error appended so the model can self-correct. A third repair
 * attempt is allowed for weak openai-compatible/local models (plan M1).
 * Returns null after exhaustion — the pipeline skips the review rather than
 * crashing.
 */

import type { z } from "zod";

import type { ModelClient } from "../providers/registry.js";
import { ProviderError } from "../providers/types.js";
import type { ChatMessage } from "../providers/types.js";
import { sanitizeControlChars, stripFences } from "./sanitize.js";

/**
 * Why a validatedCall returned null: "provider" means the API/network call
 * itself failed after retries (the model never answered — worth re-queueing);
 * "validation" means the model answered but never produced schema-valid JSON.
 */
export type CallFailureKind = "provider" | "validation";

export interface ValidatedCallOptions {
  temperature?: number;
  persona?: string;
  /** Attempts including the first (2 = parent behavior; 3 for local models). */
  maxAttempts?: number;
  onWarning?: (message: string) => void;
  /** Called exactly once, with the failure kind, when null is returned. */
  onFailure?: (kind: CallFailureKind, message: string) => void;
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

function parseAndValidate<T>(
  content: string,
  schema: z.ZodType<T>,
): { ok: true; value: T } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (exc) {
    return { ok: false, error: `Invalid JSON: ${exc instanceof Error ? exc.message : exc}` };
  }
  const result = schema.safeParse(parsed);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, error: formatZodError(result.error) };
}

const RETRY_INSTRUCTION = (errorMsg: string): string =>
  `Your previous response failed validation against the required schema. ` +
  `Error:\n${errorMsg}\n\n` +
  `Common issues: (1) Every object in every list MUST include all of its ` +
  `required fields. (2) String values must use proper JSON escaping — use ` +
  `\\n for newlines, not raw line breaks. Please fix the JSON and respond ` +
  `again with a valid object matching the schema. Return ONLY the corrected ` +
  `JSON, no markdown fences.`;

/**
 * Call a model and validate the response against a zod schema, with
 * error-feedback retries. Returns null (never throws) on exhaustion or
 * provider failure.
 */
export async function validatedCall<T>(
  client: ModelClient,
  messages: ChatMessage[],
  schema: z.ZodType<T>,
  opts: ValidatedCallOptions = {},
): Promise<T | null> {
  const temperature = opts.temperature ?? 0.2;
  const defaultAttempts = client.ref.provider === "openai_compatible" ? 3 : 2;
  const maxAttempts = opts.maxAttempts ?? defaultAttempts;
  const warn = opts.onWarning ?? (() => {});
  const label = opts.persona
    ? `model=${client.ref.raw} persona=${opts.persona}`
    : `model=${client.ref.raw}`;

  let conversation = messages;
  let lastError = "";
  let lastContent = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let raw: string;
    try {
      const response = await client.chat(conversation, { temperature, jsonMode: true });
      raw = response.content;
    } catch (exc) {
      if (exc instanceof ProviderError) {
        warn(`API call failed (attempt ${attempt}) | ${label} | ${exc.message}`);
        opts.onFailure?.("provider", exc.message);
        return null;
      }
      throw exc;
    }

    const content = sanitizeControlChars(stripFences(raw));
    lastContent = content;

    if (!content) {
      lastError = "Model returned empty content (zero tokens)";
      warn(`Empty response from model | ${label} | will retry`);
    } else {
      const result = parseAndValidate(content, schema);
      if (result.ok) return result.value;
      lastError = result.error;
      warn(`Validation failed (attempt ${attempt}) | ${label} | ${lastError}`);
    }

    // Append the failed exchange + correction request for the next attempt.
    conversation = [
      ...conversation,
      { role: "assistant", content: lastContent },
      { role: "user", content: RETRY_INSTRUCTION(lastError) },
    ];
  }

  warn(`Validation failed after ${maxAttempts} attempts (skipping) | ${label} | ${lastError}`);
  opts.onFailure?.("validation", lastError);
  return null;
}
