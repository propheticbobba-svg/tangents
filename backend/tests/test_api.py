"""API behavior that does not call Anthropic.

Chat success paths can use a test double for get_context. The real walk is
covered in test_context.py.
"""

import json

import pytest
from fastapi.testclient import TestClient

from app.context import get_context
from app.db import connect, insert_message, messages_in_conversation, short_title
from app.llm import LLMError
from tests.test_rag import FakeEmbedder


def walk(messages, message_id):
    """Test double. Not the application implementation."""
    by_id = {message["id"]: message for message in messages}
    path = []
    seen = set()
    current = by_id[message_id]
    while current is not None:
        if current["id"] in seen:
            raise AssertionError("cycle")
        seen.add(current["id"])
        path.append(current)
        parent_id = current["parent_id"]
        current = by_id[parent_id] if parent_id else None
    path.reverse()
    return path


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("TANGENTS_DB", str(tmp_path / "tangents.db"))
    # Empty values block backend/.env from filling these in during tests.
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    monkeypatch.setenv("ANTHROPIC_MODEL", "")
    from app.main import app

    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def small_client(tmp_path, monkeypatch):
    monkeypatch.setenv("TANGENTS_DB", str(tmp_path / "tangents.db"))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    monkeypatch.setenv("ANTHROPIC_MODEL", "")
    monkeypatch.setenv("MAX_UPLOAD_MB", "1")
    from app.main import app

    with TestClient(app) as test_client:
        yield test_client


def use_fake_embedder(monkeypatch):
    monkeypatch.setattr("app.rag.get_embedder", lambda: FakeEmbedder())


def parse_sse(body: str):
    events = []
    for block in body.split("\n\n"):
        if not block.strip():
            continue
        event = "message"
        data = ""
        for line in block.split("\n"):
            if line.startswith("event:"):
                event = line.split(":", 1)[1].strip()
            elif line.startswith("data:"):
                data = line.split(":", 1)[1].strip()
        events.append((event, json.loads(data)))
    return events


def haiku_title(text: str, reply_text: str = "") -> str:
    return f"Named: {text}"


def create_conversation(client: TestClient) -> tuple[str, str]:
    response = client.post("/api/conversations")
    assert response.status_code == 201
    payload = response.json()
    return payload["id"], payload["center_thread_id"]


def test_delete_conversation_removes_its_threads_and_messages(client: TestClient):
    kept_id, kept_center = create_conversation(client)
    gone_id, gone_center = create_conversation(client)
    conn = connect()
    try:
        saved = insert_message(
            conn,
            thread_id=gone_center,
            parent_id=None,
            role="assistant",
            content=[{"type": "text", "text": "answer"}],
        )
    finally:
        conn.close()
    side = client.post("/api/threads", json={"fork_message_id": saved["id"]})
    assert side.status_code == 201
    conn = connect()
    try:
        insert_message(
            conn,
            thread_id=side.json()["id"],
            parent_id=saved["id"],
            role="user",
            content=[{"type": "text", "text": "a tangent"}],
        )
    finally:
        conn.close()

    missing = client.delete("/api/conversations/does-not-exist")
    assert missing.status_code == 404

    deleted = client.delete(f"/api/conversations/{gone_id}")
    assert deleted.status_code == 204
    assert deleted.content == b""

    listed = client.get("/api/conversations")
    ids = [item["id"] for item in listed.json()]
    assert gone_id not in ids
    assert kept_id in ids

    assert client.get(f"/api/conversations/{gone_id}/tree").status_code == 404
    assert client.get(f"/api/threads/{gone_center}/messages").status_code == 404
    assert client.get(f"/api/threads/{side.json()['id']}/messages").status_code == 404

    kept_tree = client.get(f"/api/conversations/{kept_id}/tree").json()
    assert [thread["id"] for thread in kept_tree["threads"]] == [kept_center]


def _save(thread_id: str, parent_id: str | None, role: str, text: str) -> dict:
    conn = connect()
    try:
        return insert_message(
            conn,
            thread_id=thread_id,
            parent_id=parent_id,
            role=role,
            content=[{"type": "text", "text": text}],
        )
    finally:
        conn.close()


