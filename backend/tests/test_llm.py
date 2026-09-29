import copy

import pytest

from app.config import load_settings, model_supports_compaction
from app.db import short_title
from app.llm import (
    TITLE_INPUT_CHARS,
    TITLE_INSTRUCTION,
    TITLE_MAX_CHARS,
    TITLE_MAX_TOKENS,
    TITLE_MODEL,
    compaction_instructions,
    history_has_compaction,
    suggest_title,
    to_api_messages,
)


def message(role, text, id="m"):
    return {
        "id": id,
        "parent_id": None,
        "role": role,
        "content": [{"type": "text", "text": text}],
        "thread_id": "center",
        "created_at": "2026-01-01T00:00:00+00:00",
    }


def test_single_message_has_one_breakpoint_and_is_not_mutated():
    original = message("user", "Hello")
    snapshot = copy.deepcopy(original)
    api = to_api_messages([original], "5m")
    assert api == [
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": "Hello",
                    "cache_control": {"type": "ephemeral", "ttl": "5m"},
                }
            ],
        }
    ]
    assert original == snapshot


def test_breakpoint_sits_on_the_inherited_message_and_the_new_turn():
    path = [
        message("user", "Goal", "u1"),
        message("assistant", "Plan", "a1"),
        message("user", "Tangent", "s1"),
    ]
    api = to_api_messages(path, "1h")
    assert "cache_control" not in api[0]["content"][0]
    assert api[1]["content"][0]["cache_control"] == {"type": "ephemeral", "ttl": "1h"}
    assert api[2]["content"][0]["cache_control"] == {"type": "ephemeral", "ttl": "1h"}


def test_consecutive_user_turns_are_merged_and_blocks_pass_through():
    note = message("user", "From side node: suppliers are local.", "note")
    note["content"] = [{"type": "text", "text": "From side node: suppliers are local."}]
    follow = message("user", "Use the first one.", "u")
    path = [
        message("user", "Goal", "u1"),
        message("assistant", "Plan", "a1"),
        note,
        follow,
    ]
    api = to_api_messages(path, "5m")
    assert [item["role"] for item in api] == ["user", "assistant", "user"]
    merged = api[-1]["content"]
    assert [block["text"] for block in merged] == [
        "From side node: suppliers are local.",
        "Use the first one.",
    ]
    # The note is the end of the inherited path, so it keeps its breakpoint
    # after the two user turns are concatenated.
    assert merged[0]["cache_control"] == {"type": "ephemeral", "ttl": "5m"}
    assert merged[1]["cache_control"] == {"type": "ephemeral", "ttl": "5m"}


def test_compaction_blocks_are_sent_unchanged_apart_from_the_breakpoint():
    checkpoint = {
        "id": "a2",
        "parent_id": "u1",
        "role": "assistant",
        "content": [
            {"type": "compaction", "content": "Earlier discussion."},
            {"type": "text", "text": "Continuing."},
        ],
        "thread_id": "center",
        "created_at": "2026-01-01T00:00:00+00:00",
    }
    follow = message("user", "Next question", "u2")
    snapshot = copy.deepcopy(checkpoint)
    api = to_api_messages([checkpoint, follow], "5m")
    assert api[0]["content"][0] == {"type": "compaction", "content": "Earlier discussion."}
    assert api[0]["content"][1]["type"] == "text"
    assert api[0]["content"][1]["cache_control"] == {"type": "ephemeral", "ttl": "5m"}
    assert checkpoint == snapshot
    assert history_has_compaction([checkpoint, follow])


def test_compaction_instructions_restate_the_goal():
    text = compaction_instructions("Keep the center node on propylene glycol.")
    assert "<summary>" in text
    assert "Do not call any tools" in text
    assert "Keep the center node on propylene glycol." in text
    assert "no pinned goal" in compaction_instructions("  ")


def test_model_support_list_includes_current_5_5_models():
    assert model_supports_compaction("claude-sonnet-5-5")
    assert model_supports_compaction("claude-opus-5-5")
    assert model_supports_compaction("claude-sonnet-5-5-20260928")
    assert model_supports_compaction("claude-sonnet-5")
    assert model_supports_compaction("claude-opus-5")
    assert not model_supports_compaction("claude-haiku-4-5")


