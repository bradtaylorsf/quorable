"""The Pack contract: everything domain-specific a project supplies in code.

A project's config.yaml names its pack via the `pack:` key (path relative to
the config file). `load_pack(config_path)` importlib-loads that module and
returns its `PACK` attribute after validation. The engine never imports
domain modules directly — the Pack is the only code boundary between the
domain and the engine.

See CONTRACT.md for the full field semantics and the field-name conventions
packs must honor in their review/synthesis schemas.
"""
from __future__ import annotations

import importlib.util
import logging
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import yaml
from pydantic import BaseModel

from quorable.engine.gates import Gate

logger = logging.getLogger(__name__)


class PackError(Exception):
    """Raised when a project's pack.py is missing, malformed, or mistyped."""


@dataclass
class ShipGates:
    """The stop-when-shippable criteria evaluated by the loop.

    The product-truth guard lives here: `blocking_findings(synthesis,
    reviews)` returns findings that must block shipping (e.g. severity-1
    canon drift) regardless of how good the scores look. It is a gate, never
    an averaged score.

    `reviews` is the list of successful raw Stage-1 review objects
    (validated pack review_schema instances) from the current iteration —
    blocking gates are computed from ground truth in code, never trusted to
    the synthesis LLM's copy-through (same posture as agreement stats /
    priority_score). A synthesis model that silently drops a severity-1
    finding must not unblock shipping.
    """

    composite_min: float
    dimension_min: float
    # Callable(synthesis, reviews) -> list[str] of blocking findings; None
    # means no blocking-findings gate.
    blocking_findings: Callable[[Any, list[Any]], list[str]] | None = None
    # dimension → weight for the composite; None = unweighted mean.
    weights: dict[str, float] | None = None
    # Personas excluded from the composite AND the per-dimension floor
    # (dimension_min) statistics. Red-team personas score low BY DESIGN;
    # pooling them makes composite_min measure harshness, not quality. Their
    # reviews still count everywhere else: raw_reviews, findings,
    # blocking_findings, synthesis input, and agreement statistics.
    composite_exclude_personas: list[str] = field(default_factory=list)


@dataclass
class Pack:
    """Everything the engine needs to know about a writing domain."""

    name: str
    review_schema: type[BaseModel]        # Stage-1 output schema
    synthesis_schema: type[BaseModel]     # Stage-2 output schema
    score_dimensions: list[str]           # ICC targets; must match schema fields
    verdict_field: str                    # Fleiss' kappa target field
    verdict_categories: list[str]
    canonical_units: list[str]            # canonical unit names (parent: canonical_causes)
    unit_field: str                       # grouping key for regressions/agreement
    primary_doc_name: str
    doc_type_markers: dict[str, list[str]]  # wrong-mode guard
    mechanical_gates: list[Gate]          # run in Stage GATES + golden detectors
    ship_gates: ShipGates
    drafter_enabled: bool = True          # False ⇒ review-only domain: `run` is single-pass
    held_out_recommended_docs: list[str] = field(default_factory=list)

    # Name of the review-schema field holding the list of per-unit score
    # objects. Defaults to the engine convention "unit_reviews"; a pack whose
    # schema uses another name sets this instead of the engine special-casing.
    unit_list_field: str = "unit_reviews"
    # OPTIONAL score shape switch. None (default) = attribute style: each
    # unit object has one numeric attribute PER score_dimension (the parent's
    # cause-of-action shape). Set (e.g. "score") = unit-major style: each
    # unit object carries its dimension name in `unit_field` and a single
    # numeric `unit_score_field` (the spec-verbatim shorts shape,
    # dimension_scores: [{dimension, score, rationale}]). Engine score/ICC
    # accessors support both.
    unit_score_field: str | None = None
    # Optional keyword → canonical-key rules for unit-name normalization in
    # agreement statistics (the parent hardcoded _CAUSE_KEYWORD_RULES).
    unit_keyword_rules: list[tuple[str, str]] = field(default_factory=list)


def _read_pack_path(config_path: Path) -> Path:
    """Read the `pack:` key from config.yaml, resolved relative to it."""
    config_path = Path(config_path)
    if not config_path.exists():
        raise PackError(f"Config file not found: {config_path}")
    with open(config_path) as f:
        raw = yaml.safe_load(f) or {}
    if not isinstance(raw, dict) or "pack" not in raw:
        raise PackError(
            f"{config_path} has no `pack:` key. Add e.g.\n\n"
            f"  pack: ./pack.py\n\n"
            f"pointing at the project's pack module (path relative to the "
            f"config file)."
        )
    pack_path = Path(raw["pack"])
    if not pack_path.is_absolute():
        pack_path = config_path.parent / pack_path
    return pack_path


