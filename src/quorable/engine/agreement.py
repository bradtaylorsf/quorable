"""Inter-rater agreement statistics for Stage 2 synthesis.

Forked from the reference implementation's agreement module. The Fleiss' kappa and ICC(1,1) math is
verbatim from the parent; what changed is the vocabulary source:
SCORE_DIMENSIONS / RULING_CATEGORIES / _CAUSE_KEYWORD_RULES were hardcoded
legal constants and now come from the pack (score_dimensions,
verdict_categories + verdict_field, unit_keyword_rules).

Reviews are pack-schema instances accessed by convention: each review has a
`unit_list_field` list of per-unit objects carrying the unit name
(`unit_field`), one numeric attribute per score dimension, and (optionally)
the categorical verdict (`verdict_field`, falling back to the review-level
verdict).
"""
from __future__ import annotations

import logging
import re
from collections import Counter
from typing import Any, Iterable, Sequence

import numpy as np

logger = logging.getLogger(__name__)

# ICC below this threshold flags a dimension as "genuinely contested."
LOW_AGREEMENT_THRESHOLD = 0.4


# ---------------------------------------------------------------------------
# Unit-name normalization
#
# Reviewer models emit free-text unit names. Aligning subjects by exact
# string splits raters across phantom subjects and corrupts both Fleiss'
# kappa and ICC. All agreement computations key on the normalized form; when
# the pack provides keyword rules they are matched first.
# ---------------------------------------------------------------------------

def normalize_unit_name(
    name: str,
    keyword_rules: Sequence[tuple[str, str]] = (),
) -> str:
    """Reduce a free-text unit name to a stable alignment key."""
    key = name.lower().strip()
    key = re.sub(r"^[0-9]+[\.\)]?\s*", "", key)           # leading "1." / "1)"
    for keyword, canonical in keyword_rules:
        if keyword in key:
            return canonical
    key = re.sub(r"\(.*?\)", "", key)                      # parentheticals
    key = re.sub(r"[^a-z0-9 ]", "", key)
    return re.sub(r"\s+", " ", key).strip()


def _iter_units(review: Any, unit_list_field: str) -> Iterable[Any]:
    return getattr(review, unit_list_field, None) or []


def fleiss_kappa(
    reviews: list[Any],
    *,
    verdict_field: str,
    verdict_categories: list[str],
    unit_field: str,
    unit_list_field: str = "unit_reviews",
    keyword_rules: Sequence[tuple[str, str]] = (),
) -> float:
    """Compute Fleiss' kappa for the categorical verdict field across units.

    Each unit is a "subject" rated by all reviewers. This gives N subjects ×
    n raters × k categories, which is the proper input for Fleiss' kappa.
    Units are aligned by normalized name across reviews.

    Falls back to the review-level verdict if reviews have no per-unit
    verdicts (or no units in common).
    """
    n = len(reviews)
    if n < 2:
        return float("nan")

    # Build per-unit rating matrix keyed on NORMALIZED unit names:
    # {normalized_unit: [verdict_from_each_review]}
    unit_verdicts: dict[str, list[str]] = {}
    for review in reviews:
        for unit in _iter_units(review, unit_list_field):
            verdict = getattr(unit, verdict_field, None)
            if verdict is None:
                continue
            key = normalize_unit_name(
                str(getattr(unit, unit_field, "")), keyword_rules,
            )
            unit_verdicts.setdefault(key, []).append(verdict)

    # Only use units rated by at least 2 reviewers
    subjects = [v for v in unit_verdicts.values() if len(v) >= 2]

    if not subjects:
        # Fallback: treat the review-level verdict as the single subject
        overall = [
            getattr(r, verdict_field) for r in reviews
            if getattr(r, verdict_field, None) is not None
        ]
        if len(overall) < 2:
            return float("nan")
        subjects = [overall]

    return _fleiss_kappa_from_ratings(subjects, verdict_categories)


