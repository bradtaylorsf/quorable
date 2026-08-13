"""Tests for the cost estimation module (ported from the parent's test_costs)."""
from __future__ import annotations

from pathlib import Path

import pytest
import respx
from httpx import Response

from quorable.engine import costs as costs_module
from quorable.engine.config import (
    Config,
    ModelsConfig,
    PathsConfig,
    PipelineConfig,
    ReviewerModelConfig,
    SingleModelConfig,
)
from quorable.engine.costs import (
    OPENROUTER_MODELS_URL,
    CostEstimate,
    ModelEstimate,
    _get_pricing,
    _token_cost,
    estimate_pipeline_cost,
    format_cost_estimate,
    refresh_live_pricing,
)
from quorable.engine.manifest import ManifestEntry
from quorable.engine.schemas import Document


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def _make_config(
    *,
    cost_threshold: float = 20.0,
    cost_abort_multiplier: float = 2.0,
    runs_per_persona: int = 1,
    personas: list[str] | None = None,
    drafter: SingleModelConfig | None = None,
) -> Config:
    return Config(
        models=ModelsConfig(
            reviewers=[
                ReviewerModelConfig(id="google/gemini-2.5-pro", temperature=0.2),
            ],
            synthesizer=SingleModelConfig(id="anthropic/claude-sonnet-4", temperature=0.1),
            held_out=SingleModelConfig(id="deepseek/deepseek-r1", temperature=0.2),
            drafter=drafter,
        ),
        pipeline=PipelineConfig(
            runs_per_persona=runs_per_persona,
            cost_threshold=cost_threshold,
            cost_abort_multiplier=cost_abort_multiplier,
        ),
        personas=personas or ["praiser"],
        paths=PathsConfig(),
    )


def _make_entry(name: str, tier: int = 1) -> ManifestEntry:
    return ManifestEntry(
        name=name,
        path=Path(f"/fake/{name}.md"),
        tier=tier,
        send_to=["stage1", "stage2"],
    )


def _make_doc(name: str, char_count: int = 10000) -> Document:
    content = "x" * char_count
    return Document(
        name=name,
        role="test",
        tier=1,
        content=content,
        page_count=1,
        char_count=char_count,
        sha256="abc123",
    )


# ---------------------------------------------------------------------------
# Unit tests
# ---------------------------------------------------------------------------


class TestTokenCost:
    def test_zero_tokens(self) -> None:
        assert _token_cost(0, 10.0) == 0.0

    def test_one_million_tokens(self) -> None:
        assert _token_cost(1_000_000, 10.0) == 10.0

    def test_fractional(self) -> None:
        cost = _token_cost(500_000, 10.0)
        assert cost == pytest.approx(5.0)


class TestGetPricing:
    def test_known_model(self) -> None:
        inp, out = _get_pricing("anthropic/claude-opus-4")
        assert inp == 15.0
        assert out == 75.0

    def test_unknown_model_returns_default(self) -> None:
        inp, out = _get_pricing("unknown/model")
        assert inp == 1.0
        assert out == 5.0


class TestModelEstimate:
    def test_total_cost(self) -> None:
        est = ModelEstimate(
            model_id="test",
            num_calls=1,
            input_tokens_per_call=1000,
            output_tokens_per_call=1000,
            input_cost_usd=1.5,
            output_cost_usd=2.5,
        )
        assert est.total_cost_usd == 4.0


class TestCostEstimate:
    def test_empty_total(self) -> None:
        est = CostEstimate()
        assert est.total_usd == 0.0

    def test_aggregates_models(self) -> None:
        est = CostEstimate(model_estimates=[
            ModelEstimate("a", 1, 100, 100, 1.0, 2.0),
            ModelEstimate("b", 1, 100, 100, 3.0, 4.0),
        ])
        assert est.total_usd == 10.0

    def test_per_loop_multiplier(self) -> None:
        est = CostEstimate(
            model_estimates=[ModelEstimate("a", 1, 100, 100, 1.0, 2.0)],
            iterations=3,
        )
        assert est.per_loop_usd == pytest.approx(9.0)