def test_delete_side_node_removes_its_subtree(client: TestClient):
    conversation_id, center_id = create_conversation(client)
    center_user = _save(center_id, None, "user", "center user")
    center_assistant = _save(center_id, center_user["id"], "assistant", "center answer")

    side_a = client.post("/api/threads", json={"fork_message_id": center_assistant["id"]})
    assert side_a.status_code == 201
    a_id = side_a.json()["id"]
    a_user = _save(a_id, center_assistant["id"], "user", "tangent A")
    a_assistant = _save(a_id, a_user["id"], "assistant", "answer A")

    side_a1 = client.post("/api/threads", json={"fork_message_id": a_assistant["id"]})
    assert side_a1.status_code == 201
    a1_id = side_a1.json()["id"]
    a1_user = _save(a1_id, a_assistant["id"], "user", "tangent A1")
    a1_assistant = _save(a1_id, a1_user["id"], "assistant", "answer A1")

    side_a1a = client.post("/api/threads", json={"fork_message_id": a1_assistant["id"]})
    assert side_a1a.status_code == 201
    a1a_id = side_a1a.json()["id"]
    a1a_user = _save(a1a_id, a1_assistant["id"], "user", "tangent A1a")
    _save(a1a_id, a1a_user["id"], "assistant", "answer A1a")

    side_b = client.post("/api/threads", json={"fork_message_id": center_assistant["id"]})
    assert side_b.status_code == 201
    b_id = side_b.json()["id"]
    b_user = _save(b_id, center_assistant["id"], "user", "tangent B")
    b_assistant = _save(b_id, b_user["id"], "assistant", "answer B")

    conn = connect()
    try:
        before = get_context(messages_in_conversation(conn, conversation_id), b_assistant["id"])
    finally:
        conn.close()

    deleted = client.delete(f"/api/threads/{a_id}")
    assert deleted.status_code == 204
    assert deleted.content == b""

    tree = client.get(f"/api/conversations/{conversation_id}/tree").json()
    assert {thread["id"] for thread in tree["threads"]} == {center_id, b_id}
    assert client.get(f"/api/threads/{a_id}/messages").status_code == 404
    assert client.get(f"/api/threads/{a1_id}/messages").status_code == 404
    assert client.get(f"/api/threads/{a1a_id}/messages").status_code == 404

    conn = connect()
    try:
        thread_ids = {row["id"] for row in conn.execute("SELECT id FROM threads").fetchall()}
        message_ids = {row["id"] for row in conn.execute("SELECT id FROM messages").fetchall()}
        after = get_context(messages_in_conversation(conn, conversation_id), b_assistant["id"])
    finally:
        conn.close()
    assert thread_ids == {center_id, b_id}
    assert center_assistant["id"] in message_ids
    assert a_user["id"] not in message_ids
    assert a_assistant["id"] not in message_ids
    assert a1_user["id"] not in message_ids
    assert a1a_user["id"] not in message_ids
    assert [message["id"] for message in after] == [message["id"] for message in before]
    assert [message["content"] for message in after] == [message["content"] for message in before]

    center_messages = client.get(f"/api/threads/{center_id}/messages").json()["messages"]
    assert [message["id"] for message in center_messages] == [center_user["id"], center_assistant["id"]]
    b_messages = client.get(f"/api/threads/{b_id}/messages").json()["messages"]
    assert [message["id"] for message in b_messages] == [b_user["id"], b_assistant["id"]]

    center = client.delete(f"/api/threads/{center_id}")
    assert center.status_code == 400
    assert center.json()["detail"] == "The center node cannot be deleted"
    assert client.get(f"/api/threads/{center_id}/messages").status_code == 200

    missing = client.delete("/api/threads/does-not-exist")
    assert missing.status_code == 404
    assert client.delete(f"/api/threads/{a_id}").status_code == 404


