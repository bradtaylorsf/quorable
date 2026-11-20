"""Latest-iteration lookup must order iter_N numerically (iter_10 > iter_9)."""
from __future__ import annotations

from quorable.engine.diff import _synthesis_dir
from quorable.engine.ledger import latest_iter_dir


def _make_run(tmp_path, numbers):
    for n in numbers:
        d = tmp_path / f"iter_{n}"
        d.mkdir()
        (d / "synthesis.json").write_text("{}")
    return tmp_path


def test_synthesis_dir_picks_iter_10_over_iter_9(tmp_path):
    run = _make_run(tmp_path, [1, 2, 9, 10])
    assert _synthesis_dir(run).name == "iter_10"


def test_latest_iter_dir_picks_iter_10_over_iter_9(tmp_path):
    run = _make_run(tmp_path, [1, 2, 9, 10])
    assert latest_iter_dir(run).name == "iter_10"
