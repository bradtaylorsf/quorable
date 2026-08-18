/**
 * validatedCall behavior (ports the intent of Python test_validation.py):
 * happy path, fence-stripping, retry-with-error-feedback, empty-content
 * retry, exhaustion → null, provider failure → null, and the local-model
 * third attempt.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { validatedCall } from "../src/engine/validation.js";
import { ProviderError, type ChatMessage } from "../src/providers/types.js";
import type { ModelClient } from "../src/providers/registry.js";

const Schema = z.object({
  verdict: z.enum(["good", "bad"]),
  score: z.number().int().min(1).max(5),
});

/** Structural stand-in for ModelClient: scripted responses per call. */
function fakeClient(
  responses: (string | Error)[],
  provider = "openrouter",
): ModelClient & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  let i = 0;
  return {
    ref: { provider, model: "fake", raw: `${provider}:fake` },
    calls,
    async chat(messages: ChatMessage[]) {
      calls.push(messages);
      const next = responses[Math.min(i, responses.length - 1)]!;
      i += 1;
      if (next instanceof Error) throw next;
      return {
        content: next,
        promptTokens: 10,
        completionTokens: 10,
        totalTokens: 20,
        costUsd: 0.001,
      };
    },
  } as unknown as ModelClient & { calls: ChatMessage[][] };
}

describe("validatedCall", () => {
  it("valid JSON on first attempt", async () => {
    const client = fakeClient(['{"verdict": "good", "score": 4}']);
    const result = await validatedCall(client, [], Schema);
    expect(result).toEqual({ verdict: "good", score: 4 });
    expect(client.calls).toHaveLength(1);
  });

  it("strips markdown fences", async () => {
    const client = fakeClient(['```json\n{"verdict": "bad", "score": 1}\n```']);
    const result = await validatedCall(client, [], Schema);
    expect(result).toEqual({ verdict: "bad", score: 1 });
  });

  it("sanitizes control characters inside strings", async () => {
    const client = fakeClient(['{"verdict": "good", "score": 2}\x00']);
    const result = await validatedCall(client, [], Schema);
    expect(result).toEqual({ verdict: "good", score: 2 });
  });

  it("retries once with the validation error appended", async () => {
    const client = fakeClient([
      '{"verdict": "excellent", "score": 4}',
      '{"verdict": "good", "score": 4}',
    ]);
    const result = await validatedCall(client, [{ role: "user", content: "q" }], Schema);
    expect(result).toEqual({ verdict: "good", score: 4 });
    expect(client.calls).toHaveLength(2);
    // The retry conversation carries the failed response + correction request.
    const retryMessages = client.calls[1]!;
    expect(retryMessages.some((m) => m.role === "assistant")).toBe(true);
    expect(retryMessages[retryMessages.length - 1]!.content).toContain("failed validation");
  });

  it("empty content triggers a retry, not a crash", async () => {
    const client = fakeClient(["", '{"verdict": "good", "score": 3}']);
    const result = await validatedCall(client, [], Schema);
    expect(result).toEqual({ verdict: "good", score: 3 });
  });

  it("returns null after exhausting attempts", async () => {
    const client = fakeClient(["not json", "still not json"]);
    const result = await validatedCall(client, [], Schema);
    expect(result).toBeNull();
    expect(client.calls).toHaveLength(2);
  });

  it("returns null on provider failure (failures become result rows upstream)", async () => {
    const client = fakeClient([new ProviderError("boom")]);
    const result = await validatedCall(client, [], Schema);
    expect(result).toBeNull();
  });

  it("local models get a third repair attempt", async () => {
    const client = fakeClient(
      ["garbage", "more garbage", '{"verdict": "good", "score": 5}'],
      "openai_compatible",
    );
    const result = await validatedCall(client, [], Schema);
    expect(result).toEqual({ verdict: "good", score: 5 });
    expect(client.calls).toHaveLength(3);
  });

  it("non-provider errors propagate (programming bugs must not be swallowed)", async () => {
    const client = fakeClient([new TypeError("bug")]);
    await expect(validatedCall(client, [], Schema)).rejects.toThrow(TypeError);
  });

  it("reports WHY it returned null: provider vs validation (issue #5)", async () => {
    const kinds: string[] = [];
    const onFailure = (kind: string): void => {
      kinds.push(kind);
    };

    await validatedCall(fakeClient([new ProviderError("fetch failed")]), [], Schema, {
      onFailure,
    });
    expect(kinds).toEqual(["provider"]);

    kinds.length = 0;
    await validatedCall(fakeClient(["not json", "still not json"]), [], Schema, {
      onFailure,
    });
    expect(kinds).toEqual(["validation"]);

    // Success reports nothing.
    kinds.length = 0;
    await validatedCall(fakeClient(['{"verdict": "good", "score": 4}']), [], Schema, {
      onFailure,
    });
    expect(kinds).toEqual([]);
  });
});