def _fleiss_kappa_from_ratings(
    subjects: list[list[str]],
    categories: list[str],
) -> float:
    """Compute Fleiss' kappa from a list of subjects with per-rater ratings.

    subjects: list of N subjects, each a list of n_i category assignments.
    categories: the k possible categories.
    """
    k = len(categories)
    cat_index = {c: i for i, c in enumerate(categories)}

    # Build the rating matrix: N subjects × k categories
    # Each cell = number of raters who assigned that category to that subject
    rating_matrix = []
    for ratings in subjects:
        row = [0] * k
        for r in ratings:
            idx = cat_index.get(r)
            if idx is not None:
                row[idx] += 1
        rating_matrix.append(row)

    big_n = len(rating_matrix)
    if big_n == 0:
        return float("nan")

    matrix = np.array(rating_matrix, dtype=np.float64)
    n_per_subject = matrix.sum(axis=1)  # raters per subject

    # P_i = proportion of agreeing pairs for subject i
    # P_i = (1 / (n_i*(n_i-1))) * sum_j(n_ij*(n_ij - 1))
    p_i_values = []
    for i in range(big_n):
        ni = n_per_subject[i]
        if ni < 2:
            continue
        p_i = np.sum(matrix[i] * (matrix[i] - 1)) / (ni * (ni - 1))
        p_i_values.append(p_i)

    if not p_i_values:
        return float("nan")

    # Mean observed agreement
    p_bar = np.mean(p_i_values)

    # Expected agreement: p_j = proportion of all assignments in category j
    total_ratings = matrix.sum()
    if total_ratings == 0:
        return float("nan")
    p_j = matrix.sum(axis=0) / total_ratings
    p_e = np.sum(p_j ** 2)

    if abs(p_e - 1.0) < 1e-10:
        return float("nan")

    kappa = float((p_bar - p_e) / (1.0 - p_e))
    return round(kappa, 4)


def _unit_score_for_dimension(
    unit: Any,
    dimension: str,
    *,
    unit_field: str,
    unit_score_field: str | None,
    keyword_rules: Sequence[tuple[str, str]] = (),
) -> float | None:
    """Read one unit object's score for `dimension`, in either score shape.

    Attribute style (unit_score_field=None): the score is the `dimension`
    attribute on the unit object. Unit-major style: the unit object IS one
    dimension's score — its `unit_field` names the dimension (canonicalized
    before matching) and `unit_score_field` carries the single number.
    """
    if unit_score_field is None:
        value = getattr(unit, dimension, None)
        return None if value is None else float(value)

    unit_name = normalize_unit_name(
        str(getattr(unit, unit_field, "")), keyword_rules,
    )
    if unit_name != normalize_unit_name(dimension, keyword_rules):
        return None
    value = getattr(unit, unit_score_field, None)
    return None if value is None else float(value)


def _extract_dimension_scores(
    reviews: list[Any],
    dimension: str,
    *,
    unit_field: str,
    unit_list_field: str = "unit_reviews",
    unit_score_field: str | None = None,
    keyword_rules: Sequence[tuple[str, str]] = (),
) -> list[list[float]]:
    """Extract per-unit scores for a dimension across all reviews.

    Returns a list of "subjects" (units), where each subject has a list of
    scores from the reviewers that rated it. Aligns by normalized unit name.

    NOTE: in unit-major mode each dimension has exactly one unit (itself),
    so the per-dimension ICC is a single-subject input and returns NaN —
    the statistically meaningful pooled signal in that mode is `icc_units`
    (see extract_unit_major_subjects / compute_agreement).
    """
    unit_scores: dict[str, list[float]] = {}
    for review in reviews:
        for unit in _iter_units(review, unit_list_field):
            value = _unit_score_for_dimension(
                unit, dimension,
                unit_field=unit_field,
                unit_score_field=unit_score_field,
                keyword_rules=keyword_rules,
            )
            if value is None:
                continue
            key = normalize_unit_name(
                str(getattr(unit, unit_field, "")), keyword_rules,
            )
            unit_scores.setdefault(key, []).append(value)

    return list(unit_scores.values())


