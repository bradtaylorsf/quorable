"""Tests for the mechanical gate framework and its three batteries."""
from __future__ import annotations

from quorable.engine.gates import (
    Gate,
    GateResult,
    all_gates_passed,
    banned_elements_gate,
    run_gates,
    term_lint_gate,
    word_count_gate,
)


class TestWordCountGate:
    def test_passes_under_limit(self):
        gate = word_count_gate(10)
        result = gate.run("one two three")
        assert result.passed
        assert result.findings == []

    def test_fails_over_limit_with_count(self):
        gate = word_count_gate(3)
        result = gate.run("one two three four five")
        assert not result.passed
        assert "5 words" in result.findings[0]
        assert "max 3" in result.findings[0]

    def test_section_scoped_count(self):
        gate = word_count_gate(3, section="Hook")
        text = "# Hook\n\none two\n\n# Body\n\n" + " ".join(["w"] * 50)
        result = gate.run(text)
        assert result.passed

    def test_section_over_limit(self):
        gate = word_count_gate(3, section="Hook")
        text = "# Hook\n\none two three four five\n\n# Body\n\nshort"
        result = gate.run(text)
        assert not result.passed
        assert "section 'Hook'" in result.findings[0]

    def test_missing_section_fails(self):
        gate = word_count_gate(3, section="Hook")
        result = gate.run("# Body\n\nno hook here")
        assert not result.passed
        assert "not found" in result.findings[0]

    def test_gate_name_stable_across_limits(self):
        """Gate names are golden-manifest detector keys — the limit is a
        parameter, not identity."""
        assert word_count_gate(120).name == "word_count"
        assert word_count_gate(310).name == "word_count"
        assert word_count_gate(30, section="Hook").name == "word_count_hook"

    def test_line_prefix_counts_only_prefixed_lines(self):
        gate = word_count_gate(5, line_prefix="VO:")
        text = (
            "[0:00] SHOT: many many words that are not voice over at all\n"
            "            VO: three little words\n"
            "OVERLAY: MORE NOISE\n"
            "VO: two more\n"
        )
        assert gate.run(text).passed  # 5 VO words == limit

    def test_line_prefix_over_limit_message(self):
        gate = word_count_gate(3, line_prefix="VO:")
        text = "VO: one two three four five\nSHOT: ignored\n"
        result = gate.run(text)
        assert not result.passed
        assert "5 VO words > 3" in result.findings[0]

    def test_line_prefix_missing_lines_fails(self):
        gate = word_count_gate(10, line_prefix="VO:")
        result = gate.run("SHOT: no voice over anywhere")
        assert not result.passed
        assert "no lines start with 'VO:'" in result.findings[0]

    def test_section_and_prefix_mutually_exclusive(self):
        import pytest

        with pytest.raises(ValueError, match="not both"):
            word_count_gate(10, section="Hook", line_prefix="VO:")


class TestTermLintGate:
    def test_catches_bad_alias(self):
        gate = term_lint_gate({"Showkick": ["Show Kick", "showkick"]})
        result = gate.run("Try Show Kick today")
        assert not result.passed
        assert "Show Kick" in result.findings[0]
        assert "Showkick" in result.findings[0]

    def test_canonical_spelling_not_flagged(self):
        gate = term_lint_gate({"Showkick": ["Show Kick", "showkick"]})
        result = gate.run("Showkick is great. Showkick forever.")
        assert result.passed

    def test_lowercase_alias_caught_case_sensitively(self):
        gate = term_lint_gate({"Showkick": ["showkick"]})
        assert not gate.run("get showkick now").passed
        assert gate.run("get Showkick now").passed

    def test_multiple_aliases_reported(self):
        gate = term_lint_gate({"Showkick": ["Show Kick", "show-kick"]})
        result = gate.run("Show Kick and show-kick appear")
        assert not result.passed
        assert len(result.findings) == 2

    def test_word_boundary(self):
        gate = term_lint_gate({"kick": ["kik"]})
        assert gate.run("kikstarter is fine").passed
        assert not gate.run("send a kik message").passed


class TestBannedElementsGate:
    def test_catches_pattern(self):
        gate = banned_elements_gate([r"\bTODO\b"])
        result = gate.run("intro\nTODO fix this\noutro")
        assert not result.passed
        assert "TODO" in result.findings[0]

    def test_passes_clean_text(self):
        gate = banned_elements_gate([r"\bTODO\b", r"lorem ipsum"])
        assert gate.run("all done here").passed

    def test_multiple_patterns_each_reported(self):
        gate = banned_elements_gate([r"\bTODO\b", r"FIXME"])
        result = gate.run("TODO one\nFIXME two")
        assert not result.passed
        assert len(result.findings) == 2


class TestGateFramework:
    def test_crashing_gate_becomes_failed_result(self):
        def _boom(text, project):
            raise RuntimeError("kaput")

        gate = Gate(name="boom", fn=_boom)
        result = gate.run("text")
        assert not result.passed
        assert "kaput" in result.findings[0]

    def test_run_gates_collects_all(self):
        gates = [
            word_count_gate(100),
            banned_elements_gate([r"XXX"]),
        ]
        results = run_gates(gates, "clean text")
        assert set(results) == {"word_count", "banned_elements"}
        assert all_gates_passed(results)

    def test_all_gates_passed_false_on_any_failure(self):
        gates = [word_count_gate(1), banned_elements_gate([])]
        results = run_gates(gates, "two words here")
        assert not all_gates_passed(results)

    def test_project_handle_passed_through(self):
        seen = {}

        def _fn(text, project):
            seen["project"] = project
            return GateResult(passed=True)

        Gate(name="probe", fn=_fn).run("t", project={"marker": 1})
        assert seen["project"] == {"marker": 1}
