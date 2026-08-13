"""Live OpenRouter integration test — SKIPPED unless RUN_LIVE_TESTS=1.

Ported from the parent's gated live-test pattern: one real validated call
with the cheapest configured model against a tiny fixture script, exercising
client → prompts → validation end-to-end. Costs a fraction of a cent.
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest

RUN_LIVE = os.environ.get("RUN_LIVE_TESTS") == "1"
LIVE_MODEL = os.environ.get("QUORABLE_LIVE_MODEL", "x-ai/grok-4.1-fast")

pytestmark = pytest.mark.skipif(
    not RUN_LIVE,
    reason="Live test skipped (set RUN_LIVE_TESTS=1 and OPENROUTER_API_KEY to run)",
)

FIXTURES = Path(__file__).parent / "fixtures"


async def test_live_single_review_roundtrip(toy_pack):
    from quorable.engine.client import OpenRouterClient
    from quorable.engine.prompts import build_messages
    from quorable.engine.schemas import Document
    from quorable.engine.validation import validated_call

    script = (FIXTURES / "toy_pack" / "inputs" / "core" / "script_draft.md").read_text()
    doc = Document(
        name="script_draft", role="Script under review", tier=1,
        content=script, page_count=1, char_count=len(script),
        sha256="0" * 64,
    )
    messages = build_messages(
        system_prompt="You are a rigorous short-form script reviewer.",
        persona_overlay="Score each unit honestly on clarity and punch.",
        documents=[doc],
        schema=toy_pack.review_schema,
        canonical_units=toy_pack.canonical_units,
        unit_field=toy_pack.unit_field,
    )

    async with OpenRouterClient(max_concurrency=1) as client:
        review = await validated_call(
            client,
            model=LIVE_MODEL,
            messages=messages,
            schema=toy_pack.review_schema,
            temperature=0.2,
            persona="live_test",
        )

    assert review is not None
    units = getattr(review, toy_pack.unit_list_field)
    assert len(units) >= 1
    for unit in units:
        for dim in toy_pack.score_dimensions:
            assert 1 <= getattr(unit, dim) <= 5
