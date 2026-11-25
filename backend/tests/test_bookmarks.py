"""Bookmarks on messages in any node."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.db import connect, insert_message


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("TANGENTS_DB", str(tmp_path / "tangents.db"))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    monkeypatch.setenv("ANTHROPIC_MODEL", "")
    from app.main import app

    with TestClient(app) as test_client:
        yield test_client


def new_conversation(client):
    payload = client.post("/api/conversations").json()
    return payload["id"], payload["center_thread_id"]


def save(thread_id, parent_id, role, content):
    if isinstance(content, str):
        content = [{"type": "text", "text": content}]
    conn = connect()
    try:
        return insert_message(
            conn, thread_id=thread_id, parent_id=parent_id, role=role, content=content
        )
    finally:
        conn.close()


def fork(client, message_id):
    response = client.post("/api/threads", json={"fork_message_id": message_id})
    assert response.status_code == 201
    return response.json()["id"]


def mark(client, message_id):
    response = client.put(f"/api/messages/{message_id}/bookmark")
    assert response.status_code == 200
    return response


def bookmarks(client, conversation_id):
    response = client.get(f"/api/conversations/{conversation_id}/bookmarks")
    assert response.status_code == 200
    return response.json()


def flags(client, thread_id):
    data = client.get(f"/api/threads/{thread_id}/messages").json()
    return {m["id"]: m["bookmarked"] for m in data["messages"]}


def deep_chat(client):
    """Center -> side -> deeper side. Returns ids."""
    conv, center = new_conversation(client)
    answer = save(center, None, "assistant", "center answer")
    side = fork(client, answer["id"])
    side_answer = save(side, answer["id"], "assistant", "side answer")
    deep = fork(client, side_answer["id"])
    return conv, center, answer, side, side_answer, deep


def test_bookmark_two_side_chats_deep_is_listed_with_its_details(client):
    conv, _, _, _, side_answer, deep = deep_chat(client)
    conn = connect()
    try:
        conn.execute("UPDATE threads SET title = 'Deep dive' WHERE id = ?", (deep,))
        conn.commit()
    finally:
        conn.close()
    long_text = "word " * 100
    msg = save(
        deep,
        side_answer["id"],
        "user",
        [
            {"type": "thinking", "thinking": "SECRETTHOUGHT"},
            {"type": "search_result", "content": [{"type": "text", "text": "PASSAGE"}]},
            {"type": "text", "text": long_text},
        ],
    )
    mark(client, msg["id"])

    (entry,) = bookmarks(client, conv)
    assert entry["message_id"] == msg["id"]
    assert entry["thread_id"] == deep
    assert entry["thread_title"] == "Deep dive"
    assert entry["is_side_node"] is True
    assert entry["role"] == "user"
    assert entry["created_at"] == msg["created_at"]
    assert entry["snippet"].startswith("word word")
    assert len(entry["snippet"]) <= 161
    assert "SECRETTHOUGHT" not in entry["snippet"] and "PASSAGE" not in entry["snippet"]


def test_list_spans_main_and_side_chats_oldest_first_and_only_this_chat(client):
    conv, center, answer, side, side_answer, deep = deep_chat(client)
    deep_msg = save(deep, side_answer["id"], "user", "deep message")
    other_conv, other_center = new_conversation(client)
    other = save(other_center, None, "user", "elsewhere")

    mark(client, deep_msg["id"])
    mark(client, answer["id"])
    mark(client, side_answer["id"])
    mark(client, other["id"])

    listed = bookmarks(client, conv)
    assert [b["message_id"] for b in listed] == [
        answer["id"],
        side_answer["id"],
        deep_msg["id"],
    ]
    assert [b["is_side_node"] for b in listed] == [False, True, True]
    assert [b["message_id"] for b in bookmarks(client, other_conv)] == [other["id"]]


def test_bookmarking_twice_keeps_one_and_removing_missing_succeeds(client):
    conv, center = new_conversation(client)
    msg = save(center, None, "user", "hello")
    other = save(center, msg["id"], "assistant", "hi")
    mark(client, msg["id"])
    mark(client, msg["id"])
    assert len(bookmarks(client, conv)) == 1
    conn = connect()
    try:
        count = conn.execute("SELECT COUNT(*) AS n FROM bookmarks").fetchone()["n"]
    finally:
        conn.close()
    assert count == 1
    assert client.delete(f"/api/messages/{other['id']}/bookmark").status_code == 204
    assert client.delete("/api/messages/nope/bookmark").status_code == 204


def test_removed_bookmark_leaves_list_and_message_flag(client):
    conv, center = new_conversation(client)
    msg = save(center, None, "user", "hello")
    mark(client, msg["id"])
    assert flags(client, center)[msg["id"]] is True
    assert client.delete(f"/api/messages/{msg['id']}/bookmark").status_code == 204
    assert bookmarks(client, conv) == []
    assert flags(client, center)[msg["id"]] is False


def test_messages_say_if_bookmarked_after_restart(tmp_path, monkeypatch):
    monkeypatch.setenv("TANGENTS_DB", str(tmp_path / "tangents.db"))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    monkeypatch.setenv("ANTHROPIC_MODEL", "")
    from app.main import app

    with TestClient(app) as first:
        _, center = new_conversation(first)
        a = save(center, None, "user", "one")
        b = save(center, a["id"], "assistant", "two")
        mark(first, a["id"])
        assert flags(first, center) == {a["id"]: True, b["id"]: False}
    with TestClient(app) as second:
        assert flags(second, center) == {a["id"]: True, b["id"]: False}


def test_deleting_side_chat_or_whole_chat_drops_its_bookmarks(client):
    conv, center, answer, side, side_answer, deep = deep_chat(client)
    deep_msg = save(deep, side_answer["id"], "user", "deep message")
    mark(client, answer["id"])
    mark(client, side_answer["id"])
    mark(client, deep_msg["id"])

    assert client.delete(f"/api/threads/{side}").status_code == 204
    assert [b["message_id"] for b in bookmarks(client, conv)] == [answer["id"]]

    assert client.delete(f"/api/conversations/{conv}").status_code == 204
    conn = connect()
    try:
        count = conn.execute("SELECT COUNT(*) AS n FROM bookmarks").fetchone()["n"]
    finally:
        conn.close()
    assert count == 0
    assert client.get(f"/api/conversations/{conv}/bookmarks").status_code == 404


def test_unknown_message_or_chat_gets_404(client):
    assert client.put("/api/messages/missing/bookmark").status_code == 404
    assert client.get("/api/conversations/missing/bookmarks").status_code == 404
