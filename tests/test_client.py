"""Tests for async OpenRouter client (Issue #7)."""
from __future__ import annotations

import json

import httpx
import pytest
import respx

from quorable.engine.client import (
    CallRecord,
    CostTracker,
    OpenRouterClient,
    OpenRouterError,
    _prompt_hash,
)

COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions"

# A minimal valid OpenRouter response
def _make_response(
    content: str = '{"ok": true}',
    cost: float = 0.005,
    prompt_tokens: int = 100,
    completion_tokens: int = 50,
) -> dict:
    return {
        "choices": [{"message": {"content": content}}],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
            "cost": cost,
        },
    }


MESSAGES = [{"role": "user", "content": "Hello"}]


# ---------------------------------------------------------------------------
# Prompt hash
# ---------------------------------------------------------------------------

def test_prompt_hash_deterministic():
    h1 = _prompt_hash(MESSAGES)
    h2 = _prompt_hash(MESSAGES)
    assert h1 == h2
    assert len(h1) == 64  # SHA-256 hex


def test_prompt_hash_changes_with_content():
    h1 = _prompt_hash([{"role": "user", "content": "a"}])
    h2 = _prompt_hash([{"role": "user", "content": "b"}])
    assert h1 != h2


# ---------------------------------------------------------------------------
# CostTracker
# ---------------------------------------------------------------------------

def test_cost_tracker_accumulates():
    tracker = CostTracker()
    r1 = CallRecord("m1", "h1", 1.0, 10, 5, 15, 0.01)
    r2 = CallRecord("m2", "h2", 2.0, 20, 10, 30, 0.02)
    tracker.record(r1)
    tracker.record(r2)
    assert tracker.total_usd == pytest.approx(0.03)
    assert len(tracker.records) == 2


# ---------------------------------------------------------------------------
# Client — missing API key
# ---------------------------------------------------------------------------

def test_missing_api_key_raises(monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    with pytest.raises(OpenRouterError, match="OPENROUTER_API_KEY"):
        OpenRouterClient()


# ---------------------------------------------------------------------------
# Client — successful call
# ---------------------------------------------------------------------------

@respx.mock
@pytest.mark.asyncio
async def test_chat_success():
    route = respx.post(COMPLETIONS_URL).mock(
        return_value=httpx.Response(200, json=_make_response())
    )

    client = OpenRouterClient(api_key="test-key", retry_attempts=3)
    try:
        result = await client.chat(
            model="test/model",
            messages=MESSAGES,
            temperature=0.2,
        )
    finally:
        await client.close()

    assert route.called
    assert result["choices"][0]["message"]["content"] == '{"ok": true}'
    assert client.cost_tracker.total_usd == pytest.approx(0.005)
    assert len(client.cost_tracker.records) == 1

    rec = client.cost_tracker.records[0]
    assert rec.model == "test/model"
    assert rec.prompt_tokens == 100
    assert rec.completion_tokens == 50


# ---------------------------------------------------------------------------
# Client — retry on 429
# ---------------------------------------------------------------------------

@respx.mock
@pytest.mark.asyncio
async def test_chat_retry_on_429():
    route = respx.post(COMPLETIONS_URL).mock(
        side_effect=[
            httpx.Response(429, text="rate limited"),
            httpx.Response(200, json=_make_response()),
        ]
    )

    client = OpenRouterClient(api_key="test-key", retry_attempts=3)
    try:
        result = await client.chat(model="test/model", messages=MESSAGES)
    finally:
        await client.close()

    assert route.call_count == 2
    assert "choices" in result


# ---------------------------------------------------------------------------
# Client — retry exhaustion
# ---------------------------------------------------------------------------

@respx.mock
@pytest.mark.asyncio
async def test_chat_retry_exhaustion():
    respx.post(COMPLETIONS_URL).mock(
        return_value=httpx.Response(429, text="rate limited")
    )

    client = OpenRouterClient(api_key="test-key", retry_attempts=3)
    try:
        with pytest.raises(OpenRouterError, match="retries exhausted"):
            await client.chat(model="test/model", messages=MESSAGES)
    finally:
        await client.close()


# ---------------------------------------------------------------------------
# Client — non-retryable error (e.g. 401)
# ---------------------------------------------------------------------------

@respx.mock
@pytest.mark.asyncio
async def test_chat_non_retryable_error():
    respx.post(COMPLETIONS_URL).mock(
        return_value=httpx.Response(401, text="unauthorized")
    )

    client = OpenRouterClient(api_key="test-key", retry_attempts=3)
    try:
        with pytest.raises(OpenRouterError):
            await client.chat(model="test/model", messages=MESSAGES)
    finally:
        await client.close()


# ---------------------------------------------------------------------------
# Client — timeout
# ---------------------------------------------------------------------------

@respx.mock
@pytest.mark.asyncio
async def test_chat_timeout():
    respx.post(COMPLETIONS_URL).mock(side_effect=httpx.ReadTimeout("timed out"))

    client = OpenRouterClient(api_key="test-key", retry_attempts=2)
    try:
        with pytest.raises(OpenRouterError):
            await client.chat(model="test/model", messages=MESSAGES)
    finally:
        await client.close()


# ---------------------------------------------------------------------------
# Client — cost from header fallback
# ---------------------------------------------------------------------------

@respx.mock
@pytest.mark.asyncio
async def test_chat_cost_from_usage():
    """OpenRouter nests cost inside the usage object."""
    body = _make_response(cost=0.0123)
    route = respx.post(COMPLETIONS_URL).mock(
        return_value=httpx.Response(200, json=body)
    )

    client = OpenRouterClient(api_key="test-key")
    try:
        await client.chat(model="test/model", messages=MESSAGES)
    finally:
        await client.close()

    assert client.cost_tracker.records[0].cost_usd == pytest.approx(0.0123)


# ---------------------------------------------------------------------------
# get_content
# ---------------------------------------------------------------------------

def test_get_content_success():
    client = OpenRouterClient(api_key="test-key")
    resp = _make_response(content="hello world")
    assert client.get_content(resp) == "hello world"


def test_get_content_bad_structure():
    client = OpenRouterClient(api_key="test-key")
    with pytest.raises(OpenRouterError, match="missing content"):
        client.get_content({"bad": "structure"})


# ---------------------------------------------------------------------------
# Client — async context manager
# ---------------------------------------------------------------------------

@respx.mock
@pytest.mark.asyncio
async def test_async_context_manager():
    respx.post(COMPLETIONS_URL).mock(
        return_value=httpx.Response(200, json=_make_response())
    )

    async with OpenRouterClient(api_key="test-key") as client:
        result = await client.chat(model="test/model", messages=MESSAGES)
        assert "choices" in result

    # Client should be closed after exiting context
    assert client._http is None or client._http.is_closed


# ---------------------------------------------------------------------------
# Client — connection error wrapped as OpenRouterError
# ---------------------------------------------------------------------------

@respx.mock
@pytest.mark.asyncio
async def test_chat_connection_error():
    respx.post(COMPLETIONS_URL).mock(side_effect=httpx.ConnectError("connection refused"))

    async with OpenRouterClient(api_key="test-key", retry_attempts=1) as client:
        with pytest.raises(OpenRouterError):
            await client.chat(model="test/model", messages=MESSAGES)
