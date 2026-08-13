/**
 * Structured-output text repair helpers, ported from validation.py:
 * fence stripping and control-character sanitization applied to every model
 * response before JSON parsing. Parity-pinned by
 * fixtures/parity/validation_text_cases.json.
 */

const FENCE_RE = /^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/;

const CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

const CONTROL_CHAR_MAP: Record<string, string> = {
  "\x00": "", // null — drop
  "\x08": "", // backspace — drop
  "\x0b": "\\n", // vertical tab → newline
  "\x0c": "\\n", // form feed → newline
  "\x0e": "", // shift out — drop
  "\x0f": "", // shift in — drop
};

/** Replace illegal JSON control characters that thinking models emit. */
export function sanitizeControlChars(text: string | null | undefined): string {
  if (!text) return "";
  return text.replace(CONTROL_CHAR_RE, (ch) => {
    const mapped = CONTROL_CHAR_MAP[ch];
    if (mapped !== undefined) return mapped;
    return `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

/** Strip markdown code fences wrapping JSON, if present. */
export function stripFences(text: string | null | undefined): string {
  if (!text) return "";
  const stripped = text.trim();
  const m = FENCE_RE.exec(stripped);
  if (m) return m[1]!.trim();
  return stripped;
}
