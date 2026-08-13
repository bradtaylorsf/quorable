"""Extract parity fixtures from the Python engine.

Generates JSON fixtures under fixtures/parity/ that pin the Python engine's
numeric behavior: agreement statistics (Fleiss' kappa, ICC), composite +
ship-gate evaluation, mechanical gates, priority-score recompute, unit-name
normalization, SequenceMatcher ratios (regression fuzzy matching), fence
stripping / control-char sanitization, and cost estimation.

The TS engine must reproduce every expected value on these inputs to 6
decimal places (Python rounds most stats to 4dp, so exact match is the bar).

Inputs are language-neutral JSON; this script converts them to the object
shapes the engine expects (SimpleNamespace stand-ins for pydantic models).
NaN is serialized as the string "NaN" (JSON has no NaN).

Run: uv run python tools/extract_parity_fixtures.py
Deterministic: a fixed-seed LCG generates the bulk cases; re-running must
produce byte-identical fixtures (tests/test_parity_fixtures.py enforces it).
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "src"))

from quorable.engine.agreement import (  # noqa: E402
    compute_agreement,
    fleiss_kappa,
    icc_oneway,
    normalize_unit_name,
)
from quorable.engine.gates import (  # noqa: E402
    banned_elements_gate,
    term_lint_gate,
    word_count_gate,
)
from quorable.engine.loop import check_ship_gates, compute_scores  # noqa: E402
from quorable.engine.validation import (  # noqa: E402
    _sanitize_control_chars,
    _strip_fences,
)

OUT_DIR = REPO / "fixtures" / "parity"


# ---------------------------------------------------------------------------
# Deterministic PRNG (LCG — identical results on every platform/run)
# ---------------------------------------------------------------------------

class LCG:
    def __init__(self, seed: int = 20260812) -> None:
        self.state = seed

    def next(self) -> int:
        self.state = (self.state * 1103515245 + 12345) % (2**31)
        return self.state

    def randint(self, lo: int, hi: int) -> int:
        return lo + self.next() % (hi - lo + 1)

    def choice(self, items: list) -> Any:
        return items[self.next() % len(items)]


# ---------------------------------------------------------------------------
# JSON <-> engine-object plumbing
# ---------------------------------------------------------------------------

def to_ns(obj: Any) -> Any:
    """Recursively convert JSON data to SimpleNamespace (getattr-compatible)."""
    if isinstance(obj, dict):
        return SimpleNamespace(**{k: to_ns(v) for k, v in obj.items()})
    if isinstance(obj, list):
        return [to_ns(v) for v in obj]
    return obj


def make_pack(pack_json: dict) -> SimpleNamespace:
    """Build a pack stand-in from fixture JSON (agreement/scoring surface)."""
    ship = pack_json.get("ship_gates") or {}
    blocking = None
    if ship.get("blocking") == "severity_1_findings":
        def blocking(synthesis: Any, reviews: list[Any]) -> list[str]:
            out = [
                f.description
                for r in reviews
                for f in (getattr(r, "findings", None) or [])
                if getattr(f, "severity", None) == 1
            ]
            if synthesis is not None:
                out.extend(
                    w.description
                    for w in (getattr(synthesis, "consensus_weaknesses", None) or [])
                    if getattr(w, "severity", None) == "critical"
                )
            return out
    return SimpleNamespace(
        score_dimensions=pack_json["score_dimensions"],
        verdict_field=pack_json["verdict_field"],
        verdict_categories=pack_json["verdict_categories"],
        unit_field=pack_json["unit_field"],
        unit_list_field=pack_json.get("unit_list_field", "unit_reviews"),
        unit_score_field=pack_json.get("unit_score_field"),
        unit_keyword_rules=[tuple(r) for r in pack_json.get("unit_keyword_rules", [])],
        ship_gates=SimpleNamespace(
            composite_min=ship.get("composite_min", 0.0),
            dimension_min=ship.get("dimension_min", 0.0),
            weights=ship.get("weights"),
            composite_exclude_personas=ship.get("composite_exclude_personas", []),
            blocking_findings=blocking,
        ),
    )


def clean(obj: Any) -> Any:
    """Replace NaN floats with the string sentinel 'NaN' for JSON."""
    if isinstance(obj, float) and math.isnan(obj):
        return "NaN"
    if isinstance(obj, dict):
        return {k: clean(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [clean(v) for v in obj]
    return obj


def write_fixture(name: str, data: Any) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / name
    path.write_text(
        json.dumps(clean(data), indent=2, ensure_ascii=False, sort_keys=False) + "\n",
        encoding="utf-8",
    )
    print(f"wrote {path}")


# ---------------------------------------------------------------------------
# Case generation — attribute-style and unit-major review sets
# ---------------------------------------------------------------------------

PACK_ATTR = {
    "score_dimensions": ["clarity", "punch"],
    "verdict_field": "verdict",
    "verdict_categories": ["good", "mixed", "bad"],
    "unit_field": "unit",
    "unit_list_field": "unit_reviews",
    "unit_score_field": None,
    "unit_keyword_rules": [["cold open", "hook"], ["cta", "outro"]],
}

PACK_UM = {
    "score_dimensions": ["hook_strength", "pacing", "payoff"],
    "verdict_field": "predicted_shape",
    "verdict_categories": ["cliff", "hold", "hook_and_hold"],
    "unit_field": "dimension",
    "unit_list_field": "dimension_scores",
    "unit_score_field": "score",
    "unit_keyword_rules": [],
}

UNITS = ["hook", "body", "outro", "close"]
PERSONAS = ["praiser", "critic", "red_team"]
MODELS = ["a/m1", "b/m2", "c/m3"]


def gen_attr_reviews(rng: LCG, n_reviews: int, n_units: int) -> tuple[list, list]:
    reviews, personas = [], []
    for _ in range(n_reviews):
        persona = rng.choice(PERSONAS)
        units = []
        for u in UNITS[:n_units]:
            units.append({
                "unit": u,
                "clarity": rng.randint(1, 5),
                "punch": rng.randint(1, 5),
                "verdict": rng.choice(PACK_ATTR["verdict_categories"]),
            })
        reviews.append({
            "persona": persona,
            "model_id": rng.choice(MODELS),
            "unit_reviews": units,
            "verdict": rng.choice(PACK_ATTR["verdict_categories"]),
            "findings": [
                {"description": f"finding-{rng.randint(1, 99)}", "severity": rng.randint(1, 5)}
                for _ in range(rng.randint(0, 2))
            ],
        })
        personas.append(persona)
    return reviews, personas


def gen_um_reviews(rng: LCG, n_reviews: int) -> tuple[list, list]:
    reviews, personas = [], []
    for _ in range(n_reviews):
        persona = rng.choice(PERSONAS)
        scores = [
            {"dimension": d, "score": rng.randint(1, 10), "rationale": "r"}
            for d in PACK_UM["score_dimensions"]
        ]
        reviews.append({
            "persona": persona,
            "model_id": rng.choice(MODELS),
            "dimension_scores": scores,
            "predicted_shape": rng.choice(PACK_UM["verdict_categories"]),
            "findings": [],
        })
        personas.append(persona)
    return reviews, personas


def agreement_cases() -> list[dict]:
    rng = LCG(101)
    cases: list[dict] = []

    # Hand-written edge cases -------------------------------------------------
    def attr_review(verdict: str, units: list[dict], persona: str = "praiser") -> dict:
        return {
            "persona": persona, "model_id": "t/m",
            "unit_reviews": units, "verdict": verdict, "findings": [],
        }

    unit = lambda u, c, p, v: {"unit": u, "clarity": c, "punch": p, "verdict": v}  # noqa: E731

    cases.append({
        "name": "perfect_agreement_kappa_nan",
        "pack": PACK_ATTR,
        "reviews": [attr_review("good", [unit("hook", 3, 3, "good")]) for _ in range(4)],
        "personas": None,
    })
    cases.append({
        "name": "two_raters_disagree_review_level_fallback",
        "pack": PACK_ATTR,
        "reviews": [
            attr_review("bad", []),
            attr_review("good", []),
        ],
        "personas": None,
    })
    cases.append({
        "name": "empty_reviews",
        "pack": PACK_ATTR,
        "reviews": [],
        "personas": None,
    })
    cases.append({
        "name": "single_review",
        "pack": PACK_ATTR,
        "reviews": [attr_review("good", [unit("hook", 3, 3, "good")])],
        "personas": None,
    })
    cases.append({
        "name": "unknown_verdict_value_ignored",
        "pack": PACK_ATTR,
        "reviews": [
            attr_review("good", [unit("hook", 3, 2, "good"), unit("body", 1, 5, "weird")]),
            attr_review("bad", [unit("hook", 4, 2, "bad"), unit("body", 2, 4, "good")]),
            attr_review("mixed", [unit("hook", 2, 3, "good"), unit("body", 1, 4, "bad")]),
        ],
        "personas": None,
    })
    cases.append({
        "name": "free_text_unit_names_align_via_normalization",
        "pack": PACK_ATTR,
        "reviews": [
            attr_review("good", [unit("1. Hook (cold open)", 4, 3, "good"), unit("The Body", 2, 2, "bad")]),
            attr_review("good", [unit("HOOK", 5, 3, "good"), unit("body", 1, 3, "bad")]),
            attr_review("mixed", [unit("The Cold Open bit", 3, 4, "mixed"), unit("2) body", 2, 1, "bad")]),
        ],
        "personas": None,
    })
    cases.append({
        "name": "mixed_rater_counts_modal_k",
        "pack": PACK_ATTR,
        "reviews": [
            attr_review("good", [unit("hook", 4, 3, "good"), unit("body", 2, 2, "bad")]),
            attr_review("good", [unit("hook", 5, 4, "good"), unit("body", 1, 2, "bad")]),
            attr_review("mixed", [unit("hook", 3, 3, "mixed")]),
        ],
        "personas": None,
    })
    cases.append({
        "name": "per_persona_icc",
        "pack": PACK_ATTR,
        "reviews": [
            attr_review("good", [unit("hook", 5, 5, "good"), unit("body", 4, 4, "good")], "praiser"),
            attr_review("good", [unit("hook", 5, 4, "good"), unit("body", 4, 5, "good")], "praiser"),
            attr_review("bad", [unit("hook", 2, 1, "bad"), unit("body", 1, 2, "bad")], "critic"),
            attr_review("bad", [unit("hook", 1, 1, "bad"), unit("body", 2, 1, "bad")], "critic"),
        ],
        "personas": ["praiser", "praiser", "critic", "critic"],
    })
    cases.append({
        "name": "persona_length_mismatch_skips_per_persona",
        "pack": PACK_ATTR,
        "reviews": [attr_review("good", [unit("hook", 3, 3, "good")]) for _ in range(4)],
        "personas": ["praiser"],
    })

    # Unit-major hand case
    cases.append({
        "name": "unit_major_basic",
        "pack": PACK_UM,
        "reviews": [
            {
                "persona": "praiser", "model_id": "t/m",
                "dimension_scores": [
                    {"dimension": "hook_strength", "score": 8, "rationale": "r"},
                    {"dimension": "pacing", "score": 6, "rationale": "r"},
                    {"dimension": "payoff", "score": 7, "rationale": "r"},
                ],
                "predicted_shape": "hold", "findings": [],
            },
            {
                "persona": "critic", "model_id": "t/m2",
                "dimension_scores": [
                    {"dimension": "hook_strength", "score": 4, "rationale": "r"},
                    {"dimension": "pacing", "score": 5, "rationale": "r"},
                    {"dimension": "payoff", "score": 3, "rationale": "r"},
                ],
                "predicted_shape": "cliff", "findings": [],
            },
            {
                "persona": "praiser", "model_id": "t/m3",
                "dimension_scores": [
                    {"dimension": "hook_strength", "score": 7, "rationale": "r"},
                    {"dimension": "pacing", "score": 6, "rationale": "r"},
                    {"dimension": "payoff", "score": 8, "rationale": "r"},
                ],
                "predicted_shape": "hold", "findings": [],
            },
        ],
        "personas": ["praiser", "critic", "praiser"],
    })

    # Generated bulk cases ----------------------------------------------------
    for i in range(20):
        reviews, personas = gen_attr_reviews(
            rng, n_reviews=rng.randint(2, 8), n_units=rng.randint(1, 4),
        )
        cases.append({
            "name": f"gen_attr_{i}",
            "pack": PACK_ATTR,
            "reviews": reviews,
            "personas": personas if i % 2 == 0 else None,
        })
    for i in range(10):
        reviews, personas = gen_um_reviews(rng, n_reviews=rng.randint(2, 6))
        cases.append({
            "name": f"gen_um_{i}",
            "pack": PACK_UM,
            "reviews": reviews,
            "personas": personas if i % 2 == 0 else None,
        })

    # Compute expectations
    for case in cases:
        pack = make_pack(case["pack"])
        reviews = [to_ns(r) for r in case["reviews"]]
        case["expected"] = compute_agreement(reviews, pack, personas=case["personas"])
    return cases


def icc_cases() -> list[dict]:
    rng = LCG(202)
    cases = [
        {"name": "perfect", "scores": [[3.0, 3.0, 3.0], [4.0, 4.0, 4.0], [2.0, 2.0, 2.0]]},
        {"name": "no_agreement", "scores": [[1.0, 5.0, 3.0], [5.0, 1.0, 3.0], [3.0, 3.0, 3.0]]},
        {"name": "moderate", "scores": [[3.0, 4.0, 3.0], [2.0, 2.0, 3.0], [5.0, 5.0, 4.0]]},
        {"name": "empty", "scores": []},
        {"name": "single_subject", "scores": [[3.0, 4.0]]},
        {"name": "single_rater_per_subject", "scores": [[3.0], [4.0]]},
        {"name": "zero_denominator", "scores": [[3.0, 3.0], [3.0, 3.0]]},
        {"name": "mixed_k_modal_2", "scores": [[1.0, 2.0], [4.0, 5.0], [2.0, 3.0, 4.0]]},
        {"name": "mixed_k_modal_3", "scores": [[1.0, 2.0, 3.0], [4.0, 5.0, 3.0], [2.0, 3.0]]},
    ]
    for i in range(15):
        n_subj = rng.randint(2, 6)
        k = rng.randint(2, 4)
        scores = [
            [float(rng.randint(1, 10)) for _ in range(k)] for _ in range(n_subj)
        ]
        cases.append({"name": f"gen_{i}", "scores": scores})
    for case in cases:
        case["expected"] = icc_oneway(case["scores"])
    return cases


def kappa_cases() -> list[dict]:
    """Direct fleiss_kappa cases (attribute-style shape)."""
    rng = LCG(303)
    cases = []
    for i in range(12):
        reviews, _ = gen_attr_reviews(rng, n_reviews=rng.randint(2, 9), n_units=rng.randint(1, 4))
        cases.append({"name": f"gen_{i}", "pack": PACK_ATTR, "reviews": reviews})
    for case in cases:
        p = make_pack(case["pack"])
        case["expected"] = fleiss_kappa(
            [to_ns(r) for r in case["reviews"]],
            verdict_field=p.verdict_field,
            verdict_categories=p.verdict_categories,
            unit_field=p.unit_field,
            unit_list_field=p.unit_list_field,
            keyword_rules=p.unit_keyword_rules,
        )
    return cases


def normalize_cases() -> list[dict]:
    cases = [
        {"input": "1. Hook (cold open)", "rules": []},
        {"input": "1. Hook (cold open)", "rules": [["cold open", "hook"]]},
        {"input": "The Cold Open bit", "rules": [["cold open", "hook"], ["cta", "outro"]]},
        {"input": "CTA section", "rules": [["cold open", "hook"], ["cta", "outro"]]},
        {"input": "  BODY  ", "rules": []},
        {"input": "2) Second Act — the middle", "rules": []},
        {"input": "3.Payoff!!!", "rules": []},
        {"input": "Unit #4: The Close", "rules": []},
        {"input": "12. (misc) Trailing (extra) Parens", "rules": []},
        {"input": "MiXeD CaSe   spacing", "rules": []},
        {"input": "", "rules": []},
        {"input": "42", "rules": []},
    ]
    for case in cases:
        case["expected"] = normalize_unit_name(
            case["input"], [tuple(r) for r in case["rules"]],
        )
    return cases


def scoring_cases() -> list[dict]:
    rng = LCG(404)
    cases: list[dict] = []

    ship_variants = [
        {"composite_min": 3.0, "dimension_min": 2.0, "weights": None,
         "composite_exclude_personas": [], "blocking": None},
        {"composite_min": 3.5, "dimension_min": 2.5,
         "weights": {"clarity": 1.0, "punch": 2.0},
         "composite_exclude_personas": [], "blocking": None},
        {"composite_min": 3.0, "dimension_min": 2.0, "weights": None,
         "composite_exclude_personas": ["red_team"], "blocking": "severity_1_findings"},
        {"composite_min": 4.9, "dimension_min": 4.5, "weights": {"clarity": 1.5},
         "composite_exclude_personas": ["critic", "red_team"],
         "blocking": "severity_1_findings"},
    ]

    for i in range(16):
        reviews, personas = gen_attr_reviews(rng, n_reviews=rng.randint(2, 6), n_units=rng.randint(1, 3))
        ship = ship_variants[i % len(ship_variants)]
        pack_json = {**PACK_ATTR, "ship_gates": ship}
        synthesis = None
        if i % 3 == 0:
            synthesis = {
                "consensus_weaknesses": [
                    {"description": "canon drift in hook", "unit": "hook",
                     "severity": rng.choice(["critical", "major", "minor"]),
                     "reviewer_count": 2, "suggested_fix": "fix it"},
                ],
                "ranked_fixes": [],
            }
        gate_results = {
            "word_count": {"passed": i % 4 != 1, "findings": [] if i % 4 != 1 else ["document is 999 words (max 500)"]},
        }
        cases.append({
            "name": f"attr_{i}",
            "pack": pack_json,
            "reviews": reviews,
            "personas": personas,
            "synthesis": synthesis,
            "gate_results": gate_results,
        })

    # Unit-major scoring
    for i in range(6):
        reviews, personas = gen_um_reviews(rng, n_reviews=rng.randint(2, 5))
        pack_json = {
            **PACK_UM,
            "ship_gates": {"composite_min": 6.0, "dimension_min": 4.0, "weights": None,
                           "composite_exclude_personas": ["red_team"], "blocking": None},
        }
        cases.append({
            "name": f"um_{i}",
            "pack": pack_json,
            "reviews": reviews,
            "personas": personas,
            "synthesis": None,
            "gate_results": {},
        })

    # Edge: no reviews at all
    cases.append({
        "name": "no_reviews",
        "pack": {**PACK_ATTR, "ship_gates": ship_variants[0]},
        "reviews": [], "personas": [], "synthesis": None, "gate_results": {},
    })
    # Edge: all personas excluded
    reviews, _ = gen_attr_reviews(rng, 3, 2)
    cases.append({
        "name": "all_excluded",
        "pack": {**PACK_ATTR, "ship_gates": {
            "composite_min": 3.0, "dimension_min": 2.0, "weights": None,
            "composite_exclude_personas": PERSONAS, "blocking": None}},
        "reviews": reviews, "personas": [r["persona"] for r in reviews],
        "synthesis": None, "gate_results": {},
    })
    # Edge: weights name no present dimension -> composite None
    reviews, personas = gen_attr_reviews(rng, 3, 2)
    cases.append({
        "name": "zero_weight_total",
        "pack": {**PACK_ATTR, "ship_gates": {
            "composite_min": 3.0, "dimension_min": 2.0,
            "weights": {"nonexistent": 1.0},
            "composite_exclude_personas": [], "blocking": None}},
        "reviews": reviews, "personas": personas,
        "synthesis": None, "gate_results": {},
    })

    for case in cases:
        pack = make_pack(case["pack"])
        reviews_ns = [to_ns(r) for r in case["reviews"]]
        synthesis_ns = to_ns(case["synthesis"]) if case["synthesis"] else None
        gate_results = {
            name: SimpleNamespace(passed=g["passed"], findings=g["findings"])
            for name, g in case["gate_results"].items()
        }
        composite, per_dimension = compute_scores(
            reviews_ns, pack, personas=case["personas"] or None,
        )
        ok, reasons, composite2, dims2 = check_ship_gates(
            synthesis=synthesis_ns,
            reviews=reviews_ns,
            gate_results=gate_results,
            pack=pack,
            personas=case["personas"] or None,
        )
        case["expected"] = {
            "composite": composite,
            "per_dimension": per_dimension,
            "ship_ok": ok,
            "reasons": reasons,
        }
    return cases


def priority_cases() -> list[dict]:
    cases = []
    for impact in range(1, 6):
        for ease in range(1, 6):
            for consensus in (0.0, 0.25, 0.33, 0.5, 0.6666666666666666, 0.75, 1.0):
                cases.append({"impact": impact, "ease": ease, "consensus": consensus})
    for case in cases:
        case["expected"] = round(
            (case["impact"] ** 2) * case["consensus"] / (1 + case["ease"]), 4,
        )
    return cases


def gate_cases() -> list[dict]:
    doc_long = "word " * 120
    doc_sections = (
        "# Intro\n\nalpha beta gamma\n\n## Details\n\n" + "d " * 30 +
        "\n\n# Outro\n\nfinal words here\n"
    )
    doc_vo = "VO: one two three\nSHOT: wide angle\nVO: four five\nOVERLAY: title\n"
    cases = [
        {"gate": {"type": "word_count", "max_words": 100}, "text": doc_long},
        {"gate": {"type": "word_count", "max_words": 200}, "text": doc_long},
        {"gate": {"type": "word_count", "max_words": 2, "section": "Details"}, "text": doc_sections},
        {"gate": {"type": "word_count", "max_words": 50, "section": "Details"}, "text": doc_sections},
        {"gate": {"type": "word_count", "max_words": 50, "section": "Missing Section"}, "text": doc_sections},
        {"gate": {"type": "word_count", "max_words": 4, "line_prefix": "VO:"}, "text": doc_vo},
        {"gate": {"type": "word_count", "max_words": 10, "line_prefix": "VO:"}, "text": doc_vo},
        {"gate": {"type": "word_count", "max_words": 10, "line_prefix": "NARRATOR:"}, "text": doc_vo},
        {"gate": {"type": "term_lint", "canonical_terms": {"Quorable": ["quorable", "Qorable"], "GitHub": ["Github", "github"]}},
         "text": "We use quorable and Github daily. Quorable is canonical. Qorable appears too."},
        {"gate": {"type": "term_lint", "canonical_terms": {"Quorable": ["quorable"]}},
         "text": "Only Quorable here, spelled right."},
        {"gate": {"type": "term_lint", "canonical_terms": {"X": ["X"]}},
         "text": "alias equals canonical X — must not flag"},
        {"gate": {"type": "banned_elements", "patterns": ["as an AI", "in today's fast-paced"]},
         "text": "This reads as an AI wrote it. Also fine text."},
        {"gate": {"type": "banned_elements", "patterns": ["as an AI"]},
         "text": "Clean document, nothing banned."},
        {"gate": {"type": "banned_elements", "patterns": ["TODO", "\\bFIXME\\b"]},
         "text": "line one\nTODO finish this\nFIXME: later\n"},
    ]
    for case in cases:
        g = case["gate"]
        if g["type"] == "word_count":
            gate = word_count_gate(
                g["max_words"], section=g.get("section"), line_prefix=g.get("line_prefix"),
            )
        elif g["type"] == "term_lint":
            gate = term_lint_gate(g["canonical_terms"])
        else:
            gate = banned_elements_gate(g["patterns"])
        result = gate.run(case["text"], None)
        case["expected"] = {
            "name": gate.name, "passed": result.passed, "findings": result.findings,
        }
    return cases


def sequence_matcher_cases() -> list[dict]:
    from difflib import SequenceMatcher

    rng = LCG(505)
    words = ["the", "hook", "lands", "weakly", "because", "premise", "is",
             "buried", "under", "setup", "canon", "drift", "in", "act",
             "two", "contradicts", "bible", "pacing", "sags", "midway"]

    def sentence(n: int) -> str:
        return " ".join(rng.choice(words) for _ in range(n))

    cases = [
        {"a": "the hook lands weakly", "b": "the hook lands weakly"},
        {"a": "the hook lands weakly", "b": "the hook is weak"},
        {"a": "canon drift in act two", "b": "act two drifts from canon"},
        {"a": "", "b": ""},
        {"a": "abc", "b": ""},
        {"a": "short", "b": "entirely different words"},
    ]
    # Long strings (>= 200 chars) trigger difflib autojunk on popular chars
    long_a = sentence(60)
    long_b = long_a.replace("hook", "opening", 3)
    cases.append({"a": long_a, "b": long_b})
    cases.append({"a": sentence(80), "b": sentence(80)})
    for _ in range(8):
        n = rng.randint(5, 40)
        a = sentence(n)
        b = sentence(rng.randint(5, 40)) if rng.randint(0, 1) else a[: rng.randint(1, max(1, len(a)))]
        cases.append({"a": a, "b": b})
    for case in cases:
        case["expected"] = SequenceMatcher(None, case["a"], case["b"]).ratio()
    return cases


def validation_text_cases() -> list[dict]:
    cases = [
        {"input": '```json\n{"a": 1}\n```'},
        {"input": '```\n{"a": 1}\n```'},
        {"input": '{"a": 1}'},
        {"input": '  ```json\n{"a": [1, 2]}\n```  '},
        {"input": ""},
        {"input": None},
        {"input": "no fences at all"},
        {"input": '```json\n{"nested": "```code```"}\n```'},
    ]
    for case in cases:
        case["expected_stripped"] = _strip_fences(case["input"])
    ctrl = [
        {"input": "clean text"},
        {"input": "null\x00byte"},
        {"input": "back\x08space"},
        {"input": "vertical\x0btab"},
        {"input": "form\x0cfeed"},
        {"input": "shift\x0eout\x0fin"},
        {"input": "bell\x07char and esc\x1b[0m"},
        {"input": ""},
        {"input": None},
    ]
    for case in ctrl:
        case["expected"] = _sanitize_control_chars(case["input"])
    return [{"fences": cases, "control_chars": ctrl}]


def cost_cases() -> list[dict]:
    """Cost estimation parity through the real Config/manifest machinery."""
    from quorable.engine.config import Config
    from quorable.engine.costs import estimate_pipeline_cost
    from quorable.engine.manifest import ManifestEntry
    from quorable.engine.schemas import Document

    def doc(name: str, chars: int, tier: int) -> Document:
        return Document(
            name=name, role="r", tier=tier, content="x" * chars,
            page_count=1, char_count=chars, sha256="0" * 64,
        )

    cases_in = [
        {
            "name": "two_reviewers_with_drafter",
            "config": {
                "models": {
                    "reviewers": [
                        {"id": "anthropic/claude-sonnet-5", "temperature": 0.2},
                        {"id": "openai/gpt-5.5", "temperature": 0.2},
                    ],
                    "synthesizer": {"id": "anthropic/claude-sonnet-5", "temperature": 0.1},
                    "held_out": {"id": "x-ai/grok-4.3", "temperature": 0.2},
                    "drafter": {"id": "anthropic/claude-sonnet-5", "temperature": 0.7},
                },
                "pipeline": {"runs_per_persona": 2},
                "personas": ["praiser", "critic"],
            },
            "entries": [
                {"name": "primary", "tier": 1, "send_to": ["stage1", "stage2", "draft"]},
                {"name": "canon", "tier": 2, "send_to": ["stage1_critic", "draft"]},
                {"name": "notes", "tier": 3, "send_to": []},
            ],
            "documents": {"primary": 8000, "canon": 24000, "notes": 500},
            "system_prompt_chars": 3000,
            "persona_overlay_chars": {"praiser": 1200, "critic": 1600},
            "include_drafter": True,
            "iterations": 3,
        },
        {
            "name": "unknown_model_default_pricing",
            "config": {
                "models": {
                    "reviewers": [{"id": "someone/unknown-model", "temperature": 0.2}],
                    "synthesizer": {"id": "someone/unknown-model", "temperature": 0.1},
                    "held_out": {"id": "x-ai/grok-4.3", "temperature": 0.2},
                },
                "pipeline": {"runs_per_persona": 1},
                "personas": ["praiser"],
            },
            "entries": [
                {"name": "primary", "tier": 1, "send_to": ["stage1"]},
            ],
            "documents": {"primary": 4000},
            "system_prompt_chars": 1000,
            "persona_overlay_chars": {},
            "include_drafter": False,
            "iterations": 1,
        },
    ]
    out = []
    for case in cases_in:
        config = Config.model_validate({**case["config"]})
        entries = [
            ManifestEntry(
                name=e["name"], path=Path("/nonexistent") / e["name"],
                tier=e["tier"], send_to=e["send_to"],
            )
            for e in case["entries"]
        ]
        documents = {
            name: doc(name, chars, next(e["tier"] for e in case["entries"] if e["name"] == name))
            for name, chars in case["documents"].items()
        }
        est = estimate_pipeline_cost(
            config=config,
            entries=entries,
            documents=documents,
            system_prompt_chars=case["system_prompt_chars"],
            persona_overlay_chars=case["persona_overlay_chars"],
            include_drafter=case["include_drafter"],
            iterations=case["iterations"],
        )
        case["expected"] = {
            "model_estimates": [
                {
                    "model_id": m.model_id,
                    "num_calls": m.num_calls,
                    "input_tokens_per_call": m.input_tokens_per_call,
                    "output_tokens_per_call": m.output_tokens_per_call,
                    "input_cost_usd": m.input_cost_usd,
                    "output_cost_usd": m.output_cost_usd,
                }
                for m in est.model_estimates
            ],
            "total_usd": est.total_usd,
            "per_loop_usd": est.per_loop_usd,
            "iterations": est.iterations,
        }
        out.append(case)
    return out


def main() -> None:
    write_fixture("agreement_cases.json", agreement_cases())
    write_fixture("icc_cases.json", icc_cases())
    write_fixture("kappa_cases.json", kappa_cases())
    write_fixture("normalize_cases.json", normalize_cases())
    write_fixture("scoring_cases.json", scoring_cases())
    write_fixture("priority_cases.json", priority_cases())
    write_fixture("gate_cases.json", gate_cases())
    write_fixture("sequence_matcher_cases.json", sequence_matcher_cases())
    write_fixture("validation_text_cases.json", validation_text_cases())
    write_fixture("cost_cases.json", cost_cases())


if __name__ == "__main__":
    main()
