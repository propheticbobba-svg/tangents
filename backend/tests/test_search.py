"""Search across every conversation and side node."""

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


def new_conversation(client: TestClient) -> tuple[str, str]:
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


def fork(client: TestClient, message_id: str) -> str:
    response = client.post("/api/threads", json={"fork_message_id": message_id})
    assert response.status_code == 201
    return response.json()["id"]


def search(client: TestClient, q: str) -> dict:
    response = client.get("/api/search", params={"q": q})
    assert response.status_code == 200
    return response.json()


def test_finds_a_word_in_a_center_node_and_a_side_node_two_forks_deep(client):
    conv1, center1 = new_conversation(client)
    first = save(center1, None, "user", "I saw a zebra today")
    conv2, center2 = new_conversation(client)
    client.patch(f"/api/conversations/{conv2}", json={"goal": "Animals trip"})
    answer = save(center2, None, "assistant", "hello")
    side = fork(client, answer["id"])
    side_answer = save(side, answer["id"], "assistant", "side reply")
    deep = fork(client, side_answer["id"])
    deep_msg = save(deep, side_answer["id"], "user", "Tell me about the ZEBRA stripes")

    data = search(client, "zebra")
    assert data["truncated"] is False
    by_id = {r["message_id"]: r for r in data["results"]}
    assert set(by_id) == {first["id"], deep_msg["id"]}
    assert [r["message_id"] for r in data["results"]] == [deep_msg["id"], first["id"]]
    a = by_id[first["id"]]
    assert (a["conversation_id"], a["thread_id"], a["thread_title"]) == (conv1, center1, "Center")
    assert a["is_side_node"] is False
    assert a["conversation_name"] == "Untitled"
    b = by_id[deep_msg["id"]]
    assert (b["conversation_id"], b["thread_id"], b["thread_title"]) == (conv2, deep, "Side node")
    assert b["is_side_node"] is True
    assert b["conversation_name"] == "Animals trip"
    assert b["role"] == "user"


def test_every_word_must_match_in_any_order_and_any_case(client):
    _, center = new_conversation(client)
    hit1 = save(center, None, "user", "Party with TEA and quantum cakes")
    hit2 = save(center, hit1["id"], "assistant", "quantum tea party")
    save(center, hit2["id"], "user", "only quantum and tea here")

    ids = {r["message_id"] for r in search(client, "Quantum Tea party")["results"]}
    assert ids == {hit1["id"], hit2["id"]}


def test_snippet_contains_the_first_matched_word(client):
    _, center = new_conversation(client)
    text = ("filler " * 40) + "needle" + (" padding" * 40) + " haystack"
    save(center, None, "user", text)

    result = search(client, "needle haystack")["results"][0]
    assert "needle" in result["snippet"]
    assert len(result["snippet"]) <= 170
    assert result["snippet"].startswith("…")


def test_thinking_and_document_passages_do_not_match(client):
    _, center = new_conversation(client)
    save(center, None, "user", [
        {"type": "search_result", "source": "doc", "title": "d",
         "content": [{"type": "text", "text": "passageword inside"}]},
        {"type": "text", "text": "typed question"},
    ])
    save(center, None, "assistant", [
        {"type": "thinking", "thinking": "secretword reasoning", "signature": "x"},
        {"type": "text", "text": "visible answer"},
    ])

    assert search(client, "secretword")["results"] == []
    assert search(client, "passageword")["results"] == []
    assert len(search(client, "typed")["results"]) == 1
    assert len(search(client, "visible")["results"]) == 1


def test_deleted_conversation_and_side_node_drop_out_of_results(client):
    conv1, center1 = new_conversation(client)
    keep = save(center1, None, "assistant", "kiwi stays")
    side = fork(client, keep["id"])
    save(side, keep["id"], "user", "kiwi in side node")
    conv2, center2 = new_conversation(client)
    save(center2, None, "user", "kiwi elsewhere")
    assert len(search(client, "kiwi")["results"]) == 3

    assert client.delete(f"/api/threads/{side}").status_code == 204
    assert len(search(client, "kiwi")["results"]) == 2

    assert client.delete(f"/api/conversations/{conv2}").status_code == 204
    results = search(client, "kiwi")["results"]
    assert [r["message_id"] for r in results] == [keep["id"]]


def test_blank_query_is_rejected_and_no_match_is_an_empty_list(client):
    new_conversation(client)
    assert client.get("/api/search", params={"q": ""}).status_code == 400
    assert client.get("/api/search", params={"q": "   "}).status_code == 400
    assert client.get("/api/search").status_code == 400
    response = client.get("/api/search", params={"q": "nothing"})
    assert response.status_code == 200
    assert response.json()["results"] == []
    assert response.json()["truncated"] is False


def test_results_are_capped_at_fifty_and_say_so(client):
    _, center = new_conversation(client)
    parent = None
    for i in range(52):
        parent = save(center, parent and parent["id"], "user", f"banana {i}")
    data = search(client, "banana")
    assert len(data["results"]) == 50
    assert data["truncated"] is True