def test_new_conversation_has_an_empty_center_node(client: TestClient):
    conversation_id, center_id = create_conversation(client)
    listed = client.get("/api/conversations")
    assert listed.status_code == 200
    assert listed.json()[0]["id"] == conversation_id
    assert listed.json()[0]["goal"] is None

    tree = client.get(f"/api/conversations/{conversation_id}/tree").json()
    assert tree["goal"] is None
    assert len(tree["threads"]) == 1
    assert tree["threads"][0]["id"] == center_id
    assert tree["threads"][0]["parent_thread_id"] is None
    assert tree["threads"][0]["title"] == "Center"

    messages = client.get(f"/api/threads/{center_id}/messages").json()
    assert messages["messages"] == []
    assert messages["ancestry"] == [{"id": center_id, "title": "Center"}]


def test_failed_turn_rolls_back_the_user_message(client: TestClient):
    _conversation_id, center_id = create_conversation(client)
    response = client.post(
        f"/api/threads/{center_id}/messages",
        json={"content": "Hello"},
    )
    assert response.status_code == 200
    events = parse_sse(response.text)
    assert events[0][0] == "user_message"
    assert events[1] == ("error", {"error": "ANTHROPIC_API_KEY is not set in backend/.env"})

    messages = client.get(f"/api/threads/{center_id}/messages").json()
    assert messages["messages"] == []
    assert messages["thread"]["title"] == "Center"
    conversation = client.get("/api/conversations").json()[0]
    assert conversation["goal"] is None


def test_missing_api_key_is_a_clear_error_once_context_exists(client, monkeypatch):
    monkeypatch.setattr("app.main.get_context", walk)
    _conversation_id, center_id = create_conversation(client)
    response = client.post(
        f"/api/threads/{center_id}/messages",
        json={"content": "Hello"},
    )
    events = parse_sse(response.text)
    assert events[-1][0] == "error"
    assert events[-1][1]["error"] == "ANTHROPIC_API_KEY is not set in backend/.env"
    assert client.get(f"/api/threads/{center_id}/messages").json()["messages"] == []


def test_ui_model_is_the_one_sent_to_the_api(client, monkeypatch):
    monkeypatch.setattr("app.main.get_context", walk)
    seen = {}

    def fake_stream(path, goal, model=None, web=False, docs=False):
        seen["model"] = model
        yield {
            "type": "done",
            "content": [{"type": "text", "text": "ok"}],
            "usage": {"input_tokens": 1, "output_tokens": 1},
        }

    monkeypatch.setattr("app.main.stream_chat", fake_stream)
    _conversation_id, center_id = create_conversation(client)
    response = client.post(
        f"/api/threads/{center_id}/messages",
        json={"content": "Hello", "model": "claude-opus-5-5"},
    )
    assert parse_sse(response.text)[-1][0] == "done"
    assert seen["model"] == "claude-opus-5-5"


def test_stream_saves_the_turn_the_goal_and_usage(client, monkeypatch):
    monkeypatch.setattr("app.main.get_context", walk)
    monkeypatch.setattr("app.main.suggest_title", haiku_title)
    seen = {}

    def fake_stream(path, goal, model=None, web=False, docs=False):
        seen["ids"] = [message["id"] for message in path]
        seen["goal"] = goal
        seen["blocks"] = path[-1]["content"]
        yield {"type": "delta", "text": "Hello "}
        yield {"type": "delta", "text": "there"}
        yield {
            "type": "done",
            "content": [{"type": "text", "text": "Hello there"}],
            "usage": {
                "input_tokens": 11,
                "output_tokens": 2,
                "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 4,
            },
        }

    monkeypatch.setattr("app.main.stream_chat", fake_stream)
    conversation_id, center_id = create_conversation(client)
    response = client.post(
        f"/api/threads/{center_id}/messages",
        json={"content": "Pin this goal"},
    )
    events = parse_sse(response.text)
    assert [event for event, _data in events] == ["user_message", "delta", "delta", "done"]
    done = events[-1][1]
    assert done["role"] == "assistant"
    assert done["content"] == [{"type": "text", "text": "Hello there"}]
    assert done["usage"]["cache_creation_input_tokens"] == 4
    assert done["parent_id"] == events[0][1]["id"]
    assert events[0][1]["parent_id"] is None
    assert seen["blocks"] == [{"type": "text", "text": "Pin this goal"}]
    assert seen["goal"] == "Pin this goal"

    messages = client.get(f"/api/threads/{center_id}/messages").json()
    assert [message["role"] for message in messages["messages"]] == ["user", "assistant"]
    assert messages["thread"]["title"] == "Named: Pin this goal"
    tree = client.get(f"/api/conversations/{conversation_id}/tree").json()
    assert tree["goal"] == "Pin this goal"


