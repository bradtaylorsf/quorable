"""Tests for the Pack contract loader (quorable.pack.load_pack)."""
from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import BaseModel

from quorable.engine.gates import Gate
from quorable.pack import Pack, PackError, ShipGates, load_pack


class TestLoadToyPack:
    def test_loads_valid_pack(self, toy_project: Path):
        pack = load_pack(toy_project / "config.yaml")
        assert isinstance(pack, Pack)
        assert pack.name == "toy"
        assert pack.primary_doc_name == "script_draft"
        assert pack.score_dimensions == ["clarity", "punch"]
        assert pack.verdict_categories == ["good", "mixed", "bad"]
        assert issubclass(pack.review_schema, BaseModel)
        assert issubclass(pack.synthesis_schema, BaseModel)
        assert all(isinstance(g, Gate) for g in pack.mechanical_gates)
        assert isinstance(pack.ship_gates, ShipGates)
        assert callable(pack.ship_gates.blocking_findings)

    def test_pack_path_resolved_relative_to_config(self, toy_project: Path):
        # Loading via a relative-looking path still finds ./pack.py next to
        # the config file, not the CWD.
        pack = load_pack(toy_project / "config.yaml")
        assert pack.name == "toy"


class TestLoadPackErrors:
    def test_missing_config_file(self, tmp_path: Path):
        with pytest.raises(PackError, match="Config file not found"):
            load_pack(tmp_path / "config.yaml")

    def test_missing_pack_key(self, tmp_path: Path):
        config = tmp_path / "config.yaml"
        config.write_text("models: {}\n", encoding="utf-8")
        with pytest.raises(PackError, match="no `pack:` key"):
            load_pack(config)

    def test_missing_pack_module(self, tmp_path: Path):
        config = tmp_path / "config.yaml"
        config.write_text("pack: ./nope.py\n", encoding="utf-8")
        with pytest.raises(PackError, match="Pack module not found"):
            load_pack(config)

    def test_module_without_pack_attribute(self, tmp_path: Path):
        (tmp_path / "pack.py").write_text("x = 1\n", encoding="utf-8")
        config = tmp_path / "config.yaml"
        config.write_text("pack: ./pack.py\n", encoding="utf-8")
        with pytest.raises(PackError, match="PACK"):
            load_pack(config)

    def test_pack_wrong_type(self, tmp_path: Path):
        (tmp_path / "pack.py").write_text("PACK = {'name': 'x'}\n", encoding="utf-8")
        config = tmp_path / "config.yaml"
        config.write_text("pack: ./pack.py\n", encoding="utf-8")
        with pytest.raises(PackError, match="must be a quorable.pack.Pack"):
            load_pack(config)

    def test_pack_import_error_surfaces(self, tmp_path: Path):
        (tmp_path / "pack.py").write_text("raise RuntimeError('boom')\n", encoding="utf-8")
        config = tmp_path / "config.yaml"
        config.write_text("pack: ./pack.py\n", encoding="utf-8")
        with pytest.raises(PackError, match="failed to import"):
            load_pack(config)

    def test_mistyped_fields_all_listed(self, tmp_path: Path):
        """Every problem appears in one error message, not just the first."""
        (tmp_path / "pack.py").write_text(
            """
from quorable.pack import Pack, ShipGates

PACK = Pack(
    name="",
    review_schema=str,
    synthesis_schema=int,
    score_dimensions=[],
    verdict_field="verdict",
    verdict_categories=["a"],
    canonical_units=["u"],
    unit_field="unit",
    primary_doc_name="doc",
    doc_type_markers={},
    mechanical_gates=["not-a-gate"],
    ship_gates=ShipGates(composite_min=4.0, dimension_min=3.0),
)
""",
            encoding="utf-8",
        )
        config = tmp_path / "config.yaml"
        config.write_text("pack: ./pack.py\n", encoding="utf-8")
        with pytest.raises(PackError) as excinfo:
            load_pack(config)
        message = str(excinfo.value)
        assert "review_schema" in message
        assert "synthesis_schema" in message
        assert "score_dimensions" in message
        assert "mechanical_gates" in message
        assert "name must be a non-empty string" in message

    def test_weights_naming_unknown_dimension(self, tmp_path: Path):
        (tmp_path / "pack.py").write_text(
            """
from pydantic import BaseModel

from quorable.pack import Pack, ShipGates


class Unit(BaseModel):
    unit: str
    clarity: int


class Review(BaseModel):
    unit_reviews: list[Unit]
    verdict: str


class Synthesis(BaseModel):
    consensus_weaknesses: list = []


PACK = Pack(
    name="w",
    review_schema=Review,
    synthesis_schema=Synthesis,
    score_dimensions=["clarity"],
    verdict_field="verdict",
    verdict_categories=["good"],
    canonical_units=["u"],
    unit_field="unit",
    primary_doc_name="doc",
    doc_type_markers={},
    mechanical_gates=[],
    ship_gates=ShipGates(
        composite_min=4.0, dimension_min=3.0, weights={"nonexistent": 1.0},
    ),
)
""",
            encoding="utf-8",
        )
        config = tmp_path / "config.yaml"
        config.write_text("pack: ./pack.py\n", encoding="utf-8")
        with pytest.raises(PackError, match="unknown dimensions"):
            load_pack(config)

    def test_missing_unit_list_field(self, tmp_path: Path):
        (tmp_path / "pack.py").write_text(
            """
from pydantic import BaseModel

from quorable.pack import Pack, ShipGates


class Review(BaseModel):
    verdict: str


class Synthesis(BaseModel):
    consensus_weaknesses: list = []


PACK = Pack(
    name="nounits",
    review_schema=Review,
    synthesis_schema=Synthesis,
    score_dimensions=["clarity"],
    verdict_field="verdict",
    verdict_categories=["good"],
    canonical_units=["u"],
    unit_field="unit",
    primary_doc_name="doc",
    doc_type_markers={},
    mechanical_gates=[],
    ship_gates=ShipGates(composite_min=4.0, dimension_min=3.0),
)
""",
            encoding="utf-8",
        )
        config = tmp_path / "config.yaml"
        config.write_text("pack: ./pack.py\n", encoding="utf-8")
        with pytest.raises(PackError, match="unit_reviews"):
            load_pack(config)
