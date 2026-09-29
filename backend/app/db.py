"""SQLite storage. One file, three tables, no accounts."""

from __future__ import annotations

import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

BACKEND_DIR = Path(__file__).resolve().parent.parent

SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    goal TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    parent_thread_id TEXT REFERENCES threads(id),
    fork_message_id TEXT REFERENCES messages(id),
    title TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    parent_id TEXT REFERENCES messages(id),
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    created_at TEXT NOT NULL,
    is_note INTEGER NOT NULL DEFAULT 0,
    usage TEXT
);

CREATE INDEX IF NOT EXISTS idx_threads_conversation ON threads(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id);
"""


def db_path() -> Path:
    override = os.environ.get("TANGENTS_DB")
    if override:
        return Path(override)
    return BACKEND_DIR / "tangents.db"


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(db_path())
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = connect()
    try:
        conn.executescript(SCHEMA)
        conn.commit()
    finally:
        conn.close()


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id() -> str:
    return uuid.uuid4().hex


def _message_from_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "parent_id": row["parent_id"],
        "role": row["role"],
        "content": json.loads(row["content"]),
        "thread_id": row["thread_id"],
        "created_at": row["created_at"],
        "is_note": bool(row["is_note"]),
        "usage": json.loads(row["usage"]) if row["usage"] else None,
    }


def _thread_from_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "conversation_id": row["conversation_id"],
        "parent_thread_id": row["parent_thread_id"],
        "fork_message_id": row["fork_message_id"],
        "title": row["title"],
        "created_at": row["created_at"],
    }


def _conversation_from_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "goal": row["goal"],
        "created_at": row["created_at"],
    }


def text_of(content: list[dict]) -> str:
    parts: list[str] = []
    for block in content:
        if block.get("type") == "text" and block.get("text"):
            parts.append(block["text"])
    return "\n".join(parts)


def short_title(text: str) -> str:
    collapsed = " ".join(text.split())
    if len(collapsed) <= 40:
        return collapsed
    return collapsed[:40].rstrip() + "…"


def snippet(text: str | None, limit: int = 120) -> str | None:
    if not text:
        return None
    collapsed = " ".join(text.split())
    if len(collapsed) <= limit:
        return collapsed
    return collapsed[:limit].rstrip() + "…"


def create_conversation(conn: sqlite3.Connection) -> dict[str, Any]:
    conversation_id = new_id()
    thread_id = new_id()
    created_at = now()
    conn.execute(
        "INSERT INTO conversations (id, goal, created_at) VALUES (?, NULL, ?)",
        (conversation_id, created_at),
    )
    conn.execute(
        """
        INSERT INTO threads
            (id, conversation_id, parent_thread_id, fork_message_id, title, created_at)
        VALUES (?, ?, NULL, NULL, 'Center', ?)
        """,
        (thread_id, conversation_id, created_at),
    )
    conn.commit()
    return get_conversation(conn, conversation_id)


def list_conversations(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM conversations ORDER BY created_at DESC"
    ).fetchall()
    conversations = []
    for row in rows:
        conversation = _conversation_from_row(row)
        conversation["goal_snippet"] = snippet(conversation["goal"], 80)
        conversations.append(conversation)
    return conversations


def get_conversation(conn: sqlite3.Connection, conversation_id: str) -> dict[str, Any] | None:
    row = conn.execute(
        "SELECT * FROM conversations WHERE id = ?", (conversation_id,)
    ).fetchone()
    if row is None:
        return None
    conversation = _conversation_from_row(row)
    conversation["goal_snippet"] = snippet(conversation["goal"], 80)
    return conversation


def update_goal(conn: sqlite3.Connection, conversation_id: str, goal: str) -> dict[str, Any] | None:
    if get_conversation(conn, conversation_id) is None:
        return None
    conn.execute(
        "UPDATE conversations SET goal = ? WHERE id = ?",
        (goal, conversation_id),
    )
    conn.commit()
    return get_conversation(conn, conversation_id)


def get_thread(conn: sqlite3.Connection, thread_id: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM threads WHERE id = ?", (thread_id,)).fetchone()
    if row is None:
        return None
    return _thread_from_row(row)


def list_threads(conn: sqlite3.Connection, conversation_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM threads WHERE conversation_id = ? ORDER BY created_at ASC, id ASC",
        (conversation_id,),
    ).fetchall()
    return [_thread_from_row(row) for row in rows]


def center_thread(conn: sqlite3.Connection, conversation_id: str) -> dict[str, Any] | None:
    row = conn.execute(
        """
        SELECT * FROM threads
        WHERE conversation_id = ? AND parent_thread_id IS NULL
        """,
        (conversation_id,),
    ).fetchone()
    if row is None:
        return None
    return _thread_from_row(row)


def create_side_node(conn: sqlite3.Connection, fork_message_id: str) -> dict[str, Any] | None:
    message = get_message(conn, fork_message_id)
    if message is None:
        return None
    if message["role"] != "assistant":
        raise ValueError("Side nodes can only be forked from an assistant message")
    parent = get_thread(conn, message["thread_id"])
    if parent is None:
        return None
    thread_id = new_id()
    created_at = now()
    conn.execute(
        """
        INSERT INTO threads
            (id, conversation_id, parent_thread_id, fork_message_id, title, created_at)
        VALUES (?, ?, ?, ?, 'Side node', ?)
        """,
        (thread_id, parent["conversation_id"], parent["id"], fork_message_id, created_at),
    )
    conn.commit()
    return get_thread(conn, thread_id)


def get_message(conn: sqlite3.Connection, message_id: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM messages WHERE id = ?", (message_id,)).fetchone()
    if row is None:
        return None
    return _message_from_row(row)


def messages_in_thread(conn: sqlite3.Connection, thread_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT * FROM messages
        WHERE thread_id = ?
        ORDER BY created_at ASC, id ASC
        """,
        (thread_id,),
    ).fetchall()
    return [_message_from_row(row) for row in rows]


