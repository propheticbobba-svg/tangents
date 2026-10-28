"""Spoken math: the gate, span location, LaTeX cleanup, and the two routes.
Never calls the API: the model call is faked."""

import pytest
from fastapi.testclient import TestClient

from app import mathspeech
from app.llm import LLMError
from app.mathspeech import (
    EMIT_FORMULAS,
    MATH_MODEL,
    build_parts,
    edit_formula,
    looks_like_math,
    parse_spoken_math,
    sanitize_latex,
)


@pytest.fixture()
def with_key(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setattr("app.config._settings", None)


@pytest.fixture()
def without_key(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    monkeypatch.setattr("app.config._settings", None)


def fake_call(monkeypatch, result=None, error: Exception | None = None):
    calls = []

    def call(instruction, content, tool):
        calls.append({"instruction": instruction, "content": content, "tool": tool})
        if error is not None:
            raise error
        return result

    monkeypatch.setattr(mathspeech, "_call_tool", call)
    return calls


@pytest.mark.parametrize(
    "text",
    [
        "4x square minus 2x plus 6 divided by 3",
        "explain the backpropagation formula",
        "what is x over 2",
        "five over six",
        "e to the i pi",
        "the integral of sine",
        "solve for x",
        "theta equals 30 degrees",
        "2 + 3",
        "6/3",
        "a^2",
    ],
)
def test_gate_accepts_math(text):
    assert looks_like_math(text)


@pytest.mark.parametrize(
    "text",
    [
        "hello how are you",
        "can you look over there",
        "a well-known and/or popular idea",
        "I went to the store",
        "remind me tomorrow morning",
        "",
    ],
)
def test_gate_rejects_plain_speech(text):
    assert not looks_like_math(text)


def test_sanitize_latex_strips_delimiters_and_rejects_bad_values():
    assert sanitize_latex("  $\\frac{1}{2}$ ") == "\\frac{1}{2}"
    assert sanitize_latex("$$x^2$$") == "x^2"
    assert sanitize_latex("\\(x\\)") == "x"
    assert sanitize_latex("\\[ \\sqrt{2} \\]") == "\\sqrt{2}"
    assert sanitize_latex("") is None
    assert sanitize_latex("   ") is None
    assert sanitize_latex("$$") is None
    assert sanitize_latex("cost $5") is None
    assert sanitize_latex("x" * 1001) is None
    assert sanitize_latex(None) is None
    assert sanitize_latex(42) is None


def test_build_parts_keeps_surrounding_words_verbatim():
    transcript = "So, 4x squared, minus 2x, plus 6 divided by 3. Right?"
    parts = build_parts(
        transcript,
        [{"spoken": "4x squared minus 2x plus 6 divided by 3", "latex": "\\frac{4x^2-2x+6}{3}"}],
    )
    assert parts == [
        {"type": "text", "text": "So, "},
        {
            "type": "formula",
            "latex": "\\frac{4x^2-2x+6}{3}",
            "spoken": "4x squared, minus 2x, plus 6 divided by 3",
        },
        {"type": "text", "text": ". Right?"},
    ]
    assert "".join(p["text"] if p["type"] == "text" else p["spoken"] for p in parts) == transcript


def test_build_parts_is_case_insensitive_and_ordered():
    transcript = "First X plus 1, then y minus 2."
    parts = build_parts(
        transcript,
        [{"spoken": "x plus 1", "latex": "x+1"}, {"spoken": "Y MINUS 2", "latex": "y-2"}],
    )
    assert [p["type"] for p in parts] == ["text", "formula", "text", "formula", "text"]
    assert parts[1]["spoken"] == "X plus 1"
    assert parts[3]["spoken"] == "y minus 2"


def test_build_parts_drops_unlocatable_and_never_matches_inside_words():
    transcript = "the next value is x"
    parts = build_parts(
        transcript,
        [{"spoken": "made up words", "latex": "z"}, {"spoken": "x", "latex": "x"}],
    )
    assert parts == [
        {"type": "text", "text": "the next value is "},
        {"type": "formula", "latex": "x", "spoken": "x"},
    ]


def test_build_parts_repeated_phrase_uses_the_next_occurrence():
    transcript = "x plus 1 and again x plus 1"
    parts = build_parts(
        transcript,
        [{"spoken": "x plus 1", "latex": "x+1"}, {"spoken": "x plus 1", "latex": "x+1"}],
    )
    assert [p["type"] for p in parts] == ["formula", "text", "formula"]
    assert parts[1]["text"] == " and again "


def test_build_parts_with_nothing_located_returns_plain_text():
    assert build_parts("hello", [{"spoken": "nope", "latex": "x"}]) == [
        {"type": "text", "text": "hello"}
    ]


def test_parse_skips_the_model_for_plain_speech(monkeypatch, with_key):
    calls = fake_call(monkeypatch, {"formulas": []})
    assert parse_spoken_math("hello how are you") == [{"type": "text", "text": "hello how are you"}]
    assert calls == []


def test_parse_without_a_key_returns_plain_text(monkeypatch, without_key):
    calls = fake_call(monkeypatch, {"formulas": []})
    text = "x plus 1"
    assert parse_spoken_math(text) == [{"type": "text", "text": text}]
    assert calls == []


def test_parse_splits_math(monkeypatch, with_key):
    calls = fake_call(
        monkeypatch,
        {"formulas": [{"spoken": "x squared plus 1", "latex": "$x^2+1$"}]},
    )
    parts = parse_spoken_math("so x squared plus 1 is positive")
    assert parts == [
        {"type": "text", "text": "so "},
        {"type": "formula", "latex": "x^2+1", "spoken": "x squared plus 1"},
        {"type": "text", "text": " is positive"},
    ]
    assert calls[0]["tool"] is EMIT_FORMULAS
    assert calls[0]["content"].endswith("so x squared plus 1 is positive")


@pytest.mark.parametrize(
    "result",
    [
        {"formulas": []},
        {"formulas": "x"},
        {},
        {"formulas": [{"spoken": "x plus 1", "latex": ""}]},
        {"formulas": [{"spoken": "", "latex": "x+1"}]},
        {"formulas": ["x plus 1"]},
    ],
)
def test_parse_falls_back_on_unusable_output(monkeypatch, with_key, result):
    fake_call(monkeypatch, result)
    assert parse_spoken_math("x plus 1") == [{"type": "text", "text": "x plus 1"}]


def test_parse_falls_back_when_the_call_fails(monkeypatch, with_key):
    fake_call(monkeypatch, error=LLMError("boom"))
    assert parse_spoken_math("x plus 1") == [{"type": "text", "text": "x plus 1"}]


def test_edit_formula_returns_clean_latex(monkeypatch):
    calls = fake_call(monkeypatch, {"latex": "$4x^2-2x+\\frac{6}{3}$"})
    assert edit_formula("\\frac{4x^2-2x+6}{3}", "only the 6 is over 3") == "4x^2-2x+\\frac{6}{3}"
    assert "Current formula:\n\\frac{4x^2-2x+6}{3}" in calls[0]["content"]
    assert "only the 6 is over 3" in calls[0]["content"]


def test_edit_formula_rejects_empty_output(monkeypatch):
    fake_call(monkeypatch, {"latex": "  "})
    with pytest.raises(LLMError):
        edit_formula("x", "make it y")


class _Block:
    def __init__(self, data):
        self.data = data

    def model_dump(self, **_kwargs):
        return self.data


class _Messages:
    def __init__(self, blocks, stop_reason="tool_use", error=None):
        self.blocks = blocks
        self.stop_reason = stop_reason
        self.error = error
        self.kwargs = None

    def create(self, **kwargs):
        self.kwargs = kwargs
        if self.error is not None:
            raise self.error
        return type("Response", (), {"content": self.blocks, "stop_reason": self.stop_reason})()


class _Client:
    def __init__(self, messages):
        self.messages = messages
        self.options = None

    def with_options(self, **options):
        self.options = options
        return self


def fake_client(monkeypatch, messages):
    client = _Client(messages)
    monkeypatch.setattr("app.llm.require_config", lambda: None)
    monkeypatch.setattr("app.llm._client", lambda: client)
    return client


def test_call_tool_forces_the_tool_on_haiku(monkeypatch):
    messages = _Messages([_Block({"type": "tool_use", "name": "emit_formulas", "input": {"formulas": []}})])
    client = fake_client(monkeypatch, messages)
    assert mathspeech._call_tool("rules", "Transcript:\nx", EMIT_FORMULAS) == {"formulas": []}
    assert messages.kwargs["model"] == MATH_MODEL == "claude-haiku-4-5"
    assert messages.kwargs["tool_choice"] == {"type": "tool", "name": "emit_formulas"}
    assert messages.kwargs["tools"] == [EMIT_FORMULAS]
    assert messages.kwargs["system"] == "rules"
    assert client.options == {"timeout": mathspeech.MATH_TIMEOUT_SECONDS, "max_retries": 1}


@pytest.mark.parametrize(
    "messages",
    [
        _Messages([_Block({"type": "text", "text": "no tool"})]),
        _Messages([_Block({"type": "tool_use", "name": "emit_formulas", "input": {}})], stop_reason="max_tokens"),
        _Messages([_Block({"type": "tool_use", "name": "other", "input": {}})]),
        _Messages([], error=RuntimeError("network")),
    ],
)
def test_call_tool_raises_on_bad_responses(monkeypatch, messages):
    fake_client(monkeypatch, messages)
    with pytest.raises(LLMError):
        mathspeech._call_tool("rules", "x", EMIT_FORMULAS)


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("TANGENTS_DB", str(tmp_path / "tangents.db"))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    monkeypatch.setenv("ANTHROPIC_MODEL", "")
    monkeypatch.setattr("app.config._settings", None)
    from app.main import app

    with TestClient(app) as test_client:
        yield test_client


def test_math_route_returns_parts(client: TestClient):
    response = client.post("/api/dictation/math", json={"text": "hello there"})
    assert response.status_code == 200
    assert response.json() == {"parts": [{"type": "text", "text": "hello there"}]}


def test_math_route_rejects_long_text(client: TestClient):
    response = client.post("/api/dictation/math", json={"text": "x" * 4001})
    assert response.status_code == 422


def test_edit_route_needs_a_key(client: TestClient):
    response = client.post("/api/dictation/math/edit", json={"latex": "x", "spoken": "make it y"})
    assert response.status_code == 503
    assert response.json()["detail"] == "Set ANTHROPIC_API_KEY to edit formulas by voice"


def test_edit_route_success_and_failure(client: TestClient, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setattr("app.config._settings", None)
    monkeypatch.setattr(mathspeech, "edit_formula", lambda latex, spoken: "y")
    response = client.post("/api/dictation/math/edit", json={"latex": "x", "spoken": "make it y"})
    assert response.status_code == 200
    assert response.json() == {"latex": "y"}

    def boom(latex, spoken):
        raise LLMError("down")

    monkeypatch.setattr(mathspeech, "edit_formula", boom)
    response = client.post("/api/dictation/math/edit", json={"latex": "x", "spoken": "make it y"})
    assert response.status_code == 503
    assert response.json()["detail"] == "Could not update that formula"


def test_edit_route_validates_input(client: TestClient):
    assert client.post("/api/dictation/math/edit", json={"latex": "", "spoken": "y"}).status_code == 422
    assert client.post("/api/dictation/math/edit", json={"latex": "x", "spoken": ""}).status_code == 422