def extract_unit_major_subjects(
    reviews: list[Any],
    *,
    unit_field: str,
    unit_list_field: str,
    unit_score_field: str,
    keyword_rules: Sequence[tuple[str, str]] = (),
) -> list[list[float]]:
    """Unit-major mode: subjects = units (dimensions), raters = reviews.

    This is the exact shape the parent fed to ICC (subjects=causes), with
    the unit's single score field as the rating — the pooled `icc_units`
    it produces answers "do reviewers differentiate the units consistently".
    """
    unit_scores: dict[str, list[float]] = {}
    for review in reviews:
        for unit in _iter_units(review, unit_list_field):
            value = getattr(unit, unit_score_field, None)
            if value is None:
                continue
            key = normalize_unit_name(
                str(getattr(unit, unit_field, "")), keyword_rules,
            )
            unit_scores.setdefault(key, []).append(float(value))
    return list(unit_scores.values())


def icc_oneway(scores_by_subject: list[list[float]]) -> float:
    """Compute ICC(1,1) — one-way random effects, single measures.

    Each subject (unit) is rated by multiple raters. We assume raters are
    randomly sampled (different review calls). This is the appropriate ICC
    variant when raters are not the same across subjects.

    Formula: ICC(1,1) = (BMS - WMS) / (BMS + (k-1)*WMS)
    where BMS = between-subjects mean square, WMS = within-subjects mean
    square, k = number of raters per subject.
    """
    if not scores_by_subject:
        return float("nan")

    # Filter to subjects with at least 2 ratings
    valid = [s for s in scores_by_subject if len(s) >= 2]
    if not valid:
        return float("nan")

    # For ICC we need consistent k; use subjects with the modal rater count
    k_counts = Counter(len(s) for s in valid)
    k = k_counts.most_common(1)[0][0]
    subjects = [s[:k] for s in valid if len(s) >= k]

    if len(subjects) < 2:
        return float("nan")

    n = len(subjects)  # number of subjects
    data = np.array(subjects, dtype=np.float64)  # shape: (n, k)

    grand_mean = data.mean()
    subject_means = data.mean(axis=1)

    # Between-subjects sum of squares
    bss = k * np.sum((subject_means - grand_mean) ** 2)
    # Within-subjects sum of squares
    wss = np.sum((data - subject_means[:, np.newaxis]) ** 2)

    bms = bss / (n - 1)
    wms = wss / (n * (k - 1)) if n * (k - 1) > 0 else 0.0

    denom = bms + (k - 1) * wms
    if abs(denom) < 1e-10:
        return 0.0

    icc = (bms - wms) / denom
    return round(float(icc), 4)


