"""HTTP API for the tangent tree.

Chat turns stream over SSE. Context for a turn is exactly get_context's path.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
from collections.abc import Iterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.config import load_settings
from app.context import get_context
from app.db import (
    center_thread,
    connect,
    create_conversation,
    create_side_node,
    delete_message,
    get_conversation,
    get_thread,
    init_db,
    insert_message,
    latest_in_thread,
    list_conversations,
    messages_in_conversation,
    next_parent_id,
    note_user_message,
    thread_view,
    tree,
    undo_user_message,
    update_goal,
)
from app.llm import LLMError, stream_chat, summarize_side_node

logger = logging.getLogger("tangents")
if not logger.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
    logger.addHandler(_handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    settings = load_settings()
    import app.config as config

    config._settings = settings
    init_db()
    if not settings.api_key:
        logger.warning(
            "ANTHROPIC_API_KEY is not set in backend/.env; chat calls will fail until it is."
        )
    if settings.model and not settings.compaction_supported:
        logger.warning(
            "ANTHROPIC_MODEL %s is not on the compaction-supported list; "
            "threshold compaction will be skipped for this model.",
            settings.model,
        )
    yield


app = FastAPI(title="Tangents", lifespan=_lifespan)


class GoalUpdate(BaseModel):
    goal: str


class NewMessage(BaseModel):
    content: str = Field(min_length=1)
    model: str | None = None


class NewThread(BaseModel):
    fork_message_id: str


class MergeBody(BaseModel):
    summary: str = Field(min_length=1)


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


@app.get("/api/conversations")
def get_conversations() -> list[dict]:
    conn = connect()
    try:
        return list_conversations(conn)
    finally:
        conn.close()


@app.post("/api/conversations", status_code=201)
def post_conversation() -> dict:
    conn = connect()
    try:
        conversation = create_conversation(conn)
        conversation["center_thread_id"] = center_thread(conn, conversation["id"])["id"]
        return conversation
    finally:
        conn.close()


@app.patch("/api/conversations/{conversation_id}")
def patch_conversation(conversation_id: str, body: GoalUpdate) -> dict:
    conn = connect()
    try:
        conversation = update_goal(conn, conversation_id, body.goal)
        if conversation is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        return conversation
    finally:
        conn.close()


@app.get("/api/conversations/{conversation_id}/tree")
def get_tree(conversation_id: str) -> dict:
    conn = connect()
    try:
        payload = tree(conn, conversation_id)
        if payload is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        return payload
    finally:
        conn.close()


@app.get("/api/threads/{thread_id}/messages")
def get_messages(thread_id: str) -> dict:
    conn = connect()
    try:
        thread = get_thread(conn, thread_id)
        if thread is None:
            raise HTTPException(status_code=404, detail="Thread not found")
        return thread_view(conn, thread)
    finally:
        conn.close()


@app.post("/api/threads", status_code=201)
def post_thread(body: NewThread) -> dict:
    conn = connect()
    try:
        try:
            thread = create_side_node(conn, body.fork_message_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if thread is None:
            raise HTTPException(status_code=404, detail="Message not found")
        return thread
    finally:
        conn.close()


def _fail_turn(conn, thread_id: str, message_id: str, undo: dict) -> None:
    delete_message(conn, message_id)
    undo_user_message(conn, thread_id, undo)


def _chat_events(thread_id: str, content: str, model: str | None) -> Iterator[str]:
    conn = connect()
    message_id: str | None = None
    undo: dict = {}
    try:
        thread = get_thread(conn, thread_id)
        if thread is None:
            yield _sse("error", {"error": "Thread not found"})
            return
        parent_id = next_parent_id(conn, thread)
        user_message = insert_message(
            conn,
            thread_id=thread_id,
            parent_id=parent_id,
            role="user",
            content=[{"type": "text", "text": content}],
        )
        message_id = user_message["id"]
        undo = note_user_message(conn, thread, content)
        yield _sse("user_message", user_message)

        conversation = get_conversation(conn, thread["conversation_id"])
        goal = conversation["goal"] if conversation else None
        try:
            path = get_context(messages_in_conversation(conn, thread["conversation_id"]), message_id)
        except NotImplementedError:
            _fail_turn(conn, thread_id, message_id, undo)
            message_id = None
            yield _sse("error", {"error": "get_context is not implemented yet"})
            return
        except KeyError:
            _fail_turn(conn, thread_id, message_id, undo)
            message_id = None
            yield _sse("error", {"error": "Could not build context for this message"})
            return

        try:
            done: dict | None = None
            for event in stream_chat(path, goal, model):
                if event["type"] == "delta":
                    yield _sse("delta", {"text": event["text"]})
                elif event["type"] == "compaction":
                    yield _sse("compaction", {"content": event["content"]})
                elif event["type"] == "done":
                    done = event
            if done is None:
                raise LLMError("The model returned no message")
            assistant = insert_message(
                conn,
                thread_id=thread_id,
                parent_id=message_id,
                role="assistant",
                content=done["content"],
                usage=done["usage"],
            )
            message_id = None
            yield _sse("done", assistant)
        except LLMError as exc:
            _fail_turn(conn, thread_id, message_id, undo)
            message_id = None
            yield _sse("error", {"error": str(exc)})
        except Exception as exc:
            logger.exception("chat turn failed")
            if message_id is not None:
                _fail_turn(conn, thread_id, message_id, undo)
                message_id = None
            yield _sse("error", {"error": str(exc)})
    finally:
        conn.close()


@app.post("/api/threads/{thread_id}/messages")
async def post_message(thread_id: str, body: NewMessage) -> StreamingResponse:
    content = body.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="Message is empty")
    conn = connect()
    try:
        if get_thread(conn, thread_id) is None:
            raise HTTPException(status_code=404, detail="Thread not found")
    finally:
        conn.close()

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[str | None] = asyncio.Queue()

    def worker() -> None:
        try:
            for chunk in _chat_events(thread_id, content, body.model):
                loop.call_soon_threadsafe(queue.put_nowait, chunk)
        except Exception as exc:
            logger.exception("chat stream failed")
            loop.call_soon_threadsafe(queue.put_nowait, _sse("error", {"error": str(exc)}))
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)

    threading.Thread(target=worker, daemon=True).start()

    async def generate():
        while True:
            chunk = await queue.get()
            if chunk is None:
                break
            yield chunk

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def _side_tip(conn, thread_id: str):
    thread = get_thread(conn, thread_id)
    if thread is None:
        raise HTTPException(status_code=404, detail="Thread not found")
    if thread["parent_thread_id"] is None:
        raise HTTPException(status_code=400, detail="The center node has no side node to summarize")
    tip = latest_in_thread(conn, thread_id)
    if tip is None:
        raise HTTPException(status_code=400, detail="This side node has no messages to summarize")
    return thread, tip


@app.post("/api/threads/{thread_id}/summary")
def post_summary(thread_id: str, model: str | None = None) -> dict:
    conn = connect()
    try:
        thread, tip = _side_tip(conn, thread_id)
        try:
            path = get_context(messages_in_conversation(conn, thread["conversation_id"]), tip["id"])
        except NotImplementedError as exc:
            raise HTTPException(status_code=500, detail="get_context is not implemented yet") from exc
        try:
            summary = summarize_side_node(path, model)
        except LLMError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"summary": summary}
    finally:
        conn.close()


@app.post("/api/threads/{thread_id}/merge", status_code=201)
def post_merge(thread_id: str, body: MergeBody) -> dict:
    conn = connect()
    try:
        thread = get_thread(conn, thread_id)
        if thread is None:
            raise HTTPException(status_code=404, detail="Thread not found")
        if thread["parent_thread_id"] is None:
            raise HTTPException(status_code=400, detail="The center node has nothing to merge")
        parent = get_thread(conn, thread["parent_thread_id"])
        if parent is None:
            raise HTTPException(status_code=404, detail="Parent thread not found")
        summary = body.summary.strip()
        if not summary:
            raise HTTPException(status_code=400, detail="Summary is empty")
        prefix = "From side node: "
        note = summary if summary.startswith(prefix) else prefix + summary
        message = insert_message(
            conn,
            thread_id=parent["id"],
            parent_id=next_parent_id(conn, parent),
            role="user",
            content=[{"type": "text", "text": note}],
            is_note=True,
        )
        return message
    finally:
        conn.close()
