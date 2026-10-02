"""Anthropic calls. Content blocks are stored raw and sent back unchanged.

Prompt caching: each chat request sets at most two explicit breakpoints
(`cache_control` on a content block), out of the four the API allows.

- One is on the last block of the inherited path that is not a thinking block: the message the new user
  turn attaches to. For the first message in a side node, that is the fork
  point, so sibling forks and the parent thread share the cached prefix.
- One is on the last block of the new user message, so the next turn in the
  same thread can read it back.

The cache expires. The default TTL is 5 minutes and is refreshed on each hit.
`CACHE_TTL=1h` uses the longer window; those writes cost 2x base input tokens.
Returning to the center node after more than 5 minutes is usually a cache miss
on the default TTL.

Nothing under the minimum cacheable prefix is cached, and the API does not
error: 512 tokens on the 5.x models, and 1024 to 4096 on older ones. The
lookback window is 20 blocks. Breakpoints are placed on a deep copy; stored
rows are never mutated.
"""

from __future__ import annotations

import copy
import json
import logging
import time
from collections.abc import Iterator
from typing import Any

import anthropic

from app.config import (
    EFFORT_LEVELS,
    HAIKU_THINKING_BUDGET,
    KEY_MISSING,
    MODEL_MISSING,
    get_settings,
    model_caps,
    model_supports_compaction,
    resolve_max_tokens,
)
from app.db import short_title
from app.rag import DOCS_INSTRUCTION

COMPACTION_BETA = "compact-2026-01-12"
WEB_SEARCH_TOOL_TYPE = "web_search_20260318"
WEB_FETCH_TOOL_TYPE = "web_fetch_20260318"
WEB_BLOCK_TYPES = ("server_tool_use", "web_search_tool_result", "web_fetch_tool_result")
WEB_TURN_INSTRUCTION = (
    "Web search and page fetch are available for this turn. "
    "If the question is about the present — a current team, role, price, score, law, "
    "or news — call web_search before you write any answer, then answer from the results. "
    "Do not say you already know, and do not offer to search instead of searching. "
    "Skip the web only when the conversation itself settles the question."
)
TITLE_MODEL = "claude-haiku-4-5"
TITLE_INPUT_CHARS = 400
TITLE_MAX_CHARS = 60
TITLE_MAX_TOKENS = 32
THINKING_BLOCK_TYPES = ("thinking", "redacted_thinking")
MAX_PAUSE_CONTINUATIONS = 5
TITLE_INSTRUCTION = (
    "Reply with only a 2-6 word title. One line. No quotes, no markdown. "
    "Name the topic. If a reply is included, the title must agree with that reply "
    "and must not state a fact the reply contradicts."
)
_TITLE_QUOTES = "\"'`“”‘’"

logger = logging.getLogger("tangents")


class LLMError(Exception):
    pass


def require_config() -> None:
    settings = get_settings()
    if not settings.api_key:
        raise LLMError(KEY_MISSING)


def resolve_model(override: str | None) -> str:
    """The header picker wins. ANTHROPIC_MODEL is only the fallback."""
    require_config()
    chosen = (override or "").strip() or (get_settings().model or "")
    if not chosen:
        raise LLMError(MODEL_MISSING)
    return chosen


def _cacheable_index(blocks: list) -> int | None:
    """The API rejects cache_control on thinking blocks."""
    for index in range(len(blocks) - 1, -1, -1):
        block = blocks[index]
        if isinstance(block, dict) and block.get("type") not in THINKING_BLOCK_TYPES:
            return index
    return None


def to_api_messages(path: list[dict], ttl: str) -> list[dict]:
    """Turn a get_context path into Anthropic message params.

    Stored content blocks are copied and sent unchanged, except for a
    cache_control breakpoint on the last block of the inherited message and
    the last block of the new user message that is not a thinking block.
    A message made only of thinking blocks gets no breakpoint. Consecutive
    same-role turns are concatenated.
    """
    if not path:
        return []

    breakpoint_indexes = {len(path) - 1}
    if len(path) >= 2:
        breakpoint_indexes.add(len(path) - 2)

    prepared: list[dict[str, Any]] = []
    for index, message in enumerate(path):
        blocks = copy.deepcopy(message["content"])
        if index in breakpoint_indexes and blocks:
            target = _cacheable_index(blocks)
            if target is not None:
                blocks[target] = {
                    **blocks[target],
                    "cache_control": {"type": "ephemeral", "ttl": ttl},
                }
        prepared.append({"role": message["role"], "content": blocks})

    merged: list[dict[str, Any]] = []
    for message in prepared:
        if merged and merged[-1]["role"] == message["role"]:
            merged[-1]["content"].extend(message["content"])
        else:
            merged.append({"role": message["role"], "content": list(message["content"])})
    return merged