def test_fork_is_a_snapshot_point_and_siblings_stay_separate(client, monkeypatch):
    monkeypatch.setattr("app.main.get_context", walk)
    monkeypatch.setattr("app.main.suggest_title", haiku_title)

    def fake_stream(path, goal, model=None, web=False, docs=False):
        text = "answer " + path[-1]["content"][0]["text"]
        yield {"type": "delta", "text": text}
        yield {
            "type": "done",
            "content": [{"type": "text", "text": text}],
            "usage": {"input_tokens": 1, "output_tokens": 1},
        }

    monkeypatch.setattr("app.main.stream_chat", fake_stream)
    conversation_id, center_id = create_conversation(client)
    client.post(f"/api/threads/{center_id}/messages", json={"content": "Main topic"})
    center = client.get(f"/api/threads/{center_id}/messages").json()
    assistant_id = center["messages"][1]["id"]

    user_fork = client.post("/api/threads", json={"fork_message_id": center["messages"][0]["id"]})
    assert user_fork.status_code == 400

    first = client.post("/api/threads", json={"fork_message_id": assistant_id})
    second = client.post("/api/threads", json={"fork_message_id": assistant_id})
    assert first.status_code == 201
    assert second.status_code == 201
    assert first.json()["parent_thread_id"] == center_id
    assert first.json()["fork_message_id"] == assistant_id

    client.post(
        f"/api/threads/{center_id}/messages",
        json={"content": "Center continues after the fork"},
    )
    client.post(f"/api/threads/{first.json()['id']}/messages", json={"content": "Tangent A"})
    client.post(f"/api/threads/{second.json()['id']}/messages", json={"content": "Tangent B"})

    side_a = client.get(f"/api/threads/{first.json()['id']}/messages").json()
    side_b = client.get(f"/api/threads/{second.json()['id']}/messages").json()
    assert side_a["messages"][0]["parent_id"] == assistant_id
    assert side_b["messages"][0]["parent_id"] == assistant_id
    assert "Tangent B" not in json.dumps(side_a["messages"])
    assert "Tangent A" not in json.dumps(side_b["messages"])
    center_after = client.get(f"/api/threads/{center_id}/messages").json()
    assert "Tangent A" not in json.dumps(center_after["messages"])
    assert "Center continues after the fork" in json.dumps(center_after["messages"])

    tree = client.get(f"/api/conversations/{conversation_id}/tree").json()
    forks = [thread for thread in tree["threads"] if thread["fork_message_id"] == assistant_id]
    assert len(forks) == 2
    assert forks[0]["fork_position"] == forks[1]["fork_position"] == 1
    assert "answer Main topic" in forks[0]["fork_snippet"]
    titles = {side_a["thread"]["title"], side_b["thread"]["title"]}
    assert titles == {"Named: Tangent A", "Named: Tangent B"}
    assert [item["title"] for item in side_a["ancestry"]] == ["Named: Main topic", "Named: Tangent A"]


