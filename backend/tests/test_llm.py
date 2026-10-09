import copy

import pytest

from app.config import load_settings, model_supports_compaction, resolve_max_tokens
from app.db import short_title
from app.rag import DOCS_INSTRUCTION
from app.llm import (
    TITLE_INPUT_CHARS,
    TITLE_INSTRUCTION,
    TITLE_MAX_CHARS,
    TITLE_MAX_TOKENS,
    TITLE_MODEL,
    SKETCH_INSTRUCTION,
    SKETCH_MAX_TOKENS,
    WEB_BLOCK_TYPES,
    WEB_FETCH_TOOL_TYPE,
    WEB_SEARCH_TOOL_TYPE,
    CHARTS_INSTRUCTION,
    WEB_TURN_INSTRUCTION,
    _attach_web_tools,
    _result_sources,
    _web_activity,
    attach_learning_map,
    compaction_instructions,
    history_has_compaction,
    history_has_web_blocks,
    stream_chat,
    strip_chart_blocks,
    suggest_sketch,
    suggest_title,
    thinking_params,
    to_api_messages,
    web_tools,
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
    assert "tools" not in messages.kwargs
    assert prompt == f"{TITLE_INSTRUCTION}\n\n{excerpt}"
    assert len(excerpt) <= TITLE_INPUT_CHARS
    assert "detail detail" in excerpt


def test_suggest_title_includes_the_reply_so_the_name_agrees_with_it(monkeypatch):
    messages = _Messages(text="LeBron joins the 76ers")
    monkeypatch.setattr("app.llm.require_config", lambda: None)
    monkeypatch.setattr("app.llm._client", lambda: _Client(messages))
    reply = "LeBron James plays for the Philadelphia 76ers."
    assert suggest_title("what team does lebron play for rn", reply) == "LeBron joins the 76ers"
    prompt = messages.kwargs["messages"][0]["content"]
    assert "Reply:\n" in prompt
    assert "Philadelphia 76ers" in prompt
    assert "must not state a fact the reply contradicts" in prompt
    assert "tools" not in messages.kwargs


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


def test_suggest_sketch_sends_a_short_haiku_prompt(monkeypatch):
    messages = _Messages(text='"Working through the main argument."')
    monkeypatch.setattr("app.llm.require_config", lambda: None)
    monkeypatch.setattr("app.llm._client", lambda: _Client(messages))
    user = "Please  \n walk me through the proof. " + ("detail " * 80)
    reply = "Here is the first step. " + ("more " * 80)
    chart_reply = (
        reply
        + '\n```plotly\n{"data":[{"y":[1]}],"layout":{}}\n```\n'
        + "That is the trend."
    )
    assert (
        suggest_sketch("Center", "Earlier work on limits.", user, chart_reply)
        == "Working through the main argument."
    )
    prompt = messages.kwargs["messages"][0]["content"]
    user_excerpt = " ".join(user.split())[:TITLE_INPUT_CHARS].rstrip()
    assert messages.kwargs["model"] == TITLE_MODEL
    assert messages.kwargs["max_tokens"] == SKETCH_MAX_TOKENS
    assert "stop_sequences" not in messages.kwargs
    assert "system" not in messages.kwargs
    assert "tools" not in messages.kwargs
    assert prompt.startswith(f"{SKETCH_INSTRUCTION}\n\n")
    assert "Node title: Center" in prompt
    assert "Previous sketch:\nEarlier work on limits." in prompt
    assert f"Latest user message:\n{user_excerpt}" in prompt
    assert "```plotly" not in prompt
    assert '"y":[1]' not in prompt
    assert len(user_excerpt) <= TITLE_INPUT_CHARS


def test_suggest_sketch_returns_none_on_failure_empty_or_cutoff(monkeypatch):
    monkeypatch.setattr("app.llm.require_config", lambda: None)
    unused = _Messages(text="should not be used")
    monkeypatch.setattr("app.llm._client", lambda: _Client(unused))
    assert suggest_sketch("Center", None, "hello", "") is None
    assert unused.kwargs is None
    assert suggest_sketch("Center", None, "hello", "```plotly\n{}\n```") is None
    assert unused.kwargs is None

    failed = _Messages(error=RuntimeError("down"))
    monkeypatch.setattr("app.llm._client", lambda: _Client(failed))
    assert suggest_sketch("Center", None, "hello", "ok") is None

    empty = _Messages(text="  \n  ")
    monkeypatch.setattr("app.llm._client", lambda: _Client(empty))
    assert suggest_sketch("Center", None, "hello", "ok") is None

    class _Cut:
        stop_reason = "max_tokens"
        content = [_Block("Working through the main")]

    class _CuttingMessages(_Messages):
        def create(self, **kwargs):
            self.kwargs = kwargs
            return _Cut()

    monkeypatch.setattr("app.llm._client", lambda: _Client(_CuttingMessages()))
    assert suggest_sketch("Center", None, "hello", "ok") is None


def test_attach_learning_map_prepends_without_cache_or_mutation():
    original = message("user", "Hello")
    snapshot = copy.deepcopy(original)
    api = to_api_messages([original], "5m")
    attach_learning_map(api, "MAP")
    assert api[-1]["content"][0] == {"type": "text", "text": "MAP"}
    assert "cache_control" not in api[-1]["content"][0]
    assert api[-1]["content"][1]["cache_control"] == {"type": "ephemeral", "ttl": "5m"}
    assert original == snapshot

    blank = to_api_messages([message("user", "Hello")], "5m")
    before = copy.deepcopy(blank)
    attach_learning_map(blank, "   ")
    assert blank == before
    attach_learning_map(blank, None)
    assert blank == before
    attach_learning_map([], "MAP")


def test_cache_ttl_must_be_5m_or_1h(monkeypatch):
    monkeypatch.setenv("CACHE_TTL", "10m")
    with pytest.raises(RuntimeError, match="CACHE_TTL"):
        load_settings()


def test_compact_trigger_rejects_values_under_the_api_minimum(monkeypatch):
    monkeypatch.setenv("COMPACT_TRIGGER_TOKENS", "49999")
    with pytest.raises(RuntimeError, match="50000"):
        load_settings()


def test_web_tools_limit_fetch_to_user_and_search_urls():
    tools = web_tools()
    assert [tool["type"] for tool in tools] == [WEB_SEARCH_TOOL_TYPE, WEB_FETCH_TOOL_TYPE]
    assert tools[0]["allowed_callers"] == ["direct"]
    assert tools[1]["allowed_callers"] == ["direct"]
    sources = tools[1]["url_sources"]
    assert sources["user_input"] == {"type": "all"}
    assert sources["client_tool_results"] == {"type": "none"}
    assert sources["server_tool_results"]["type"] == "only"
    assert sources["server_tool_results"]["tools"] == [
        {"type": "tool_reference", "name": "web_search"}
    ]


def test_history_has_web_blocks_finds_each_block_type():
    for block_type in WEB_BLOCK_TYPES:
        path = [message("assistant", "x")]
        path[0]["content"] = [{"type": block_type}]
        assert history_has_web_blocks(path)
    assert not history_has_web_blocks([message("user", "plain")])


def test_web_tools_are_declared_with_tool_choice_none_when_the_toggle_is_off():
    searched = [
        {
            "role": "assistant",
            "content": [{"type": "web_search_tool_result", "content": [], "tool_use_id": "t"}],
        }
    ]
    plain = [message("user", "hello")]

    kept = {}
    _attach_web_tools(kept, searched, False)
    assert "tools" in kept
    assert kept["tool_choice"] == {"type": "none"}

    allowed = {}
    _attach_web_tools(allowed, searched, True)
    assert "tools" in allowed
    assert "tool_choice" not in allowed

    quiet = {}
    _attach_web_tools(quiet, plain, False)
    assert "tools" not in quiet
    assert "tool_choice" not in quiet


def test_result_sources_drop_encrypted_content():
    block = {
        "type": "web_search_tool_result",
        "content": [
            {
                "type": "web_search_result",
                "title": "Docs",
                "url": "https://example.com",
                "encrypted_content": "secret",
            }
        ],
    }
    assert _result_sources(block) == [{"title": "Docs", "url": "https://example.com"}]


def test_web_turn_tells_the_model_to_look_up_current_facts(monkeypatch):
    class _Final:
        content = []

        class usage:
            @staticmethod
            def model_dump(exclude_none=True):
                return {}

    class _Stream:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def __iter__(self):
            return iter([])

        def get_final_message(self):
            return _Final()

    class _Messages:
        def __init__(self):
            self.kwargs = None

        def stream(self, **kwargs):
            self.kwargs = kwargs
            return _Stream()

    messages = _Messages()
    monkeypatch.setattr("app.llm.require_config", lambda: None)
    monkeypatch.setattr("app.llm._client", lambda: type("Client", (), {"messages": messages})())
    path = [message("user", "what team does lebron play for?")]
    list(stream_chat(path, None, "claude-haiku-4-5", web=True))
    assert messages.kwargs["system"] == WEB_TURN_INSTRUCTION
    assert "tool_choice" not in messages.kwargs
    assert "tools" in messages.kwargs

    list(stream_chat(path, None, "claude-haiku-4-5", web=False))
    assert "system" not in messages.kwargs
    assert "tools" not in messages.kwargs

    list(stream_chat(path, None, "claude-haiku-4-5", docs=True))
    assert messages.kwargs["system"] == DOCS_INSTRUCTION
    assert "tools" not in messages.kwargs

    list(stream_chat(path, None, "claude-haiku-4-5", web=True, docs=True))
    assert messages.kwargs["system"] == f"{WEB_TURN_INSTRUCTION}\n\n{DOCS_INSTRUCTION}"

    list(stream_chat(path, None, "claude-haiku-4-5", charts=True))
    assert messages.kwargs["system"] == CHARTS_INSTRUCTION
    assert "tools" not in messages.kwargs

    list(stream_chat(path, None, "claude-haiku-4-5", web=True, docs=True, charts=True))
    assert (
        messages.kwargs["system"]
        == f"{WEB_TURN_INSTRUCTION}\n\n{DOCS_INSTRUCTION}\n\n{CHARTS_INSTRUCTION}"
    )

    list(stream_chat(path, None, "claude-haiku-4-5", learning_map="MAP"))
    assert messages.kwargs["messages"][-1]["content"][0] == {"type": "text", "text": "MAP"}
    assert "cache_control" not in messages.kwargs["messages"][-1]["content"][0]
    assert "system" not in messages.kwargs

    list(stream_chat(path, None, "claude-haiku-4-5"))
    assert messages.kwargs["messages"][-1]["content"][0]["text"] == path[0]["content"][0]["text"]
    assert "system" not in messages.kwargs


def test_strip_chart_blocks_removes_closed_and_unclosed_blocks():
    closed = 'Sales rose.\n\n```plotly\n{"data":[]}\n```\nThat is the trend.'
    assert strip_chart_blocks(closed) == "Sales rose.\n\n \nThat is the trend."
    unclosed = 'Sales rose.\n```plotly\n{"data":['
    assert strip_chart_blocks(unclosed) == "Sales rose.\n "
    python = "```python\nprint(1)\n```"
    assert strip_chart_blocks(python) == python


def test_suggest_title_ignores_chart_json(monkeypatch):
    messages = _Messages(text="LeBron joins the 76ers")
    monkeypatch.setattr("app.llm.require_config", lambda: None)
    monkeypatch.setattr("app.llm._client", lambda: _Client(messages))
    reply = 'Sales rose.\n\n```plotly\n{"data":[]}\n```'
    assert suggest_title("what team does lebron play for rn", reply) == "LeBron joins the 76ers"
    prompt = messages.kwargs["messages"][0]["content"]
    assert "Sales rose." in prompt
    assert '"data"' not in prompt


def test_breakpoint_skips_a_trailing_thinking_block():
    original = {
        **message("assistant", "", id="a"),
        "content": [
            {"type": "server_tool_use", "name": "web_search"},
            {"type": "web_search_tool_result", "content": []},
            {"type": "thinking", "thinking": "", "signature": "sig"},
        ],
    }
    snapshot = copy.deepcopy(original)
    api = to_api_messages([original, message("user", "next", id="u")], "5m")
    assistant = api[0]["content"]
    assert "cache_control" not in assistant[0]
    assert assistant[1]["cache_control"] == {"type": "ephemeral", "ttl": "5m"}
    assert "cache_control" not in assistant[2]
    assert original == snapshot


def test_breakpoint_is_skipped_when_a_message_is_only_thinking():
    api = to_api_messages(
        [
            {
                **message("assistant", "", id="a"),
                "content": [{"type": "thinking", "thinking": "secret", "signature": "sig"}],
            },
            message("user", "next", id="u"),
        ],
        "5m",
    )
    assert "cache_control" not in api[0]["content"][0]
    assert api[1]["content"][0]["cache_control"] == {"type": "ephemeral", "ttl": "5m"}


def test_thinking_params_per_model():
    assert thinking_params("claude-sonnet-5-5", None, False) == {
        "thinking": {"type": "adaptive", "display": "summarized"},
        "output_config": {"effort": "high"},
    }
    assert thinking_params("claude-opus-5-5", None, False)["output_config"] == {"effort": "medium"}
    assert thinking_params("claude-fable-5-1", "max", False)["output_config"] == {"effort": "max"}
    assert thinking_params("claude-sonnet-5-5", "turbo", False)["output_config"] == {"effort": "high"}
    assert thinking_params("claude-haiku-4-5", None, False) == {}
    assert thinking_params("claude-haiku-4-5", None, True) == {
        "thinking": {"type": "enabled", "budget_tokens": 16000},
    }
    assert thinking_params("claude-unknown", "high", True) == {}


def test_resolve_max_tokens(monkeypatch):
    monkeypatch.delenv("MAX_TOKENS", raising=False)
    monkeypatch.setattr("app.config._settings", None)
    assert resolve_max_tokens("claude-sonnet-5-5") == 128_000
    assert resolve_max_tokens("claude-haiku-4-5") == 64_000

    monkeypatch.setenv("MAX_TOKENS", "8000")
    monkeypatch.setattr("app.config._settings", None)
    assert resolve_max_tokens("claude-sonnet-5-5") == 8000

    monkeypatch.setenv("MAX_TOKENS", "999999")
    monkeypatch.setattr("app.config._settings", None)
    assert resolve_max_tokens("claude-sonnet-5-5") == 128_000


def _scripted_client(monkeypatch, finals, events=None):
    """A messages client whose stream() returns the next scripted final message."""
    from types import SimpleNamespace

    calls = []

    class _Stream:
        def __init__(self, final, scripted):
            self._final = final
            self._scripted = scripted

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def __iter__(self):
            return iter(self._scripted)

        def get_final_message(self):
            return self._final

    class _Messages:
        def stream(self, **kwargs):
            calls.append(kwargs)
            index = len(calls) - 1
            final = finals[index if index < len(finals) else -1]
            scripted = [] if events is None else events[index if index < len(events) else -1]
            return _Stream(final, scripted)

    monkeypatch.setattr("app.llm.require_config", lambda: None)
    monkeypatch.setattr(
        "app.llm._client",
        lambda: type("Client", (), {"messages": _Messages()})(),
    )
    return calls, SimpleNamespace


def test_pause_turn_is_continued_in_one_turn(monkeypatch):
    from types import SimpleNamespace

    finals = [
        SimpleNamespace(
            content=[{"type": "thinking", "thinking": ""}],
            usage={"output_tokens": 10, "input_tokens": 1},
            stop_reason="pause_turn",
        ),
        SimpleNamespace(
            content=[{"type": "text", "text": "done"}],
            usage={"output_tokens": 4, "input_tokens": 2},
            stop_reason="end_turn",
        ),
    ]
    calls, _namespace = _scripted_client(monkeypatch, finals)
    events = list(stream_chat([message("user", "hi")], None, "claude-haiku-4-5"))
    assert len(calls) == 2
    assert calls[1]["messages"][-1] == {
        "role": "assistant",
        "content": [{"type": "thinking", "thinking": ""}],
    }
    done = events[-1]
    assert done["content"] == [
        {"type": "thinking", "thinking": ""},
        {"type": "text", "text": "done"},
    ]
    assert done["usage"]["stop_reason"] == "end_turn"
    assert done["usage"]["output_tokens"] == 14
    assert done["usage"]["input_tokens"] == 3


def test_pause_turn_stops_after_the_limit(monkeypatch):
    from types import SimpleNamespace

    finals = [
        SimpleNamespace(
            content=[{"type": "text", "text": "partial"}],
            usage={"output_tokens": 1},
            stop_reason="pause_turn",
        )
    ]
    calls, _namespace = _scripted_client(monkeypatch, finals)
    events = list(stream_chat([message("user", "hi")], None, "claude-haiku-4-5"))
    assert len(calls) == 6
    done = events[-1]
    assert done["usage"]["stop_reason"] == "pause_turn"
    assert done["content"] == [{"type": "text", "text": "partial"}] * 6


def test_thinking_deltas_are_streamed_and_timed(monkeypatch):
    from types import SimpleNamespace

    scripted = [
        SimpleNamespace(
            type="content_block_delta",
            index=0,
            delta=SimpleNamespace(type="thinking_delta", thinking="weighing"),
        ),
        SimpleNamespace(
            type="content_block_delta",
            index=1,
            delta=SimpleNamespace(type="text_delta", text="answer"),
        ),
    ]
    finals = [
        SimpleNamespace(
            content=[
                {"type": "thinking", "thinking": "weighing"},
                {"type": "text", "text": "answer"},
            ],
            usage={"output_tokens": 5},
            stop_reason="end_turn",
        )
    ]
    ticks = iter([100.0, 100.5])
    monkeypatch.setattr("app.llm.time.monotonic", lambda: next(ticks))
    _scripted_client(monkeypatch, finals, events=[scripted])
    events = list(stream_chat([message("user", "hi")], None, "claude-haiku-4-5"))
    assert {"type": "thinking", "text": "weighing"} in events
    assert {"type": "delta", "text": "answer"} in events
    assert events[-1]["usage"]["thinking_ms"] == 500
    assert events[-1]["usage"]["stop_reason"] == "end_turn"


def test_web_activity_survives_malformed_json():
    assert _web_activity({"name": "web_search", "json": '{"query": "ok"'}) == {
        "type": "web_activity",
        "tool": "web_search",
        "query": "",
        "url": "",
    }