def _validate_pack(pack: Any, pack_path: Path) -> list[str]:
    """Collect every problem with a PACK object; empty list means valid."""
    problems: list[str] = []
    if not isinstance(pack, Pack):
        return [
            f"PACK must be a quorable.pack.Pack instance, got "
            f"{type(pack).__name__}"
        ]

    def _check_schema(attr: str) -> None:
        value = getattr(pack, attr)
        if not (isinstance(value, type) and issubclass(value, BaseModel)):
            problems.append(
                f"{attr} must be a pydantic BaseModel subclass, got {value!r}"
            )

    _check_schema("review_schema")
    _check_schema("synthesis_schema")

    for attr in ("name", "verdict_field", "unit_field", "primary_doc_name"):
        if not isinstance(getattr(pack, attr), str) or not getattr(pack, attr):
            problems.append(f"{attr} must be a non-empty string")

    for attr in ("score_dimensions", "verdict_categories", "canonical_units"):
        value = getattr(pack, attr)
        if (
            not isinstance(value, list)
            or not value
            or not all(isinstance(v, str) for v in value)
        ):
            problems.append(f"{attr} must be a non-empty list of strings")

    if not isinstance(pack.doc_type_markers, dict):
        problems.append("doc_type_markers must be a dict[str, list[str]]")

    if not isinstance(pack.mechanical_gates, list) or not all(
        isinstance(g, Gate) for g in pack.mechanical_gates
    ):
        problems.append(
            "mechanical_gates must be a list of quorable.engine.gates.Gate"
        )

    if not isinstance(pack.ship_gates, ShipGates):
        problems.append(
            f"ship_gates must be a quorable.pack.ShipGates instance, got "
            f"{type(pack.ship_gates).__name__}"
        )
    else:
        if pack.ship_gates.blocking_findings is not None and not callable(
            pack.ship_gates.blocking_findings
        ):
            problems.append("ship_gates.blocking_findings must be callable or None")
        if pack.ship_gates.weights is not None:
            unknown = set(pack.ship_gates.weights) - set(pack.score_dimensions)
            if unknown:
                problems.append(
                    f"ship_gates.weights names unknown dimensions: {sorted(unknown)}"
                )
        excl = pack.ship_gates.composite_exclude_personas
        if not isinstance(excl, list) or not all(isinstance(p, str) for p in excl):
            problems.append(
                "ship_gates.composite_exclude_personas must be a list of "
                "persona names"
            )

    if pack.unit_score_field is not None and not isinstance(pack.unit_score_field, str):
        problems.append("unit_score_field must be a string or None")

    # The review schema must declare the per-unit score list, and (when
    # introspectable) the unit items must carry the fields the configured
    # score shape reads.
    review_is_model = isinstance(pack.review_schema, type) and issubclass(
        pack.review_schema, BaseModel,
    )
    if review_is_model:
        unit_list = pack.review_schema.model_fields.get(pack.unit_list_field)
        if unit_list is None:
            problems.append(
                f"review_schema has no '{pack.unit_list_field}' field (the "
                f"per-unit score list). Set Pack.unit_list_field to the "
                f"actual field name."
            )
        elif pack.unit_score_field is not None:
            # Unit-major shape: each unit item must carry the unit name
            # (unit_field) and the single numeric score (unit_score_field).
            # score_dimensions are VALUES of unit_field here, deliberately
            # NOT required as attributes.
            item_model = _unit_item_model(unit_list.annotation)
            if item_model is not None:
                for attr in (pack.unit_field, pack.unit_score_field):
                    if attr not in item_model.model_fields:
                        problems.append(
                            f"unit-major mode: '{pack.unit_list_field}' items "
                            f"({item_model.__name__}) have no '{attr}' field "
                            f"(required by "
                            f"{'unit_field' if attr == pack.unit_field else 'unit_score_field'})"
                        )

    return problems


def _unit_item_model(annotation: Any) -> type[BaseModel] | None:
    """Extract the BaseModel item type from a list[...] annotation, if any."""
    import typing

    for arg in typing.get_args(annotation):
        if isinstance(arg, type) and issubclass(arg, BaseModel):
            return arg
    return None


def load_pack(config_path: Path) -> Pack:
    """Load and validate a project's PACK from its config.yaml.

    Raises PackError with a clear, complete list of what is missing or
    mistyped — never a partial pack.
    """
    pack_path = _read_pack_path(config_path)
    if not pack_path.exists():
        raise PackError(f"Pack module not found: {pack_path}")

    module_name = f"quorable_pack_{pack_path.parent.name}_{abs(hash(str(pack_path)))}"
    spec = importlib.util.spec_from_file_location(module_name, pack_path)
    if spec is None or spec.loader is None:
        raise PackError(f"Cannot import pack module at {pack_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
    except Exception as exc:
        raise PackError(f"Pack module {pack_path} failed to import: {exc}") from exc

    if not hasattr(module, "PACK"):
        raise PackError(
            f"Pack module {pack_path} defines no `PACK` attribute. It must "
            f"expose `PACK = Pack(...)` (from quorable.pack import Pack)."
        )

    pack = module.PACK
    problems = _validate_pack(pack, pack_path)
    if problems:
        bullet_list = "\n".join(f"  - {p}" for p in problems)
        raise PackError(
            f"Pack at {pack_path} is invalid:\n{bullet_list}"
        )

    logger.info(
        "Loaded pack '%s' from %s (%d gates, %d dimensions)",
        pack.name, pack_path, len(pack.mechanical_gates), len(pack.score_dimensions),
    )
    return pack