def test_title_falls_back_and_a_later_turn_keeps_it(client, monkeypatch):
    monkeypatch.setattr("app.main.get_context", walk)
    monkeypatch.setattr(
        "app.main.stream_chat",
        lambda path, goal, model=None, web=False, docs=False: iter(
            [
                {
                    "type": "done",
                    "content": [{"type": "text", "text": "ok"}],
                    "usage": {"input_tokens": 1, "output_tokens": 1},
                }
            ]
        ),
    )
    calls: list[str] = []

    def titles(text: str, reply_text: str = "") -> str:
        calls.append(text)
        if text.startswith("Empty"):
            return "   "
        raise LLMError("title model down")

    monkeypatch.setattr("app.main.suggest_title", titles)
    _conversation_id, center_id = create_conversation(client)
    empty = "Empty reply from the title model should not stick as the name"
    client.post(f"/api/threads/{center_id}/messages", json={"content": empty})
    assert client.get(f"/api/threads/{center_id}/messages").json()["thread"]["title"] == short_title(empty)

    _other_id, other_center = create_conversation(client)
    opening = "Please help me rewrite the onboarding email for new hires today"
    client.post(f"/api/threads/{other_center}/messages", json={"content": opening})
    titled = client.get(f"/api/threads/{other_center}/messages").json()
    assert titled["thread"]["title"] == short_title(opening)
    client.post(
        f"/api/threads/{other_center}/messages",
        json={"content": "Make the subject line shorter"},
    )
    again = client.get(f"/api/threads/{other_center}/messages").json()
    assert again["thread"]["title"] == short_title(opening)
    assert calls == [empty, opening]


def test_goal_can_be_edited_and_is_not_overwritten_by_a_later_message(client, monkeypatch):
    monkeypatch.setattr("app.main.get_context", walk)
    monkeypatch.setattr(
        "app.main.stream_chat",
        lambda path, goal, model=None, web=False, docs=False: iter(
            [
                {
                    "type": "done",
                    "content": [{"type": "text", "text": "ok"}],
                    "usage": {"input_tokens": 1, "output_tokens": 1},
                }
            ]
        ),
    )
    conversation_id, center_id = create_conversation(client)
    client.post(f"/api/threads/{center_id}/messages", json={"content": "Original goal"})
    patched = client.patch(
        f"/api/conversations/{conversation_id}",
        json={"goal": "Edited goal"},
    )
    assert patched.status_code == 200
    assert patched.json()["goal"] == "Edited goal"
    client.post(f"/api/threads/{center_id}/messages", json={"content": "A later turn"})
    tree = client.get(f"/api/conversations/{conversation_id}/tree").json()
    assert tree["goal"] == "Edited goal"


def test_compaction_blocks_round_trip_without_being_rewritten(client):
    _conversation_id, center_id = create_conversation(client)
    blocks = [
        {"type": "compaction", "content": "The goal is still the original one."},
        {"type": "text", "text": "Continuing."},
    ]
    conn = connect()
    try:
        saved = insert_message(
            conn,
            thread_id=center_id,
            parent_id=None,
            role="assistant",
            content=blocks,
            usage={"input_tokens": 3, "iterations": [{"type": "compaction", "input_tokens": 9, "output_tokens": 2}]},
        )
    finally:
        conn.close()

    messages = client.get(f"/api/threads/{center_id}/messages").json()["messages"]
    assert messages[0]["id"] == saved["id"]
    assert messages[0]["content"] == blocks
    assert messages[0]["usage"]["iterations"][0]["type"] == "compaction"


def test_web_flag_defaults_to_false_and_reaches_stream_chat(client, monkeypatch):
    monkeypatch.setattr("app.main.get_context", walk)
    seen = {}

    def fake_stream(path, goal, model=None, web=False, docs=False):
        seen["web"] = web
        yield {
            "type": "done",
            "content": [{"type": "text", "text": "ok"}],
            "usage": {"input_tokens": 1, "output_tokens": 1},
        }

    monkeypatch.setattr("app.main.stream_chat", fake_stream)
    _conversation_id, center_id = create_conversation(client)
    first = client.post(f"/api/threads/{center_id}/messages", json={"content": "Hello"})
    assert parse_sse(first.text)[-1][0] == "done"
    assert seen["web"] is False
    second = client.post(
        f"/api/threads/{center_id}/messages",
        json={"content": "Hello again", "web": True},
    )
    assert parse_sse(second.text)[-1][0] == "done"
    assert seen["web"] is True


