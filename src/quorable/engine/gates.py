"""Mechanical (non-LLM) gate framework.

A gate is `Gate(name, fn)` where `fn(primary_text, project) -> GateResult`.
Gates never consult a model — they exist to catch the class of defect that is
cheap to detect deterministically (overlength scripts, banned terms, term
drift), exactly like the parent's citation/xref gates did for filings.

The engine provides combinators plus three batteries packs can instantiate:
`word_count_gate`, `term_lint_gate`, `banned_elements_gate`. Packs are free
to add their own Gate objects with arbitrary callables.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any, Callable

logger = logging.getLogger(__name__)


@dataclass
class GateResult:
    """The outcome of running one mechanical gate."""

    passed: bool
    findings: list[str] = field(default_factory=list)


# fn(primary_text, project) -> GateResult. `project` is an opaque handle
# (usually the Config, may be None) so pack gates can reach project data
# without the engine dictating its shape.
GateFn = Callable[[str, Any], GateResult]


@dataclass
class Gate:
    """A named mechanical check over the primary document text."""

    name: str
    fn: GateFn

    def run(self, primary_text: str, project: Any = None) -> GateResult:
        try:
            return self.fn(primary_text, project)
        except Exception as exc:  # noqa: BLE001 — a broken gate is a failed gate
            logger.error("Gate '%s' raised: %s", self.name, exc)
            return GateResult(
                passed=False,
                findings=[f"gate '{self.name}' crashed: {exc}"],
            )


def run_gates(
    gates: list[Gate],
    primary_text: str,
    project: Any = None,
) -> dict[str, GateResult]:
    """Run every gate; failures become results, never crashes."""
    results: dict[str, GateResult] = {}
    for gate in gates:
        result = gate.run(primary_text, project)
        results[gate.name] = result
        if not result.passed:
            logger.warning(
                "Gate '%s' FAILED: %s", gate.name, "; ".join(result.findings),
            )
    return results


def all_gates_passed(results: dict[str, GateResult]) -> bool:
    return all(r.passed for r in results.values())


# ---------------------------------------------------------------------------
# Gate batteries
# ---------------------------------------------------------------------------

_WORD_RE = re.compile(r"\S+")


def _extract_section(text: str, section: str) -> str | None:
    """Extract a markdown section's body by heading title (any # level).

    Returns None when the heading is absent. The section runs until the next
    heading of the same or shallower level.
    """
    heading_re = re.compile(
        rf"^(#{{1,6}})\s+{re.escape(section)}\s*$", re.MULTILINE | re.IGNORECASE,
    )
    m = heading_re.search(text)
    if m is None:
        return None
    level = len(m.group(1))
    rest = text[m.end():]
    next_re = re.compile(rf"^#{{1,{level}}}\s+\S", re.MULTILINE)
    nxt = next_re.search(rest)
    return rest[: nxt.start()] if nxt else rest


def word_count_gate(
    max_words: int,
    section: str | None = None,
    line_prefix: str | None = None,
) -> Gate:
    """Fail when the counted region exceeds max_words.

    Counting scope (mutually exclusive):
    - default: the whole document,
    - `section`: one named markdown section,
    - `line_prefix`: only the remainder of lines starting with the prefix
      (e.g. `line_prefix="VO:"` counts voice-over words in a script whose
      other lines are shot descriptions and overlays).

    Gate name is "word_count" (or "word_count_<section>") so golden-manifest
    detector keys stay stable when the limit is tuned.
    """
    if section is not None and line_prefix is not None:
        raise ValueError("word_count_gate: pass section OR line_prefix, not both")

    name = (
        f"word_count_{section.lower().replace(' ', '_')}"
        if section
        else "word_count"
    )
    prefix_label = line_prefix.rstrip(":").strip() if line_prefix else None

    def _fn(primary_text: str, project: Any) -> GateResult:
        target = primary_text
        scope = "document"
        if section is not None:
            extracted = _extract_section(primary_text, section)
            if extracted is None:
                return GateResult(
                    passed=False,
                    findings=[
                        f"section '{section}' not found — cannot verify its "
                        f"word count (missing section fails the gate)"
                    ],
                )
            target = extracted
            scope = f"section '{section}'"
        elif line_prefix is not None:
            matched_lines = [
                line.lstrip()[len(line_prefix):]
                for line in primary_text.splitlines()
                if line.lstrip().startswith(line_prefix)
            ]
            if not matched_lines:
                return GateResult(
                    passed=False,
                    findings=[
                        f"no lines start with '{line_prefix}' — cannot verify "
                        f"the {prefix_label} word count (missing content "
                        f"fails the gate)"
                    ],
                )
            target = "\n".join(matched_lines)
            count = len(_WORD_RE.findall(target))
            if count > max_words:
                return GateResult(
                    passed=False,
                    findings=[
                        f"{count} {prefix_label} words > {max_words} "
                        f"(max {max_words})"
                    ],
                )
            return GateResult(passed=True)
        count = len(_WORD_RE.findall(target))
        if count > max_words:
            return GateResult(
                passed=False,
                findings=[f"{scope} is {count} words (max {max_words})"],
            )
        return GateResult(passed=True)

    return Gate(name=name, fn=_fn)


def term_lint_gate(canonical_terms: dict[str, list[str]]) -> Gate:
    """Fail on known-bad aliases of canonical terms.

    `canonical_terms` maps the canonical spelling to a list of known-bad
    aliases. Alias matching is case-sensitive and word-boundary based, so a
    lowercase alias of a capitalized canonical term is caught without
    flagging the canonical spelling itself.
    """

    def _fn(primary_text: str, project: Any) -> GateResult:
        findings: list[str] = []
        for canonical, aliases in canonical_terms.items():
            for alias in aliases:
                if alias == canonical:
                    continue
                pattern = re.compile(rf"(?<!\w){re.escape(alias)}(?!\w)")
                hits = pattern.findall(primary_text)
                if hits:
                    findings.append(
                        f"found '{alias}' ×{len(hits)} — canonical spelling "
                        f"is '{canonical}'"
                    )
        return GateResult(passed=not findings, findings=findings)

    return Gate(name="term_lint", fn=_fn)


def banned_elements_gate(patterns: list[str]) -> Gate:
    """Fail when any banned regex pattern appears in the document."""
    compiled = [re.compile(p, re.MULTILINE) for p in patterns]

    def _fn(primary_text: str, project: Any) -> GateResult:
        findings: list[str] = []
        for raw, pattern in zip(patterns, compiled):
            m = pattern.search(primary_text)
            if m:
                snippet = primary_text[m.start(): m.start() + 60].splitlines()[0]
                findings.append(
                    f"banned pattern {raw!r} matched at char {m.start()}: "
                    f"{snippet!r}"
                )
        return GateResult(passed=not findings, findings=findings)

    return Gate(name="banned_elements", fn=_fn)