def compaction_instructions(goal: str | None) -> str:
    """Custom summary prompt. This replaces the API's default prompt entirely."""
    if goal and goal.strip():
        goal_text = goal.strip()
    else:
        goal_text = "(no pinned goal set)"
    return (
        "Summarize the transcript inside <summary></summary> tags. "
        "Include the information needed to continue the task in the next context window. "
        "Do not call any tools while writing this summary; respond with text only. "
        f"The summary must restate the pinned root goal: {goal_text}"
    )


def history_has_compaction(path: list[dict]) -> bool:
    for message in path:
        for block in message["content"]:
            if isinstance(block, dict) and block.get("type") == "compaction":
                return True
    return False


def web_tools() -> list[dict[str, Any]]:
    """The two server tools. Anthropic runs these inside one assistant turn."""
    settings = get_settings()
    search: dict[str, Any] = {
        "type": WEB_SEARCH_TOOL_TYPE,
        "name": "web_search",
        "max_uses": settings.web_search_max_uses,
        # The SDK default includes code-execution callers. Haiku 4.5 rejects that
        # and is one of the header models, so every model is limited to direct calls.
        "allowed_callers": ["direct"],
    }
    if settings.web_search_blocked_domains:
        search["blocked_domains"] = list(settings.web_search_blocked_domains)
    fetch: dict[str, Any] = {
        "type": WEB_FETCH_TOOL_TYPE,
        "name": "web_fetch",
        "max_uses": settings.web_fetch_max_uses,
        "allowed_callers": ["direct"],
        "max_content_tokens": settings.web_fetch_max_content_tokens,
        "citations": {"enabled": True},
        # Fetchable URLs are only those the user pasted, or those web_search returned.
        # The API enforces this and returns url_not_in_prior_context otherwise, so the
        # model cannot fetch a URL it invented.
        "url_sources": {
            "user_input": {"type": "all"},
            "server_tool_results": {
                "type": "only",
                "tools": [{"type": "tool_reference", "name": "web_search"}],
            },
            "client_tool_results": {"type": "none"},
        },
    }
    return [search, fetch]


def history_has_web_blocks(path: list[dict]) -> bool:
    for message in path:
        for block in message["content"]:
            if isinstance(block, dict) and block.get("type") in WEB_BLOCK_TYPES:
                return True
    return False


def _attach_web_tools(kwargs: dict[str, Any], path: list[dict], web: bool) -> None:
    """Declare the web tools when this turn may search, or when the history needs them.

    Stored web blocks are replayed on every later turn, and a result block whose
    tool is not declared is rejected. tool_choice "none" keeps the toggle honest:
    the tools are declared so the history validates, but no new call is allowed.
    """
    if not web and not history_has_web_blocks(path):
        return
    kwargs["tools"] = web_tools()
    if not web:
        kwargs["tool_choice"] = {"type": "none"}


def _client() -> anthropic.Anthropic:
    settings = get_settings()
    return anthropic.Anthropic(api_key=settings.api_key)


def _dump_block(block: Any) -> dict:
    if hasattr(block, "model_dump"):
        # exclude_none: a plain dump adds null fields the API then rejects.
        return block.model_dump(exclude_none=True)
    if isinstance(block, dict):
        return {key: value for key, value in block.items() if value is not None}
    return dict(block)


def _dump_usage(usage: Any) -> dict:
    if hasattr(usage, "model_dump"):
        data = usage.model_dump(exclude_none=True)
    else:
        data = usage
    return json.loads(json.dumps(data, default=str))


def _use_beta(path: list[dict], compact: bool) -> bool:
    return compact or history_has_compaction(path)


def _web_activity(entry: dict[str, str]) -> dict:
    """One "searching for X" / "reading URL" event from a finished server_tool_use block."""
    raw = entry["json"].strip()
    try:
        data = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        data = {}
    if not isinstance(data, dict):
        data = {}
    return {
        "type": "web_activity",
        "tool": entry["name"],
        "query": str(data.get("query") or "").strip(),
        "url": str(data.get("url") or "").strip(),
    }


def _result_sources(block: Any) -> list[dict[str, str]]:
    """Title and url only. encrypted_content and page text never leave the server."""
    content = _dump_block(block).get("content")
    if isinstance(content, dict):
        content = [content]
    if not isinstance(content, list):
        return []
    sources: list[dict[str, str]] = []
    for item in content:
        if not isinstance(item, dict):
            continue
        url = item.get("url")
        if not url:
            continue
        sources.append({"title": str(item.get("title") or url), "url": str(url)})
    return sources


