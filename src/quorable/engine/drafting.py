"""Stage-DRAFT / Stage-REVISE: one call to the drafter model.

Net-new (no parent module). One call to `models.drafter` with the project
prompt (prompts/draft.md or prompts/revise.md) and the canon/context
documents routed via the manifest (`send_to: [draft]`). Returns the new
primary-document text.

Drafts are prose, not JSON — the call runs with json_mode=False and the raw
text response becomes the script. Markdown code fences wrapping the whole
response are stripped.
"""
from __future__ import annotations

import json
import logging
import re
import time
from pathlib import Path
from typing import Any

from quorable.engine.client import CostTracker, OpenRouterClient, OpenRouterError
from quorable.engine.manifest import ManifestEntry
from quorable.engine.prompts import DOC_DELIMITER, harden_system_prompt
from quorable.engine.schemas import Document

logger = logging.getLogger(__name__)

_WHOLE_FENCE_RE = re.compile(r"^```(?:markdown|md)?\s*\n(.*)\n```\s*$", re.DOTALL)


def assemble_for_draft(
    entries: list[ManifestEntry],
    documents: dict[str, Document],
    *,
    exclude: set[str] | None = None,
) -> list[Document]:
    """Return the documents routed to the drafter (`send_to: [draft]`)."""
    exclude = exclude or set()
    result: list[Document] = []
    for entry in entries:
        if entry.tier == 3 or entry.name in exclude:
            continue
        if "draft" in entry.send_to:
            doc = documents.get(entry.name)
            if doc:
                result.append(doc)
    return result


def _strip_whole_fence(text: str) -> str:
    """Strip a markdown fence wrapping the entire response, if present."""
    stripped = text.strip()
    m = _WHOLE_FENCE_RE.match(stripped)
    if m:
        return m.group(1).strip()
    return stripped


def load_draft_prompt(prompts_dir: Path, mode: str) -> str:
    """Load prompts/draft.md or prompts/revise.md."""
    if mode not in ("draft", "revise"):
        raise ValueError(f"Unknown drafting mode '{mode}' (expected draft|revise)")
    path = prompts_dir / f"{mode}.md"
    if not path.exists():
        raise FileNotFoundError(f"Drafting prompt not found: {path}")
    return path.read_text(encoding="utf-8")


def build_draft_messages(
    *,
    system_prompt: str,
    draft_prompt: str,
    documents: list[Document],
    brief: str | None = None,
    previous_script: str | None = None,
    synthesis: Any | None = None,
) -> list[dict[str, str]]:
    """Build the message list for a draft or revise call.

    Layout: system prompt (hardened), then user content with the drafting
    instructions, the brief (draft mode), the previous script plus synthesis
    findings (revise mode), and the routed context documents.
    """
    parts: list[str] = ["DRAFTING INSTRUCTIONS:\n" + draft_prompt]

    if brief:
        parts.append("BRIEF:\n" + brief)

    if previous_script is not None:
        parts.append("PREVIOUS DRAFT (revise this):\n" + previous_script)

    if synthesis is not None:
        synthesis_json = json.dumps(
            synthesis.model_dump(), indent=2, ensure_ascii=False,
        )
        parts.append(
            "REVIEW SYNTHESIS (address the ranked fixes and consensus "
            "weaknesses; blocking findings are non-negotiable):\n"
            + synthesis_json
        )

    if documents:
        parts.append("REFERENCE DOCUMENTS:")
        for doc in documents:
            parts.append(
                f'<document name="{doc.name}">\n'
                f"DOCUMENT: {doc.name}\nROLE: {doc.role}\n"
                + "-" * 40 + "\n" + doc.content + "\n</document>"
            )

    parts.append(
        "Respond with ONLY the full text of the new draft. No commentary, "
        "no preamble, no markdown fences around the whole document."
    )

    return [
        {"role": "system", "content": harden_system_prompt(system_prompt)},
        {"role": "user", "content": DOC_DELIMITER.join(parts)},
    ]


async def run_draft(
    *,
    config: Any,
    system_prompt: str,
    prompts_dir: Path,
    mode: str,
    documents: list[Document],
    brief: str | None = None,
    previous_script: str | None = None,
    synthesis: Any | None = None,
    cost_tracker: CostTracker | None = None,
) -> str | None:
    """Execute one draft or revise call. Returns the new primary text or None.

    Failures become None (the loop surfaces them), never crashes.
    """
    if config.models.drafter is None:
        logger.error("No drafter model configured (models.drafter) — cannot %s", mode)
        return None

    start = time.monotonic()
    draft_prompt = load_draft_prompt(prompts_dir, mode)
    messages = build_draft_messages(
        system_prompt=system_prompt,
        draft_prompt=draft_prompt,
        documents=documents,
        brief=brief,
        previous_script=previous_script,
        synthesis=synthesis,
    )

    tracker = cost_tracker or CostTracker()
    drafter = config.models.drafter
    try:
        async with OpenRouterClient(
            max_concurrency=1,
            timeout_seconds=config.pipeline.timeout_seconds,
            retry_attempts=config.pipeline.retry_attempts,
            cost_tracker=tracker,
        ) as client:
            response = await client.chat(
                model=drafter.id,
                messages=messages,
                temperature=drafter.temperature,
                json_mode=False,
            )
            content = client.get_content(response)
    except OpenRouterError as exc:
        logger.error("%s call failed: %s", mode, exc)
        return None

    text = _strip_whole_fence(content or "")
    if not text:
        logger.error("%s call returned empty content", mode)
        return None

    latency = round(time.monotonic() - start, 3)
    logger.info(
        "%s complete | model=%s chars=%d latency=%.1fs cost=$%.4f",
        mode, drafter.id, len(text), latency, tracker.total_usd,
    )
    return text
