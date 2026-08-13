"""Structured output validation with one-retry recovery (§4, Issue #8).

Wraps OpenRouter calls with pydantic validation. On first validation failure,
re-calls the model with the error appended to the prompt. On second failure,
logs and returns None rather than crashing the pipeline.
"""
from __future__ import annotations

import json
import logging
import re
from typing import TypeVar

from pydantic import BaseModel, ValidationError

from quorable.engine.client import OpenRouterClient, OpenRouterError

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)

_FENCE_RE = re.compile(r"^```(?:json)?\s*\n?(.*?)\n?\s*```$", re.DOTALL)

# Matches control characters that are illegal in JSON strings (U+0000–U+001F)
# except those already escaped. We replace them with their proper JSON escapes.
_CONTROL_CHAR_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")

_CONTROL_CHAR_MAP: dict[str, str] = {
    "\x00": "",      # null — drop
    "\x08": "",      # backspace — drop
    "\x0b": "\\n",   # vertical tab → newline
    "\x0c": "\\n",   # form feed → newline
    "\x0e": "",      # shift out — drop
    "\x0f": "",      # shift in — drop
}


def _sanitize_control_chars(text: str | None) -> str:
    """Replace illegal JSON control characters that thinking models emit.

    Models like kimi-k2-thinking sometimes output raw newlines, tabs, or
    other control chars (U+0000–U+001F) inside JSON string values, which
    causes json.loads() to fail with "Invalid control character". This
    replaces them with their escaped equivalents or drops them.

    Returns empty string if input is None/empty (defensive — the caller
    is responsible for treating empty content as a validation failure).
    """
    if not text:
        return ""

    def _replace(m: re.Match[str]) -> str:
        ch = m.group(0)
        if ch in _CONTROL_CHAR_MAP:
            return _CONTROL_CHAR_MAP[ch]
        # For anything else in the range, use the Unicode escape
        return f"\\u{ord(ch):04x}"
    return _CONTROL_CHAR_RE.sub(_replace, text)


def _strip_fences(text: str | None) -> str:
    """Strip markdown code fences wrapping JSON, if present.

    Returns an empty string if input is None or empty. This protects
    callers from AttributeError when an upstream model returns no content
    (e.g., empty/zero-token response). The empty string will fail JSON
    parsing downstream, which is the correct signal — we treat it as a
    validation failure rather than a crash.
    """
    if not text:
        return ""
    stripped = text.strip()
    m = _FENCE_RE.match(stripped)
    if m:
        return m.group(1).strip()
    return stripped


async def validated_call(
    client: OpenRouterClient,
    *,
    model: str,
    messages: list[dict[str, str]],
    schema: type[T],
    temperature: float = 0.2,
    persona: str = "",
) -> T | None:
    """Call a model and validate the response against a pydantic schema.

    On validation failure, retries once with the validation error appended
    to the conversation so the model can self-correct. Returns None if the
    second attempt also fails validation (the pipeline should skip this
    review rather than crash).
    """
    context_label = f"model={model} persona={persona}" if persona else f"model={model}"

    # --- First attempt ---
    try:
        raw_response = await client.chat(
            model=model,
            messages=messages,
            temperature=temperature,
            json_mode=True,
        )
    except OpenRouterError:
        logger.error("API call failed on first attempt | %s", context_label)
        return None

    content = _strip_fences(client.get_content(raw_response))
    content = _sanitize_control_chars(content)

    if not content:
        logger.warning(
            "Empty response from model | %s | will retry once",
            context_label,
        )
        error_msg = "Model returned empty content (zero tokens)"
    else:
        try:
            parsed = json.loads(content)
            return schema.model_validate(parsed)
        except (json.JSONDecodeError, ValidationError) as first_error:
            error_msg = str(first_error)
            logger.warning(
                "Validation failed on first attempt | %s | error=%s",
                context_label, error_msg,
            )

    # --- Retry with error feedback ---
    logger.warning(
        "Retrying with error feedback (doubles token cost for this call) | %s",
        context_label,
    )
    retry_messages = messages + [
        {"role": "assistant", "content": content},
        {
            "role": "user",
            "content": (
                f"Your previous response failed validation against the required schema. "
                f"Error:\n{error_msg}\n\n"
                f"Common issues: (1) Every object in every list MUST include "
                f"all of its required fields. (2) String values must "
                f"use proper JSON escaping — use \\n for newlines, not raw line breaks. "
                f"Please fix the JSON and respond again with a valid object matching "
                f"the schema. Return ONLY the corrected JSON, no markdown fences."
            ),
        },
    ]

    try:
        retry_response = await client.chat(
            model=model,
            messages=retry_messages,
            temperature=temperature,
            json_mode=True,
        )
    except OpenRouterError:
        logger.error("API call failed on validation retry | %s", context_label)
        return None

    retry_content = _strip_fences(client.get_content(retry_response))
    retry_content = _sanitize_control_chars(retry_content)

    try:
        parsed = json.loads(retry_content)
        result = schema.model_validate(parsed)
        logger.info("Validation succeeded on retry | %s", context_label)
        return result
    except (json.JSONDecodeError, ValidationError) as second_error:
        logger.error(
            "Validation failed on retry (skipping) | %s | "
            "first_error=%s | second_error=%s | raw_response=%s",
            context_label, error_msg, second_error, retry_content[:500],
        )
        return None