def thinking_params(model: str, effort: str | None, extended: bool) -> dict[str, Any]:
    """Request fields for the chosen model, matching the Claude app's model menu."""
    caps = model_caps(model)
    if caps is None:
        return {}
    if caps.thinking == "adaptive":
        level = effort if effort in EFFORT_LEVELS and effort in caps.efforts else caps.default_effort
        params: dict[str, Any] = {"thinking": {"type": "adaptive", "display": "summarized"}}
        if level:
            params["output_config"] = {"effort": level}
        return params
    if extended:
        return {"thinking": {"type": "enabled", "budget_tokens": HAIKU_THINKING_BUDGET}}
    return {}


def _merge_usage(usages: list[dict]) -> dict:
    """Add up a continued turn. The input dicts are not mutated."""
    if not usages:
        return {}
    if len(usages) == 1:
        return dict(usages[0])
    merged = dict(usages[-1])
    for key in (
        "input_tokens",
        "output_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
    ):
        merged[key] = sum(int(item.get(key) or 0) for item in usages)
    if any("server_tool_use" in item for item in usages):
        searches = 0
        fetches = 0
        for item in usages:
            tool = item.get("server_tool_use") or {}
            searches += int(tool.get("web_search_requests") or 0)
            fetches += int(tool.get("web_fetch_requests") or 0)
        merged["server_tool_use"] = {
            "web_search_requests": searches,
            "web_fetch_requests": fetches,
        }
    if any(
        isinstance(item.get("output_tokens_details"), dict)
        and "thinking_tokens" in item["output_tokens_details"]
        for item in usages
    ):
        thinking = 0
        for item in usages:
            details = item.get("output_tokens_details") or {}
            thinking += int(details.get("thinking_tokens") or 0)
        details = dict(merged.get("output_tokens_details") or {})
        details["thinking_tokens"] = thinking
        merged["output_tokens_details"] = details
    if any("iterations" in item for item in usages):
        iterations: list = []
        for item in usages:
            iterations.extend(item.get("iterations") or [])
        merged["iterations"] = iterations
    return merged


def _stream_round(kwargs: dict[str, Any], beta: bool, clock: dict) -> Iterator[dict]:
    """Stream one API request. The return value is the final message."""
    stream_cm = (
        _client().beta.messages.stream(**kwargs) if beta else _client().messages.stream(**kwargs)
    )
    with stream_cm as stream:
        pending: dict[int, dict[str, str]] = {}
        for event in stream:
            kind = getattr(event, "type", None)
            if kind == "content_block_start":
                block = event.content_block
                block_type = getattr(block, "type", None)
                if block_type == "server_tool_use":
                    pending[event.index] = {"name": getattr(block, "name", ""), "json": ""}
                elif block_type in ("web_search_tool_result", "web_fetch_tool_result"):
                    # Result blocks arrive whole, not as deltas.
                    yield {
                        "type": "web_result",
                        "tool": "web_search"
                        if block_type == "web_search_tool_result"
                        else "web_fetch",
                        "sources": _result_sources(block),
                    }
            elif kind == "content_block_delta":
                delta = event.delta
                delta_type = getattr(delta, "type", None)
                if delta_type == "text_delta":
                    if clock.get("thinking_started") is not None and clock.get("thinking_ended") is None:
                        clock["thinking_ended"] = time.monotonic()
                    yield {"type": "delta", "text": delta.text}
                elif delta_type == "thinking_delta":
                    text = getattr(delta, "thinking", "") or ""
                    if text:
                        if clock.get("thinking_started") is None:
                            clock["thinking_started"] = time.monotonic()
                        yield {"type": "thinking", "text": text}
                elif delta_type == "compaction_delta":
                    yield {"type": "compaction", "content": delta.content or ""}
                elif delta_type == "input_json_delta":
                    entry = pending.get(event.index)
                    if entry is not None:
                        entry["json"] += getattr(delta, "partial_json", "") or ""
            elif kind == "content_block_stop":
                entry = pending.pop(event.index, None)
                if entry is not None:
                    yield _web_activity(entry)
        return stream.get_final_message()


