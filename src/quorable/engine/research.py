"""Research subcommand with SerpAPI (§6, Issue #15).

Bounded tool-use loop (max 10 iterations) where the LLM can call
serp_search and fetch_url to research legal questions. This is the
only place iterative tool use is allowed in the pipeline.
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

from quorable.engine.client import CostTracker, OpenRouterClient

logger = logging.getLogger(__name__)

MAX_ITERATIONS = 10
SERPAPI_BASE = "https://serpapi.com/search"

# Tool definitions exposed to the model
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "serp_search",
            "description": (
                "Search the web using Google or Google Scholar. "
                "Use google_scholar for case law and legal research. "
                "Use google for general legal resources."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search query",
                    },
                    "engine": {
                        "type": "string",
                        "enum": ["google_scholar", "google"],
                        "description": "Search engine to use",
                    },
                },
                "required": ["query", "engine"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "fetch_url",
            "description": (
                "Fetch the text content of a URL. Use to retrieve full case "
                "text, legal articles, or other web resources."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "The URL to fetch",
                    },
                },
                "required": ["url"],
            },
        },
    },
]


async def _serp_search(
    query: str,
    engine: str,
    http_client: httpx.AsyncClient,
) -> str:
    """Execute a SerpAPI search and return formatted results."""
    api_key = os.environ.get("SERPAPI_KEY")
    if not api_key:
        return "Error: SERPAPI_KEY environment variable not set."

    params: dict[str, str] = {
        "q": query,
        "api_key": api_key,
        "output": "json",
    }

    if engine == "google_scholar":
        params["engine"] = "google_scholar"
    else:
        params["engine"] = "google"

    try:
        resp = await http_client.get(SERPAPI_BASE, params=params, timeout=30)
        resp.raise_for_status()
        data = resp.json()
    except httpx.HTTPError as exc:
        logger.error("SerpAPI request failed: %s", exc)
        return f"Search failed: {exc}"

    # Format results
    results: list[str] = []

    if engine == "google_scholar":
        for item in data.get("organic_results", [])[:10]:
            title = item.get("title", "No title")
            snippet = item.get("snippet", "")
            link = item.get("link", "")
            pub_info = item.get("publication_info", {}).get("summary", "")
            results.append(
                f"Title: {title}\n"
                f"Publication: {pub_info}\n"
                f"Snippet: {snippet}\n"
                f"Link: {link}\n"
            )
    else:
        for item in data.get("organic_results", [])[:10]:
            title = item.get("title", "No title")
            snippet = item.get("snippet", "")
            link = item.get("link", "")
            results.append(
                f"Title: {title}\n"
                f"Snippet: {snippet}\n"
                f"Link: {link}\n"
            )

    if not results:
        return "No results found."

    return "\n---\n".join(results)


async def _fetch_url(url: str, http_client: httpx.AsyncClient) -> str:
    """Fetch and return the text content of a URL, truncated to 50K chars."""
    try:
        resp = await http_client.get(url, timeout=30, follow_redirects=True)
        resp.raise_for_status()
        text = resp.text
        if len(text) > 50_000:
            text = text[:50_000] + "\n\n[Content truncated at 50,000 characters]"
        return text
    except httpx.HTTPError as exc:
        logger.error("URL fetch failed for %s: %s", url, exc)
        return f"Failed to fetch URL: {exc}"


async def _execute_tool_call(
    name: str,
    arguments: dict[str, Any],
    http_client: httpx.AsyncClient,
) -> str:
    """Dispatch a tool call to the appropriate handler."""
    if name == "serp_search":
        return await _serp_search(
            query=arguments["query"],
            engine=arguments.get("engine", "google"),
            http_client=http_client,
        )
    elif name == "fetch_url":
        return await _fetch_url(
            url=arguments["url"],
            http_client=http_client,
        )
    else:
        return f"Unknown tool: {name}"


def _load_research_prompt(prompts_dir: Path) -> str:
    """Load the research prompt from prompts/research.md."""
    path = prompts_dir / "research.md"
    if not path.exists():
        raise FileNotFoundError(f"Research prompt not found: {path}")
    return path.read_text(encoding="utf-8")


def _slugify(text: str) -> str:
    """Convert text to a filename-safe slug."""
    slug = text.lower().strip()
    slug = re.sub(r"[^\w\s-]", "", slug)
    slug = re.sub(r"[\s_]+", "_", slug)
    slug = re.sub(r"-+", "-", slug)
    return slug[:60]


def _flag_unverified_citations(report: str) -> str:
    """Append verification warnings to every research report.

    The per-status counts are informational; the standing footer is
    unconditional because "verified" in this report means MODEL-asserted
    verification — it never substitutes for a human check against the
    reporter text before the case enters the case law registry or a filing.
    """
    unverified_count = report.lower().count("unverified")
    partially_verified = report.lower().count("partially verified")

    footer = (
        "\n\n---\n"
        "**VERIFICATION NOTICE:** All verification statuses in this report "
        "are model-asserted. Before any citation or factual claim from this "
        "report is treated as VERIFIED, a human must confirm it against the "
        "original source.\n"
    )
    if unverified_count or partially_verified:
        footer += (
            f"\n**WARNING:** This report contains {unverified_count} "
            f"unverified and {partially_verified} partially verified "
            "citations. Do not rely on these without human verification.\n"
        )
    return report + footer


async def run_research(
    *,
    query: str,
    prompts_dir: Path,
    output_dir: Path,
    model: str,
    temperature: float = 0.2,
    cost_tracker: CostTracker | None = None,
    timeout_seconds: int = 300,
    retry_attempts: int = 3,
) -> Path:
    """Execute a research query using a bounded tool-use loop.

    The LLM can call serp_search and fetch_url up to MAX_ITERATIONS times
    to research the given legal question. Results are saved as a markdown
    file.
    """
    start = time.monotonic()
    tracker = cost_tracker or CostTracker()

    research_prompt = _load_research_prompt(prompts_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    logger.info("Starting research | query='%s' model=%s max_iterations=%d", query, model, MAX_ITERATIONS)

    # Initial messages
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": research_prompt},
        {"role": "user", "content": f"Research the following question:\n\n{query}"},
    ]

    async with OpenRouterClient(
        max_concurrency=1,
        timeout_seconds=timeout_seconds,
        retry_attempts=retry_attempts,
        cost_tracker=tracker,
    ) as client:
        async with httpx.AsyncClient() as http_client:
            final_content = ""
            for iteration in range(MAX_ITERATIONS):
                logger.info("Research iteration %d/%d", iteration + 1, MAX_ITERATIONS)

                # Call the model with tools available
                response = await client.chat(
                    model=model,
                    messages=messages,
                    temperature=temperature,
                    json_mode=False,  # Tool use doesn't use JSON mode
                    tools=TOOLS,
                )

                message = response["choices"][0]["message"]

                # Check for tool calls
                tool_calls = message.get("tool_calls", [])

                if not tool_calls:
                    # Model is done — it produced a final text response
                    final_content = message.get("content", "")
                    logger.info("Research complete after %d iterations", iteration + 1)
                    break

                # Process tool calls
                messages.append(message)

                for tool_call in tool_calls:
                    func = tool_call["function"]
                    tool_name = func["name"]
                    try:
                        tool_args = json.loads(func["arguments"])
                    except json.JSONDecodeError:
                        tool_args = {}

                    logger.info(
                        "Tool call: %s(%s)",
                        tool_name,
                        json.dumps(tool_args, ensure_ascii=False)[:200],
                    )

                    tool_result = await _execute_tool_call(
                        tool_name, tool_args, http_client,
                    )

                    messages.append({
                        "role": "tool",
                        "tool_call_id": tool_call["id"],
                        "content": tool_result[:20_000],  # Cap tool results
                    })
            else:
                # Loop exhausted — ask for final output
                logger.warning("Research hit max iterations (%d)", MAX_ITERATIONS)
                messages.append({
                    "role": "user",
                    "content": (
                        "You have reached the maximum number of search iterations. "
                        "Please produce your final research report now based on "
                        "what you have found so far."
                    ),
                })
                response = await client.chat(
                    model=model,
                    messages=messages,
                    temperature=temperature,
                    json_mode=False,
                )
                final_content = client.get_content(response)

    # Flag unverified citations
    report = _flag_unverified_citations(final_content)

    # Save to file
    date_str = datetime.now(timezone.utc).strftime("%Y%m%d")
    slug = _slugify(query)
    output_path = output_dir / f"{slug}_{date_str}.md"
    output_path.write_text(report, encoding="utf-8")

    latency = round(time.monotonic() - start, 3)
    logger.info(
        "Research saved to %s | latency=%.1fs cost=$%.4f",
        output_path, latency, tracker.total_usd,
    )

    return output_path