def compute_agreement(
    reviews: list[Any],
    pack: Any,
    personas: list[str] | None = None,
) -> dict[str, float]:
    """Compute all inter-rater agreement statistics.

    Returns a dict mapping dimension names to their agreement metric:
    - 'fleiss_kappa_verdict': Fleiss' kappa for the pack's verdict field
    - Per-dimension pooled ICC values (e.g., 'icc_clarity')
    - When `personas` is provided (one entry per review, aligned by index),
      per-persona ICC values (e.g., 'icc_clarity__critic').

    Interpretation caveat baked into the design: personas are INTENDED to
    disagree (adversarial lenses score lower by design), so the pooled ICC
    conflates designed lens differences with genuine model disagreement.
    The per-persona ICC — the same unit scored by different MODELS under the
    same lens — is the meaningful reliability signal; the pooled value is
    kept for continuity and labeled as pooled in reports.

    Dimensions with ICC below LOW_AGREEMENT_THRESHOLD are logged as
    genuinely contested.
    """
    result: dict[str, float] = {}

    keyword_rules = tuple(getattr(pack, "unit_keyword_rules", ()) or ())
    unit_list_field = getattr(pack, "unit_list_field", "unit_reviews")
    unit_score_field = getattr(pack, "unit_score_field", None)

    # Fleiss' kappa for the categorical verdict
    kappa = fleiss_kappa(
        reviews,
        verdict_field=pack.verdict_field,
        verdict_categories=pack.verdict_categories,
        unit_field=pack.unit_field,
        unit_list_field=unit_list_field,
        keyword_rules=keyword_rules,
    )
    result["fleiss_kappa_verdict"] = kappa
    logger.info("Fleiss' kappa (%s): %.4f", pack.verdict_field, kappa)

    # Per-dimension pooled ICC (all personas as raters — see caveat above)
    contested: list[str] = []
    for dim in pack.score_dimensions:
        scores = _extract_dimension_scores(
            reviews, dim,
            unit_field=pack.unit_field,
            unit_list_field=unit_list_field,
            unit_score_field=unit_score_field,
            keyword_rules=keyword_rules,
        )
        icc_val = icc_oneway(scores)
        result[f"icc_{dim}"] = icc_val
        logger.info("ICC(%s): %.4f", dim, icc_val)
        if not np.isnan(icc_val) and icc_val < LOW_AGREEMENT_THRESHOLD:
            contested.append(dim)

    # Unit-major mode: the per-dimension ICC above is single-subject (NaN by
    # construction); the pooled cross-unit ICC — subjects=units,
    # raters=reviews, the parent's exact input shape — is the meaningful
    # reliability signal, reported as icc_units.
    if unit_score_field is not None:
        result["icc_units"] = icc_oneway(extract_unit_major_subjects(
            reviews,
            unit_field=pack.unit_field,
            unit_list_field=unit_list_field,
            unit_score_field=unit_score_field,
            keyword_rules=keyword_rules,
        ))
        logger.info("ICC(units, pooled): %.4f", result["icc_units"])

    # Per-persona ICC: same lens, different models — the clean signal.
    if personas is not None and len(personas) == len(reviews):
        for persona in sorted(set(personas)):
            persona_reviews = [
                r for r, p in zip(reviews, personas) if p == persona
            ]
            if len(persona_reviews) < 2:
                continue
            for dim in pack.score_dimensions:
                scores = _extract_dimension_scores(
                    persona_reviews, dim,
                    unit_field=pack.unit_field,
                    unit_list_field=unit_list_field,
                    unit_score_field=unit_score_field,
                    keyword_rules=keyword_rules,
                )
                icc_val = icc_oneway(scores)
                result[f"icc_{dim}__{persona}"] = icc_val
            if unit_score_field is not None:
                result[f"icc_units__{persona}"] = icc_oneway(
                    extract_unit_major_subjects(
                        persona_reviews,
                        unit_field=pack.unit_field,
                        unit_list_field=unit_list_field,
                        unit_score_field=unit_score_field,
                        keyword_rules=keyword_rules,
                    )
                )
    elif personas is not None:
        logger.warning(
            "personas list length (%d) does not match reviews (%d) — "
            "skipping per-persona ICC",
            len(personas), len(reviews),
        )

    if contested:
        logger.warning(
            "Low pooled agreement dimensions (NOTE: pooled ICC mixes designed "
            "persona bias with model disagreement — check per-persona ICC "
            "before calling these genuinely contested): %s",
            ", ".join(contested),
        )

    return result


def get_contested_dimensions(agreement: dict[str, float]) -> list[str]:
    """Return dimension names where ICC indicates genuine disagreement."""
    contested = []
    for key, val in agreement.items():
        if key.startswith("icc_") and not np.isnan(val) and val < LOW_AGREEMENT_THRESHOLD:
            contested.append(key.removeprefix("icc_"))
    return contested