def test_search_results_are_stored_whole_but_trimmed_for_the_browser(client):
    _conversation_id, center_id = create_conversation(client)
    page = "A" * 50
    blocks = [
        {
            "type": "web_search_tool_result",
            "tool_use_id": "toolu_1",
            "content": [
                {
                    "type": "web_search_result",
                    "title": "Docs",
                    "url": "https://example.com",
                    "encrypted_content": "keep-me-in-the-database",
                }
            ],
        },
        {
            "type": "web_fetch_tool_result",
            "tool_use_id": "toolu_2",
            "content": {
                "type": "web_fetch_result",
                "url": "https://example.com/page",
                "content": {
                    "type": "document",
                    "title": "Page",
                    "source": {"type": "text", "data": page},
                },
            },
        },
        {"type": "text", "text": "Based on the docs."},
    ]
    conn = connect()
    try:
        insert_message(
            conn,
            thread_id=center_id,
            parent_id=None,
            role="assistant",
            content=blocks,
        )
    finally:
        conn.close()

    payload = client.get(f"/api/threads/{center_id}/messages").json()
    dumped = json.dumps(payload)
    assert "encrypted_content" not in dumped
    assert "keep-me-in-the-database" not in dumped
    assert page not in dumped
    fetch = payload["messages"][0]["content"][1]
    assert fetch["content"]["content"]["source"] == {"type": "omitted", "characters": 50}
    assert payload["messages"][0]["content"][2]["text"] == "Based on the docs."

    conn = connect()
    try:
        stored = conn.execute("SELECT content FROM messages").fetchone()[0]
    finally:
        conn.close()
    assert "keep-me-in-the-database" in stored
    assert page in stored


def test_a_web_error_block_does_not_roll_back_the_turn(client, monkeypatch):
    monkeypatch.setattr("app.main.get_context", walk)
    monkeypatch.setattr("app.main.suggest_title", haiku_title)

    def fake_stream(path, goal, model=None, web=False, docs=False):
        yield {
            "type": "done",
            "content": [
                {
                    "type": "web_search_tool_result",
                    "tool_use_id": "toolu_err",
                    "content": {
                        "type": "web_search_tool_result_error",
                        "error_code": "too_many_requests",
                    },
                },
                {"type": "text", "text": "I could not search."},
            ],
            "usage": {"input_tokens": 1, "output_tokens": 1},
        }

    monkeypatch.setattr("app.main.stream_chat", fake_stream)
    _conversation_id, center_id = create_conversation(client)
    response = client.post(
        f"/api/threads/{center_id}/messages",
        json={"content": "What happened today", "web": True},
    )
    events = parse_sse(response.text)
    assert events[-1][0] == "done"
    messages = client.get(f"/api/threads/{center_id}/messages").json()["messages"]
    assert [message["role"] for message in messages] == ["user", "assistant"]
    assert messages[0]["content"][0]["text"] == "What happened today"


WALLS = b"# Walls\n\n## Names\nWall Maria, Wall Rose, and Wall Sina.\n"


def test_upload_lists_and_deletes_a_document(client, monkeypatch):
    use_fake_embedder(monkeypatch)
    conversation_id, _center = create_conversation(client)
    created = client.post(
        f"/api/conversations/{conversation_id}/documents",
        files={"file": ("walls.txt", WALLS, "text/plain")},
    )
    assert created.status_code == 201
    body = created.json()
    assert body["filename"] == "walls.txt"
    assert body["chunk_count"] >= 1

    listed = client.get(f"/api/conversations/{conversation_id}/documents")
    assert listed.status_code == 200
    assert [item["id"] for item in listed.json()] == [body["id"]]

    deleted = client.delete(f"/api/documents/{body['id']}")
    assert deleted.status_code == 204
    assert client.get(f"/api/conversations/{conversation_id}/documents").json() == []
    assert client.delete(f"/api/documents/{body['id']}").status_code == 404


