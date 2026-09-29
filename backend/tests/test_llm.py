import copy

import pytest

from app.config import load_settings, model_supports_compaction
from app.llm import compaction_instructions, history_has_compaction, to_api_messages


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


def test_cache_ttl_must_be_5m_or_1h(monkeypatch):
    monkeypatch.setenv("CACHE_TTL", "10m")
    with pytest.raises(RuntimeError, match="CACHE_TTL"):
        load_settings()


def test_compact_trigger_rejects_values_under_the_api_minimum(monkeypatch):
    monkeypatch.setenv("COMPACT_TRIGGER_TOKENS", "49999")
    with pytest.raises(RuntimeError, match="50000"):
        load_settings()