class _Block:
    def __init__(self, text: str):
        self.text = text

    def model_dump(self, exclude_none=True):
        return {"type": "text", "text": self.text}


class _Messages:
    def __init__(self, text: str = "", error: Exception | None = None):
        self.text = text
        self.error = error
        self.kwargs = None

    def create(self, **kwargs):
        self.kwargs = kwargs
        if self.error is not None:
            raise self.error
        return type("Response", (), {"content": [_Block(self.text)]})()


class _Client:
    def __init__(self, messages: _Messages):
        self.messages = messages


def test_suggest_title_sends_a_short_haiku_prompt(monkeypatch):
    messages = _Messages(text='"Onboarding email rewrite"')
    monkeypatch.setattr("app.llm.require_config", lambda: None)
    monkeypatch.setattr("app.llm._client", lambda: _Client(messages))
    opening = "Please  \n rewrite the onboarding email. " + ("detail " * 80)
    assert suggest_title(opening) == "Onboarding email rewrite"
    prompt = messages.kwargs["messages"][0]["content"]
    excerpt = " ".join(opening.split())[:TITLE_INPUT_CHARS].rstrip()
    assert messages.kwargs["model"] == TITLE_MODEL
    assert messages.kwargs["max_tokens"] == TITLE_MAX_TOKENS
    assert "stop_sequences" not in messages.kwargs
    assert "system" not in messages.kwargs
    assert prompt == f"{TITLE_INSTRUCTION}\n\n{excerpt}"
    assert len(excerpt) <= TITLE_INPUT_CHARS
    assert "detail detail" in excerpt


def test_suggest_title_strips_a_markdown_heading(monkeypatch):
    messages = _Messages(text="# Acetone Smell in Sourdough Starter")
    monkeypatch.setattr("app.llm.require_config", lambda: None)
    monkeypatch.setattr("app.llm._client", lambda: _Client(messages))
    assert suggest_title("why does it smell") == "Acetone Smell in Sourdough Starter"


def test_suggest_title_rejects_a_cut_off_reply(monkeypatch):
    class _Cut:
        stop_reason = "max_tokens"
        content = [_Block("Hamdi Ulukaya: Chobani Founder and")]

    class _CuttingMessages(_Messages):
        def create(self, **kwargs):
            self.kwargs = kwargs
            return _Cut()

    monkeypatch.setattr("app.llm.require_config", lambda: None)
    monkeypatch.setattr("app.llm._client", lambda: _Client(_CuttingMessages()))
    opening = "tell me about hamdi ulukaya"
    assert suggest_title(opening) == short_title(opening)


def test_suggest_title_caps_a_long_reply(monkeypatch):
    messages = _Messages(text="a" * 80)
    monkeypatch.setattr("app.llm.require_config", lambda: None)
    monkeypatch.setattr("app.llm._client", lambda: _Client(messages))
    assert suggest_title("hello") == "a" * TITLE_MAX_CHARS


def test_suggest_title_falls_back_when_the_call_fails_or_is_empty(monkeypatch):
    monkeypatch.setattr("app.llm.require_config", lambda: None)
    failed = _Messages(error=RuntimeError("down"))
    monkeypatch.setattr("app.llm._client", lambda: _Client(failed))
    opening = "Please help me rewrite the onboarding email for new hires today"
    assert suggest_title(opening) == short_title(opening)

    empty = _Messages(text="  \n  ")
    monkeypatch.setattr("app.llm._client", lambda: _Client(empty))
    assert suggest_title(opening) == short_title(opening)

    quoted_blank = _Messages(text='"   "')
    monkeypatch.setattr("app.llm._client", lambda: _Client(quoted_blank))
    assert suggest_title(opening) == short_title(opening)


def test_cache_ttl_must_be_5m_or_1h(monkeypatch):
    monkeypatch.setenv("CACHE_TTL", "10m")
    with pytest.raises(RuntimeError, match="CACHE_TTL"):
        load_settings()


def test_compact_trigger_rejects_values_under_the_api_minimum(monkeypatch):
    monkeypatch.setenv("COMPACT_TRIGGER_TOKENS", "49999")
    with pytest.raises(RuntimeError, match="50000"):
        load_settings()
