"""Anthropic calls. Content blocks are stored raw and sent back unchanged.

Prompt caching: each chat request sets at most two explicit breakpoints
(`cache_control` on a content block), out of the four the API allows.

- One is on the last block of the inherited path: the message the new user
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
from collections.abc import Iterator
from typing import Any

import anthropic

from app.config import KEY_MISSING, MODEL_MISSING, get_settings, model_supports_compaction
from app.db import short_title

COMPACTION_BETA = "compact-2026-01-12"
TITLE_MODEL = "claude-haiku-4-5"
TITLE_INPUT_CHARS = 400
TITLE_MAX_CHARS = 60
TITLE_MAX_TOKENS = 32
TITLE_INSTRUCTION = "Reply with only a 2-6 word title. One line. No quotes, no markdown."
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


def to_api_messages(path: list[dict], ttl: str) -> list[dict]:
    """Turn a get_context path into Anthropic message params.

    Stored content blocks are copied and sent unchanged, except for a
    cache_control breakpoint on the last block of the inherited message and
    the last block of the new user message. Consecutive same-role turns
    (a merge note followed by a user message) are concatenated.
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
            blocks[-1] = {
                **blocks[-1],
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


def stream_chat(path: list[dict], goal: str | None, model: str | None = None) -> Iterator[dict]:
    """Stream one assistant turn.

    Yields ``delta`` events, a ``compaction`` event when the API writes a
    summary, then ``done`` with the raw content blocks and usage.
    Threshold compaction is attached only when the model for this turn is on
    the supported list. Stored compaction blocks still go out on the beta
    endpoint so the API will accept them.
    """
    settings = get_settings()
    chosen = resolve_model(model)
    messages = to_api_messages(path, settings.cache_ttl)
    compact = model_supports_compaction(chosen)
    kwargs: dict[str, Any] = {
        "model": chosen,
        "max_tokens": settings.max_tokens,
        "messages": messages,
    }
    if _use_beta(path, compact):
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
        stream_cm = _client().beta.messages.stream(**kwargs)
    else:
        stream_cm = _client().messages.stream(**kwargs)

    with stream_cm as stream:
        for event in stream:
            if getattr(event, "type", None) != "content_block_delta":
                continue
            delta = event.delta
            delta_type = getattr(delta, "type", None)
            if delta_type == "text_delta":
                yield {"type": "delta", "text": delta.text}
            elif delta_type == "compaction_delta":
                yield {"type": "compaction", "content": delta.content or ""}
        final = stream.get_final_message()
        yield {
            "type": "done",
            "content": [_dump_block(block) for block in final.content],
            "usage": _dump_usage(final.usage),
        }


def summarize_side_node(path: list[dict], model: str | None = None) -> str:
    """One non-streaming call. Nothing is saved. Compaction is not enabled."""
    settings = get_settings()
    chosen = resolve_model(model)
    messages = to_api_messages(path, settings.cache_ttl)
    instruction = {
        "type": "text",
        "text": (
            "Summarize what this side node added, beyond the conversation it "
            "forked from, in 1-3 sentences. Reply with only the summary."
        ),
    }
    if messages and messages[-1]["role"] == "user":
        messages[-1]["content"].append(instruction)
    else:
        messages.append({"role": "user", "content": [instruction]})

    kwargs: dict[str, Any] = {
        "model": chosen,
        "max_tokens": min(settings.max_tokens, 512),
        "messages": messages,
    }
    client = _client()
    if _use_beta(path, False):
        kwargs["betas"] = [COMPACTION_BETA]
        response = client.beta.messages.create(**kwargs)
    else:
        response = client.messages.create(**kwargs)

    parts = []
    for block in response.content:
        dumped = _dump_block(block)
        if dumped.get("type") == "text" and dumped.get("text"):
            parts.append(dumped["text"])
    summary = "\n".join(parts).strip()
    if not summary:
        raise LLMError("The summary came back empty")
    return summary


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


def suggest_title(user_text: str) -> str:
    """A short node name from the first user message.

    Uses Haiku on a truncated slice. A failed or empty call falls back to
    short_title so the chat turn still gets a name.
    """
    try:
        raw = _fetch_title(user_text)
    except LLMError as exc:
        logger.warning("title call failed: %s", exc)
        return short_title(user_text)
    title = sanitize_title(raw)
    if not title:
        logger.warning("title call returned nothing usable")
        return short_title(user_text)
    return title


def _fetch_title(user_text: str) -> str:
    require_config()
    prompt = f"{TITLE_INSTRUCTION}\n\n{title_excerpt(user_text)}"
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