class TestEstimatePipelineCost:
    def test_returns_estimates_for_reviewer_and_synthesizer(self) -> None:
        config = _make_config()
        entries = [_make_entry("script_draft")]
        documents = {"script_draft": _make_doc("script_draft")}

        est = estimate_pipeline_cost(
            config=config,
            entries=entries,
            documents=documents,
            system_prompt_chars=5000,
            persona_overlay_chars={"praiser": 2000},
        )

        # Should have 1 reviewer + 1 synthesizer = 2 model estimates
        assert len(est.model_estimates) == 2
        assert est.model_estimates[0].model_id == "google/gemini-2.5-pro"
        assert est.model_estimates[1].model_id == "anthropic/claude-sonnet-4"
        assert est.total_usd > 0

    def test_more_runs_increases_cost(self) -> None:
        entries = [_make_entry("script_draft")]
        documents = {"script_draft": _make_doc("script_draft")}
        overlay_chars = {"praiser": 2000}

        est1 = estimate_pipeline_cost(
            config=_make_config(runs_per_persona=1),
            entries=entries,
            documents=documents,
            system_prompt_chars=5000,
            persona_overlay_chars=overlay_chars,
        )
        est2 = estimate_pipeline_cost(
            config=_make_config(runs_per_persona=3),
            entries=entries,
            documents=documents,
            system_prompt_chars=5000,
            persona_overlay_chars=overlay_chars,
        )

        assert est2.total_usd > est1.total_usd

    def test_reviewer_call_count_matches_personas_times_runs(self) -> None:
        config = _make_config(
            runs_per_persona=2,
            personas=["praiser", "critic"],
        )
        entries = [_make_entry("script_draft")]
        documents = {"script_draft": _make_doc("script_draft")}

        est = estimate_pipeline_cost(
            config=config,
            entries=entries,
            documents=documents,
            system_prompt_chars=5000,
            persona_overlay_chars={"praiser": 2000, "critic": 2000},
        )

        reviewer_est = est.model_estimates[0]
        assert reviewer_est.num_calls == 4  # 2 personas × 2 runs

    def test_drafter_line_item_when_included(self) -> None:
        config = _make_config(
            drafter=SingleModelConfig(id="anthropic/claude-sonnet-4", temperature=0.7),
        )
        entries = [_make_entry("script_draft")]
        documents = {"script_draft": _make_doc("script_draft")}

        est = estimate_pipeline_cost(
            config=config,
            entries=entries,
            documents=documents,
            system_prompt_chars=5000,
            persona_overlay_chars={"praiser": 2000},
            include_drafter=True,
            iterations=3,
        )

        # reviewer + synthesizer + drafter
        assert len(est.model_estimates) == 3
        assert est.iterations == 3
        assert est.per_loop_usd == pytest.approx(est.total_usd * 3)

    def test_no_drafter_line_item_without_drafter_model(self) -> None:
        config = _make_config(drafter=None)
        est = estimate_pipeline_cost(
            config=config,
            entries=[_make_entry("script_draft")],
            documents={"script_draft": _make_doc("script_draft")},
            system_prompt_chars=5000,
            persona_overlay_chars={"praiser": 2000},
            include_drafter=True,
        )
        assert len(est.model_estimates) == 2


class TestFormatCostEstimate:
    def test_includes_model_names(self) -> None:
        est = CostEstimate(model_estimates=[
            ModelEstimate("test/model", 2, 5000, 3000, 0.5, 0.3),
        ])
        config = _make_config()
        output = format_cost_estimate(est, config)
        assert "test/model" in output
        assert "Cost Estimate" in output

    def test_shows_threshold_warning_when_exceeded(self) -> None:
        est = CostEstimate(model_estimates=[
            ModelEstimate("expensive/model", 1, 1000, 1000, 25.0, 10.0),
        ])
        config = _make_config(cost_threshold=20.0)
        output = format_cost_estimate(est, config)
        assert "confirmation required" in output

    def test_no_warning_under_threshold(self) -> None:
        est = CostEstimate(model_estimates=[
            ModelEstimate("cheap/model", 1, 1000, 1000, 0.01, 0.01),
        ])
        config = _make_config(cost_threshold=20.0)
        output = format_cost_estimate(est, config)
        assert "confirmation required" not in output


# ---------------------------------------------------------------------------
# Live pricing (refresh_live_pricing) — network mocked, never hit for real
# ---------------------------------------------------------------------------


class TestLivePricing:
    def setup_method(self):
        costs_module._LIVE_PRICING.clear()

    def teardown_method(self):
        costs_module._LIVE_PRICING.clear()

    @respx.mock
    def test_live_pricing_overrides_static_table(self):
        respx.get(OPENROUTER_MODELS_URL).mock(
            return_value=Response(200, json={"data": [
                {"id": "x-ai/grok-4.3",
                 "pricing": {"prompt": "0.00000125", "completion": "0.0000025"}},
                {"id": "some/other-model",
                 "pricing": {"prompt": "0.001", "completion": "0.002"}},
            ]})
        )
        ok = refresh_live_pricing(["x-ai/grok-4.3"])
        assert ok is True
        assert costs_module._get_pricing("x-ai/grok-4.3") == (1.25, 2.50)
        # Unrequested models are not cached
        assert "some/other-model" not in costs_module._LIVE_PRICING

    @respx.mock
    def test_fetch_failure_falls_back_to_static_table(self):
        respx.get(OPENROUTER_MODELS_URL).mock(return_value=Response(500))
        ok = refresh_live_pricing(["x-ai/grok-4.1-fast"])
        assert ok is False
        # Static table still answers
        assert costs_module._get_pricing("x-ai/grok-4.1-fast") == (0.20, 0.50)

    @respx.mock
    def test_missing_model_uses_default_with_no_crash(self):
        respx.get(OPENROUTER_MODELS_URL).mock(
            return_value=Response(200, json={"data": []})
        )
        ok = refresh_live_pricing(["nonexistent/model"])
        assert ok is True
        assert costs_module._get_pricing("nonexistent/model") == costs_module.DEFAULT_PRICING

    @respx.mock
    def test_unparseable_pricing_skipped(self):
        respx.get(OPENROUTER_MODELS_URL).mock(
            return_value=Response(200, json={"data": [
                {"id": "weird/model", "pricing": {"prompt": None}},
            ]})
        )
        ok = refresh_live_pricing(["weird/model"])
        assert ok is True
        assert "weird/model" not in costs_module._LIVE_PRICING
