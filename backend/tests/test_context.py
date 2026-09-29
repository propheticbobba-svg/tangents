"""Context paths for the tangent tree.

The compaction cases are skipped: fill in `expected`, then remove the skip.
"""

import pytest

from app.context import get_context


def msg(id, parent_id, role, text, thread_id="center", created_at="2026-01-01T00:00:00+00:00"):
    return {
        "id": id,
        "parent_id": parent_id,
        "role": role,
        "content": [{"type": "text", "text": text}],
        "thread_id": thread_id,
        "created_at": created_at,
    }


def compaction(id, parent_id, thread_id="center"):
    return {
        "id": id,
        "parent_id": parent_id,
        "role": "assistant",
        "content": [
            {"type": "compaction", "content": "summary of earlier turns"},
            {"type": "text", "text": "continuing after the summary"},
        ],
        "thread_id": thread_id,
        "created_at": "2026-01-01T00:00:00+00:00",
    }


def ids(path):
    return [message["id"] for message in path]


def test_linear_chain():
    messages = [
        msg("u1", None, "user", "What are we doing?"),
        msg("a1", "u1", "assistant", "Starting from the goal."),
        msg("u2", "a1", "user", "Continue."),
    ]
    assert ids(get_context(messages, "u2")) == ["u1", "a1", "u2"]


def test_single_fork():
    messages = [
        msg("u1", None, "user", "Plan the experiment."),
        msg("a1", "u1", "assistant", "Here is the plan."),
        msg("u2", "a1", "user", "Back on the center node."),
        msg("s1", "a1", "user", "A tangent.", "side"),
    ]
    assert ids(get_context(messages, "s1")) == ["u1", "a1", "s1"]
    assert ids(get_context(messages, "u2")) == ["u1", "a1", "u2"]


def test_fork_of_a_fork():
    messages = [
        msg("u1", None, "user", "Plan the experiment."),
        msg("a1", "u1", "assistant", "Here is the plan."),
        msg("s1", "a1", "user", "A tangent.", "side"),
        msg("sa1", "s1", "assistant", "Answer on the side node.", "side"),
        msg("t1", "sa1", "user", "A tangent of the tangent.", "deeper"),
    ]
    assert ids(get_context(messages, "t1")) == ["u1", "a1", "s1", "sa1", "t1"]


def test_parent_thread_continues_after_fork():
    messages = [
        msg("u1", None, "user", "Plan the experiment."),
        msg("a1", "u1", "assistant", "Here is the plan."),
        msg("u2", "a1", "user", "Continue the center node."),
        msg("a2", "u2", "assistant", "Still on the center node."),
        msg("u3", "a2", "user", "And further."),
        msg("s1", "a1", "user", "A tangent taken at the plan.", "side"),
    ]
    path = ids(get_context(messages, "s1"))
    assert path == ["u1", "a1", "s1"]
    assert "u2" not in path
    assert "a2" not in path
    assert "u3" not in path


def test_sibling_forks_do_not_see_each_other():
    messages = [
        msg("u1", None, "user", "Plan the experiment."),
        msg("a1", "u1", "assistant", "Here is the plan."),
        msg("s1", "a1", "user", "First tangent.", "side-a"),
        msg("sa1", "s1", "assistant", "Answer on the first tangent.", "side-a"),
        msg("r1", "a1", "user", "Second tangent.", "side-b"),
        msg("ra1", "r1", "assistant", "Answer on the second tangent.", "side-b"),
    ]
    first = ids(get_context(messages, "sa1"))
    second = ids(get_context(messages, "ra1"))
    assert first == ["u1", "a1", "s1", "sa1"]
    assert second == ["u1", "a1", "r1", "ra1"]
    assert "r1" not in first
    assert "ra1" not in first
    assert "s1" not in second
    assert "sa1" not in second


@pytest.mark.skip(reason="TODO: expected result not defined")
def test_thread_with_compaction_message():
    messages = [
        msg("u1", None, "user", "Plan the experiment."),
        msg("a1", "u1", "assistant", "Here is the plan."),
        msg("u2", "a1", "user", "Keep going."),
        compaction("a2", "u2"),
        msg("u3", "a2", "user", "After the checkpoint."),
    ]
    expected = ...  # TODO
    assert ids(get_context(messages, "u3")) == expected


@pytest.mark.skip(reason="TODO: expected result not defined")
def test_side_node_forked_before_compaction():
    messages = [
        msg("u1", None, "user", "Plan the experiment."),
        msg("a1", "u1", "assistant", "Here is the plan."),
        msg("u2", "a1", "user", "Keep going."),
        compaction("a2", "u2"),
        msg("s1", "a1", "user", "Tangent taken before the checkpoint.", "side"),
    ]
    expected = ...  # TODO
    assert ids(get_context(messages, "s1")) == expected


@pytest.mark.skip(reason="TODO: expected result not defined")
def test_side_node_forked_after_compaction():
    messages = [
        msg("u1", None, "user", "Plan the experiment."),
        msg("a1", "u1", "assistant", "Here is the plan."),
        compaction("a2", "a1"),
        msg("s1", "a2", "user", "Tangent taken at the checkpoint.", "side"),
    ]
    expected = ...  # TODO
    assert ids(get_context(messages, "s1")) == expected
