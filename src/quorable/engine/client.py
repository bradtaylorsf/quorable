"""Async OpenRouter client with retry, logging, and cost tracking (§4)."""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any

import httpx
from tenacity import (
    AsyncRetrying,
    RetryError,
    retry_if_exception,
    stop_after_attempt,
    wait_exponential,
)

logger = logging.getLogger(__name__)

OPENROUTER_BASE = "https://openrouter.ai/api/v1"


class OpenRouterError(Exception):
    """Raised when an OpenRouter call fails after all retries."""


@dataclass
class CallRecord:
    """Metadata logged for every OpenRouter call."""

    model: str
    prompt_hash: str
    latency_seconds: float
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    cost_usd: float


@dataclass
class CostTracker:
    """Accumulates cost across an entire pipeline run."""

    total_usd: float = 0.0
    records: list[CallRecord] = field(default_factory=list)

    def record(self, call: CallRecord) -> None:
        self.total_usd += call.cost_usd
        self.records.append(call)


def _prompt_hash(messages: list[dict[str, str]]) -> str:
    """SHA-256 of concatenated message contents for reproducibility logging."""
    joined = "".join(m.get("content") or "" for m in messages)
    return hashlib.sha256(joined.encode()).hexdigest()


def _is_retryable(exc: BaseException) -> bool:
    """Only retry on 429, 500, 503, or timeouts."""
    if isinstance(exc, httpx.TimeoutException):
        return True
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code in (429, 500, 503)
    return False


class OpenRouterClient:
    """Async client for OpenRouter chat completions.

    All LLM inference in the pipeline flows through this single client.
    Handles authentication, retries, concurrency limiting, and cost tracking.
    """

    def __init__(
        self,
        *,
        api_key: str | None = None,
        max_concurrency: int = 5,
        timeout_seconds: int = 300,
        retry_attempts: int = 3,
        cost_tracker: CostTracker | None = None,
    ) -> None:
        resolved_key = api_key or os.environ.get("OPENROUTER_API_KEY")
        if not resolved_key:
            raise OpenRouterError(
                "OPENROUTER_API_KEY not set. Pass api_key or set the environment variable."
            )
        self._api_key = resolved_key
        self._timeout = timeout_seconds
        self._retry_attempts = retry_attempts
        self._semaphore = asyncio.Semaphore(max_concurrency)
        self.cost_tracker = cost_tracker or CostTracker()
        self._http: httpx.AsyncClient | None = None

    async def __aenter__(self) -> OpenRouterClient:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.close()

    async def _get_http(self) -> httpx.AsyncClient:
        if self._http is None or self._http.is_closed:
            self._http = httpx.AsyncClient(
                base_url=OPENROUTER_BASE,
                headers={
                    "Authorization": f"Bearer {self._api_key}",
                    "Content-Type": "application/json",
                },
                timeout=httpx.Timeout(self._timeout, connect=30),
            )
        return self._http

    async def close(self) -> None:
        if self._http is not None and not self._http.is_closed:
            await self._http.aclose()

    async def chat(
        self,
        *,
        model: str,
        messages: list[dict[str, Any]],
        temperature: float = 0.2,
        json_mode: bool = True,
        tools: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Send a chat completion request to OpenRouter.

        Returns the parsed JSON response body. Retries on transient errors.
        Raises OpenRouterError after retry exhaustion.
        """
        phash = _prompt_hash(messages)
        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
        }
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
        if tools:
            payload["tools"] = tools

        async with self._semaphore:
            start = time.monotonic()
            try:
                async for attempt in AsyncRetrying(
                    stop=stop_after_attempt(self._retry_attempts),
                    wait=wait_exponential(multiplier=1, min=1, max=30),
                    retry=retry_if_exception(_is_retryable),
                ):
                    with attempt:
                        http = await self._get_http()
                        resp = await http.post("/chat/completions", json=payload)
                        resp.raise_for_status()
            except RetryError as exc:
                latency = time.monotonic() - start
                logger.error(
                    "OpenRouter call failed after %d attempts | model=%s prompt_hash=%s latency=%.1fs",
                    self._retry_attempts, model, phash, latency,
                )
                raise OpenRouterError(
                    f"All {self._retry_attempts} retries exhausted for {model}"
                ) from exc
            except (httpx.HTTPStatusError, httpx.TimeoutException, httpx.HTTPError) as exc:
                latency = time.monotonic() - start
                logger.error(
                    "OpenRouter call failed (non-retryable) | model=%s prompt_hash=%s latency=%.1fs error=%s",
                    model, phash, latency, exc,
                )
                raise OpenRouterError(str(exc)) from exc

        latency = time.monotonic() - start
        body = resp.json()

        # Extract usage and cost from response
        usage = body.get("usage", {})
        prompt_tokens = usage.get("prompt_tokens", 0)
        completion_tokens = usage.get("completion_tokens", 0)
        total_tokens = usage.get("total_tokens", 0)

        # OpenRouter nests cost inside the usage object
        cost = 0.0
        if "cost" in usage:
            cost = float(usage["cost"])
        elif "cost" in body:
            cost = float(body["cost"])

        record = CallRecord(
            model=model,
            prompt_hash=phash,
            latency_seconds=round(latency, 3),
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=total_tokens,
            cost_usd=cost,
        )
        self.cost_tracker.record(record)

        logger.info(
            "OpenRouter call completed | model=%s prompt_hash=%s "
            "tokens=%d/%d/%d latency=%.1fs cost=$%.4f",
            model, phash,
            prompt_tokens, completion_tokens, total_tokens,
            latency, cost,
        )

        return body

    def get_content(self, response: dict[str, Any]) -> str:
        """Extract the assistant message content from an OpenRouter response."""
        try:
            return response["choices"][0]["message"]["content"]
        except (KeyError, IndexError) as exc:
            raise OpenRouterError("Unexpected response structure: missing content") from exc