def messages_in_conversation(conn: sqlite3.Connection, conversation_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT m.* FROM messages m
        JOIN threads t ON t.id = m.thread_id
        WHERE t.conversation_id = ?
        ORDER BY m.created_at ASC, m.id ASC
        """,
        (conversation_id,),
    ).fetchall()
    return [_message_from_row(row) for row in rows]


def latest_in_thread(conn: sqlite3.Connection, thread_id: str) -> dict[str, Any] | None:
    messages = messages_in_thread(conn, thread_id)
    if not messages:
        return None
    return messages[-1]


def next_parent_id(conn: sqlite3.Connection, thread: dict[str, Any]) -> str | None:
    latest = latest_in_thread(conn, thread["id"])
    if latest is not None:
        return latest["id"]
    return thread["fork_message_id"]


def insert_message(
    conn: sqlite3.Connection,
    *,
    thread_id: str,
    parent_id: str | None,
    role: str,
    content: list[dict],
    is_note: bool = False,
    usage: dict | None = None,
) -> dict[str, Any]:
    message_id = new_id()
    created_at = now()
    conn.execute(
        """
        INSERT INTO messages
            (id, parent_id, role, content, thread_id, created_at, is_note, usage)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            message_id,
            parent_id,
            role,
            json.dumps(content),
            thread_id,
            created_at,
            1 if is_note else 0,
            json.dumps(usage) if usage is not None else None,
        ),
    )
    conn.commit()
    message = get_message(conn, message_id)
    assert message is not None
    return message


def delete_message(conn: sqlite3.Connection, message_id: str) -> None:
    conn.execute("DELETE FROM messages WHERE id = ?", (message_id,))
    conn.commit()


def rename_thread(conn: sqlite3.Connection, thread_id: str, title: str) -> None:
    conn.execute("UPDATE threads SET title = ? WHERE id = ?", (title, thread_id))
    conn.commit()


def fork_position(conn: sqlite3.Connection, thread: dict[str, Any]) -> int | None:
    if thread["fork_message_id"] is None or thread["parent_thread_id"] is None:
        return None
    parent_messages = messages_in_thread(conn, thread["parent_thread_id"])
    for index, message in enumerate(parent_messages):
        if message["id"] == thread["fork_message_id"]:
            return index
    return None


def ancestry(conn: sqlite3.Connection, thread: dict[str, Any]) -> list[dict[str, str]]:
    chain: list[dict[str, str]] = []
    seen: set[str] = set()
    current: dict[str, Any] | None = thread
    while current is not None and current["id"] not in seen:
        seen.add(current["id"])
        chain.append({"id": current["id"], "title": current["title"]})
        parent_id = current["parent_thread_id"]
        current = get_thread(conn, parent_id) if parent_id else None
    chain.reverse()
    return chain


def thread_view(conn: sqlite3.Connection, thread: dict[str, Any]) -> dict[str, Any]:
    forked_from = None
    fork_snippet = None
    if thread["fork_message_id"]:
        forked_from = get_message(conn, thread["fork_message_id"])
        if forked_from is not None:
            fork_snippet = snippet(text_of(forked_from["content"]))
    view = dict(thread)
    view["fork_snippet"] = fork_snippet
    view["fork_position"] = fork_position(conn, thread)
    return {
        "thread": view,
        "messages": messages_in_thread(conn, thread["id"]),
        "forked_from": forked_from,
        "ancestry": ancestry(conn, thread),
    }


def tree(conn: sqlite3.Connection, conversation_id: str) -> dict[str, Any] | None:
    conversation = get_conversation(conn, conversation_id)
    if conversation is None:
        return None
    threads = []
    for thread in list_threads(conn, conversation_id):
        item = dict(thread)
        item["fork_position"] = fork_position(conn, thread)
        item["fork_snippet"] = None
        if thread["fork_message_id"]:
            message = get_message(conn, thread["fork_message_id"])
            if message is not None:
                item["fork_snippet"] = snippet(text_of(message["content"]))
        threads.append(item)
    return {
        "conversation_id": conversation_id,
        "goal": conversation["goal"],
        "threads": threads,
    }


def note_user_message(conn: sqlite3.Connection, thread: dict[str, Any], text: str) -> dict[str, Any]:
    """Title the thread from its first user message, and seed the goal on the center node.

    Returns undo info so a failed turn can put the title and goal back.
    """
    undo: dict[str, Any] = {}
    count = conn.execute(
        "SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?",
        (thread["id"],),
    ).fetchone()["n"]
    if count != 1:
        return undo
    undo["title"] = thread["title"]
    rename_thread(conn, thread["id"], short_title(text))
    if thread["parent_thread_id"] is None:
        conversation = get_conversation(conn, thread["conversation_id"])
        if conversation is not None and conversation["goal"] is None:
            undo["clear_goal"] = conversation["id"]
            conn.execute(
                "UPDATE conversations SET goal = ? WHERE id = ?",
                (text, conversation["id"]),
            )
            conn.commit()
    return undo


def undo_user_message(conn: sqlite3.Connection, thread_id: str, undo: dict[str, Any]) -> None:
    if "title" in undo:
        rename_thread(conn, thread_id, undo["title"])
    if "clear_goal" in undo:
        conn.execute(
            "UPDATE conversations SET goal = NULL WHERE id = ?",
            (undo["clear_goal"],),
        )
        conn.commit()