def stream_chat(
    path: list[dict],
    goal: str | None,
    model: str | None = None,
    web: bool = False,
    docs: bool = False,
    effort: str | None = None,
    extended_thinking: bool = False,
) -> Iterator[dict]:
    """Stream one assistant turn.

    Yields ``thinking`` and ``delta`` events, a ``compaction`` event when the
    API writes a summary, then ``done`` with the raw content blocks and usage.
    A ``pause_turn`` is continued inside this same turn. Threshold compaction
    is attached only when the model for this turn is on the supported list.
    Stored compaction blocks still go out on the beta endpoint so the API will
    accept them.
    """
    settings = get_settings()
    chosen = resolve_model(model)
    messages = to_api_messages(path, settings.cache_ttl)
    compact = model_supports_compaction(chosen)
    kwargs: dict[str, Any] = {
        "model": chosen,
        "max_tokens": resolve_max_tokens(chosen),
        "messages": messages,
    }
    _attach_web_tools(kwargs, path, web)
    instructions = []
    if web:
        instructions.append(WEB_TURN_INSTRUCTION)
    if docs:
        instructions.append(DOCS_INSTRUCTION)
    if instructions:
        kwargs["system"] = "\n\n".join(instructions)
    beta = _use_beta(path, compact)
    if beta:
        kwargs["betas"] = [COMPACTION_BETA]
        if compact:
            kwargs["context_management"] = {
                "edits": [
                    {
                        "type": "compact_20260112",
                        "trigger": {
                            "type": "input_tokens",
                            "value": settings.compact_trigger_tokens,
                        },
                        "instructions": compaction_instructions(goal),
                    }
                ]
            }
    kwargs.update(thinking_params(chosen, effort, extended_thinking))

    clock: dict = {}
    blocks: list[dict] = []
    usages: list[dict] = []
    stop_reason = None
    for _ in range(MAX_PAUSE_CONTINUATIONS + 1):
        final = yield from _stream_round(kwargs, beta, clock)
        blocks.extend(_dump_block(block) for block in final.content)
        usages.append(_dump_usage(final.usage))
        stop_reason = getattr(final, "stop_reason", None)
        if stop_reason != "pause_turn":
            break
        kwargs["messages"] = [*messages, {"role": "assistant", "content": copy.deepcopy(blocks)}]
    usage = _merge_usage(usages)
    usage["stop_reason"] = stop_reason
    started, ended = clock.get("thinking_started"), clock.get("thinking_ended")
    if started is not None:
        usage["thinking_ms"] = int(((ended or time.monotonic()) - started) * 1000)
    yield {"type": "done", "content": blocks, "usage": usage}


def title_excerpt(text: str) -> str:
    """Whitespace-collapsed prefix sent to the title model."""
    collapsed = " ".join(text.split())
    if len(collapsed) <= TITLE_INPUT_CHARS:
        return collapsed
    return collapsed[:TITLE_INPUT_CHARS].rstrip()


def sanitize_title(raw: str) -> str:
    """One line, quotes removed, capped so a long reply cannot become the name."""
    line = raw.split("\n", 1)[0]
    collapsed = " ".join(line.split()).strip()
    if len(collapsed) >= 2 and collapsed[0] in _TITLE_QUOTES and collapsed[-1] in _TITLE_QUOTES:
        collapsed = collapsed[1:-1].strip()
    collapsed = collapsed.lstrip("#").strip()
    if len(collapsed) > TITLE_MAX_CHARS:
        collapsed = collapsed[:TITLE_MAX_CHARS].rstrip()
    return collapsed


def suggest_title(user_text: str, reply_text: str = "") -> str:
    """A short node name from the first user message and, when present, the reply.

    Uses Haiku on a truncated slice. A failed or empty call falls back to
    short_title so the chat turn still gets a name. The reply is included so a
    searched answer cannot be contradicted by a name chosen from memory.
    """
    try:
        raw = _fetch_title(user_text, reply_text)
    except LLMError as exc:
        logger.warning("title call failed: %s", exc)
        return short_title(user_text)
    title = sanitize_title(raw)
    if not title:
        logger.warning("title call returned nothing usable")
        return short_title(user_text)
    return title


def _fetch_title(user_text: str, reply_text: str = "") -> str:
    require_config()
    prompt = f"{TITLE_INSTRUCTION}\n\n{title_excerpt(user_text)}"
    reply = title_excerpt(reply_text) if reply_text.strip() else ""
    if reply:
        prompt = f"{prompt}\n\nReply:\n{reply}"
    try:
        # A newline stop is rejected: each stop sequence must contain non-whitespace.
        # max_tokens only guards a runaway reply. A reply that hits the cap is
        # unfinished, so it is discarded instead of saved as a partial title.
        response = _client().messages.create(
            model=TITLE_MODEL,
            max_tokens=TITLE_MAX_TOKENS,
            messages=[{"role": "user", "content": prompt}],
        )
    except LLMError:
        raise
    except Exception as exc:
        raise LLMError(str(exc)) from exc

    if getattr(response, "stop_reason", None) == "max_tokens":
        raise LLMError("title was cut off")

    parts = []
    for block in response.content:
        dumped = _dump_block(block)
        if dumped.get("type") == "text" and dumped.get("text"):
            parts.append(dumped["text"])
    return "\n".join(parts).strip()
