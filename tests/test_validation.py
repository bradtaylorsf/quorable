"""Tests for structured output validation with retry (Issue #8)."""
from __future__ import annotations

import json

import httpx
import pytest
import respx
from pydantic import BaseModel, Field

from quorable.engine.client import OpenRouterClient
from quorable.engine.validation import _sanitize_control_chars, validated_call

COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions"


# A simple schema for testing
class SimpleReview(BaseModel):
    score: int = Field(ge=1, le=5)
    comment: str


def _openrouter_response(content: str, cost: float = 0.001) -> dict:
    return {
        "choices": [{"message": {"content": content}}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        "cost": cost,
    }


MESSAGES = [{"role": "user", "content": "Review this"}]


# ---------------------------------------------------------------------------
# Valid response on first try
# ---------------------------------------------------------------------------

@respx.mock
@pytest.mark.asyncio
async def test_valid_response_first_try():
    valid = json.dumps({"score": 4, "comment": "looks good"})
    respx.post(COMPLETIONS_URL).mock(
        return_value=httpx.Response(200, json=_openrouter_response(valid))
    )

    client = OpenRouterClient(api_key="test-key")
    try:
        result = await validated_call(
            client,
            model="test/model",
            messages=MESSAGES,
            schema=SimpleReview,
            persona="textualist",
        )
    finally:
        await client.close()

    assert result is not None
    assert result.score == 4
    assert result.comment == "looks good"


# ---------------------------------------------------------------------------
# First-try validation failure, retry succeeds
# ---------------------------------------------------------------------------

@respx.mock
@pytest.mark.asyncio
async def test_validation_failure_then_retry_success():
    # First response: invalid (score out of range)
    invalid = json.dumps({"score": 99, "comment": "bad"})
    # Second response: valid
    valid = json.dumps({"score": 3, "comment": "fixed"})

    respx.post(COMPLETIONS_URL).mock(
        side_effect=[
            httpx.Response(200, json=_openrouter_response(invalid)),
            httpx.Response(200, json=_openrouter_response(valid)),
        ]
    )

    client = OpenRouterClient(api_key="test-key")
    try:
        result = await validated_call(
            client,
            model="test/model",
            messages=MESSAGES,
            schema=SimpleReview,
            persona="textualist",
        )
    finally:
        await client.close()

    assert result is not None
    assert result.score == 3
    assert result.comment == "fixed"


# ---------------------------------------------------------------------------
# Double validation failure — returns None
# ---------------------------------------------------------------------------

@respx.mock
@pytest.mark.asyncio
async def test_double_validation_failure_returns_none():
    invalid1 = json.dumps({"score": 99, "comment": "bad"})
    invalid2 = json.dumps({"score": -1, "comment": "still bad"})

    respx.post(COMPLETIONS_URL).mock(
        side_effect=[
            httpx.Response(200, json=_openrouter_response(invalid1)),
            httpx.Response(200, json=_openrouter_response(invalid2)),
        ]
    )

    client = OpenRouterClient(api_key="test-key")
    try:
        result = await validated_call(
            client,
            model="test/model",
            messages=MESSAGES,
            schema=SimpleReview,
            persona="textualist",
        )
    finally:
        await client.close()

    assert result is None


# ---------------------------------------------------------------------------
# Invalid JSON on first try, valid on retry
# ---------------------------------------------------------------------------

@respx.mock
@pytest.mark.asyncio
async def test_invalid_json_then_valid_retry():
    not_json = "This is not JSON at all"
    valid = json.dumps({"score": 5, "comment": "now it works"})

    respx.post(COMPLETIONS_URL).mock(
        side_effect=[
            httpx.Response(200, json=_openrouter_response(not_json)),
            httpx.Response(200, json=_openrouter_response(valid)),
        ]
    )

    client = OpenRouterClient(api_key="test-key")
    try:
        result = await validated_call(
            client,
            model="test/model",
            messages=MESSAGES,
            schema=SimpleReview,
        )
    finally:
        await client.close()

    assert result is not None
    assert result.score == 5


# ---------------------------------------------------------------------------
# API failure on first call — returns None without retry
# ---------------------------------------------------------------------------

@respx.mock
@pytest.mark.asyncio
async def test_api_failure_returns_none():
    # Non-retryable 401 error
    respx.post(COMPLETIONS_URL).mock(
        return_value=httpx.Response(401, text="unauthorized")
    )

    client = OpenRouterClient(api_key="test-key", retry_attempts=1)
    try:
        result = await validated_call(
            client,
            model="test/model",
            messages=MESSAGES,
            schema=SimpleReview,
            persona="textualist",
        )
    finally:
        await client.close()

    assert result is None


# ---------------------------------------------------------------------------
# Missing field on first try, valid on retry
# ---------------------------------------------------------------------------

@respx.mock
@pytest.mark.asyncio
async def test_missing_field_then_valid_retry():
    # Missing 'comment' field
    missing_field = json.dumps({"score": 3})
    valid = json.dumps({"score": 3, "comment": "added comment"})

    respx.post(COMPLETIONS_URL).mock(
        side_effect=[
            httpx.Response(200, json=_openrouter_response(missing_field)),
            httpx.Response(200, json=_openrouter_response(valid)),
        ]
    )

    client = OpenRouterClient(api_key="test-key")
    try:
        result = await validated_call(
            client,
            model="test/model",
            messages=MESSAGES,
            schema=SimpleReview,
        )
    finally:
        await client.close()

    assert result is not None
    assert result.comment == "added comment"


# ---------------------------------------------------------------------------
# Control character sanitization (kimi-k2-thinking fix)
# ---------------------------------------------------------------------------

def test_sanitize_control_chars_removes_nulls():
    assert _sanitize_control_chars('{"a": "b\x00c"}') == '{"a": "bc"}'


def test_sanitize_control_chars_escapes_low_range():
    # \x01 should become \u0001
    assert _sanitize_control_chars('{"a": "b\x01c"}') == '{"a": "b\\u0001c"}'


def test_sanitize_control_chars_preserves_valid_json():
    """Normal JSON with \\n and \\t escapes (already valid) is untouched."""
    valid = '{"a": "line1\\nline2\\ttab"}'
    assert _sanitize_control_chars(valid) == valid


def test_sanitize_control_chars_form_feed_to_newline():
    assert _sanitize_control_chars('{"a": "b\x0cc"}') == '{"a": "b\\nc"}'


@respx.mock
@pytest.mark.asyncio
async def test_control_chars_in_response_are_cleaned():
    """Simulate a thinking model emitting raw control chars in JSON values."""
    # Raw \x0c (form feed) inside a JSON string — json.loads would reject this
    raw_with_ctrl = '{"score": 3, "comment": "good\x0cstuff"}'
    valid_retry = json.dumps({"score": 3, "comment": "good stuff"})

    respx.post(COMPLETIONS_URL).mock(
        side_effect=[
            httpx.Response(200, json=_openrouter_response(raw_with_ctrl)),
        ]
    )

    client = OpenRouterClient(api_key="test-key")
    try:
        result = await validated_call(
            client,
            model="test/model",
            messages=MESSAGES,
            schema=SimpleReview,
            persona="test",
        )
    finally:
        await client.close()

    # Should succeed on first attempt after sanitization (no retry needed)
    assert result is not None
    assert result.score == 3