def test_upload_rejects_unknown_conversation_bad_type_and_oversize(client, small_client, monkeypatch):
    use_fake_embedder(monkeypatch)
    missing = client.post(
        "/api/conversations/missing/documents",
        files={"file": ("walls.txt", WALLS, "text/plain")},
    )
    assert missing.status_code == 404

    conversation_id, _center = create_conversation(client)
    rejected = client.post(
        f"/api/conversations/{conversation_id}/documents",
        files={"file": ("a.png", b"not an image", "application/octet-stream")},
    )
    assert rejected.status_code == 400

    small_id, _center = create_conversation(small_client)
    oversized = small_client.post(
        f"/api/conversations/{small_id}/documents",
        files={"file": ("big.txt", b"x" * (1024 * 1024 + 1), "text/plain")},
    )
    assert oversized.status_code == 413


def _reply_stream(seen):
    def fake_stream(path, goal, model=None, web=False, docs=False):
        seen["docs"] = docs
        seen["goal"] = goal
        seen["blocks"] = path[-1]["content"]
        yield {
            "type": "done",
            "content": [{"type": "text", "text": "From the journals."}],
            "usage": {"input_tokens": 1, "output_tokens": 1},
        }

    return fake_stream


def test_docs_turn_stores_passages_and_keeps_the_typed_goal(client, monkeypatch):
    use_fake_embedder(monkeypatch)
    monkeypatch.setattr("app.main.get_context", walk)
    monkeypatch.setattr("app.main.suggest_title", haiku_title)
    seen = {}
    monkeypatch.setattr("app.main.stream_chat", _reply_stream(seen))
    conversation_id, center_id = create_conversation(client)
    uploaded = client.post(
        f"/api/conversations/{conversation_id}/documents",
        files={"file": ("walls.txt", WALLS, "text/plain")},
    )
    assert uploaded.status_code == 201

    response = client.post(
        f"/api/threads/{center_id}/messages",
        json={"content": "Where is Sina?", "docs": True},
    )
    assert parse_sse(response.text)[-1][0] == "done"
    assert seen["docs"] is True
    assert seen["goal"] == "Where is Sina?"
    assert seen["blocks"][-1] == {"type": "text", "text": "Where is Sina?"}
    assert seen["blocks"][0]["type"] == "search_result"
    assert client.get(f"/api/conversations/{conversation_id}/tree").json()["goal"] == "Where is Sina?"


def test_docs_without_documents_sends_text_only(client, monkeypatch):
    use_fake_embedder(monkeypatch)
    monkeypatch.setattr("app.main.get_context", walk)
    seen = {}
    monkeypatch.setattr("app.main.stream_chat", _reply_stream(seen))
    _conversation_id, center_id = create_conversation(client)
    response = client.post(
        f"/api/threads/{center_id}/messages",
        json={"content": "Where is Sina?", "docs": True},
    )
    assert parse_sse(response.text)[-1][0] == "done"
    assert seen["docs"] is False
    assert seen["blocks"] == [{"type": "text", "text": "Where is Sina?"}]


def test_docs_defaults_to_false(client, monkeypatch):
    monkeypatch.setattr("app.main.get_context", walk)
    seen = {}
    monkeypatch.setattr("app.main.stream_chat", _reply_stream(seen))
    _conversation_id, center_id = create_conversation(client)
    response = client.post(f"/api/threads/{center_id}/messages", json={"content": "Hello"})
    assert parse_sse(response.text)[-1][0] == "done"
    assert seen["docs"] is False


def test_failed_docs_turn_drops_the_passages(client, monkeypatch):
    use_fake_embedder(monkeypatch)
    monkeypatch.setattr("app.main.get_context", walk)

    def fake_stream(path, goal, model=None, web=False, docs=False):
        raise LLMError("nope")

    monkeypatch.setattr("app.main.stream_chat", fake_stream)
    conversation_id, center_id = create_conversation(client)
    client.post(
        f"/api/conversations/{conversation_id}/documents",
        files={"file": ("walls.txt", WALLS, "text/plain")},
    )
    response = client.post(
        f"/api/threads/{center_id}/messages",
        json={"content": "Where is Sina?", "docs": True},
    )
    assert parse_sse(response.text)[-1][0] == "error"
    assert client.get(f"/api/threads/{center_id}/messages").json()["messages"] == []
