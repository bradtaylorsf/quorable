"""Structured logging with dual output: rich console + run.log file (§11, Issue #22).

Provides a centralized logging configuration so every module gets consistent
formatting. Console output uses rich markup; file output uses a structured
key=value format for machine-parseable post-run analysis.
"""
from __future__ import annotations

import logging
from pathlib import Path

from rich.console import Console
from rich.logging import RichHandler


class StructuredFormatter(logging.Formatter):
    """Structured log formatter that emits key=value pairs.

    Produces lines like:
        2026-04-11T18:45:12 INFO quorable.engine.client: OpenRouter call completed | model=... tokens=...
    This format is grep-friendly and parseable by simple log analysis tools.
    """

    FORMAT = "%(asctime)s %(levelname)s %(name)s: %(message)s"

    def __init__(self) -> None:
        super().__init__(fmt=self.FORMAT, datefmt="%Y-%m-%dT%H:%M:%S")


def setup_logging(*, level: int = logging.INFO) -> None:
    """Configure the root logger with rich console output.

    Call this once at CLI entry. The file handler is added later via
    add_file_handler() once the run directory is known.
    """
    root = logging.getLogger()
    root.setLevel(level)

    # Avoid duplicate handlers if called multiple times (e.g., in tests)
    if any(isinstance(h, RichHandler) for h in root.handlers):
        return

    # Rich console handler — human-friendly, coloured, no timestamp
    # (rich adds its own timestamp rendering)
    console_handler = RichHandler(
        console=Console(stderr=True),
        show_path=False,
        markup=True,
        rich_tracebacks=True,
    )
    console_handler.setLevel(level)
    root.addHandler(console_handler)


def add_file_handler(run_dir: Path, *, level: int = logging.DEBUG) -> logging.FileHandler:
    """Attach a structured file handler writing to run_dir/run.log.

    Called once per pipeline run after the output directory is created.
    Uses DEBUG level so the file captures more detail than console.
    Returns the handler so it can be removed at end of run if needed.
    """
    log_path = run_dir / "run.log"
    handler = logging.FileHandler(log_path, encoding="utf-8")
    handler.setLevel(level)
    handler.setFormatter(StructuredFormatter())

    logging.getLogger().addHandler(handler)
    return handler
