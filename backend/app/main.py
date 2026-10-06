"""HTTP API for the tangent tree.

Chat turns stream over SSE. Context for a turn is exactly get_context's path.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
from pathlib import Path
from collections.abc import Iterator
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.config import get_settings, load_settings
from app.context import get_context
from app.db import (
    center_thread,
    connect,
    create_conversation,
    create_side_node,
    delete_conversation,
    delete_message,
    delete_thread,
    get_conversation,
    get_thread,
    init_db,
    insert_message,
    list_conversations,
    messages_in_conversation,
    next_parent_id,
    note_user_message,
    rename_thread,
    short_title,
    text_of,
    thread_view,
    tree,
    undo_user_message,
    update_goal,
)
from app.llm import LLMError, stream_chat, suggest_title
from app.rag import (
    UnsupportedDocument,
    delete_document,
    ingest,
    list_documents,
    search,
    to_search_result_blocks,
)

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
    web: bool = False
    docs: bool = False
    charts: bool = False
    effort: Literal["low", "medium", "high", "xhigh", "max"] | None = None
    extended_thinking: bool = False


class NewThread(BaseModel):
    fork_message_id: str


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def _slim_blocks(blocks: list) -> list:
    """Drop payloads the browser cannot use.

    Response shaping only. Stored rows and anything sent to Anthropic keep the full
    blocks, because the API requires encrypted content back unmodified.
    """
    slimmed: list = []
    for block in blocks:
        if not isinstance(block, dict):
            slimmed.append(block)
            continue
        block_type = block.get("type")
        if block_type == "web_search_tool_result":
            content = block.get("content")
            if isinstance(content, list):
                block = {
                    **block,
                    "content": [
                        {key: value for key, value in item.items() if key != "encrypted_content"}
                        if isinstance(item, dict)
                        else item
                        for item in content
                    ],
                }
        elif block_type == "thinking":
            block = {key: value for key, value in block.items() if key != "signature"}
        elif block_type == "redacted_thinking":
            block = {"type": "redacted_thinking"}
        elif block_type == "web_fetch_tool_result":
            content = block.get("content")
            document = content.get("content") if isinstance(content, dict) else None
            if isinstance(document, dict):
                source = document.get("source")
                data = source.get("data") if isinstance(source, dict) else None
                block = {
                    **block,
                    "content": {
                        **content,
                        "content": {
                            **document,
                            "source": {
                                "type": "omitted",
                                "characters": len(data) if isinstance(data, str) else 0,
                            },
                        },
                    },
                }
        slimmed.append(block)
    return slimmed


def slim_message(message: dict | None) -> dict | None:
    if message is None:
        return None
    return {**message, "content": _slim_blocks(message["content"])}


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


@app.delete("/api/conversations/{conversation_id}", status_code=204)
def remove_conversation(conversation_id: str) -> None:
    conn = connect()
    try:
        if not delete_conversation(conn, conversation_id):
            raise HTTPException(status_code=404, detail="Conversation not found")
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


@app.get("/api/conversations/{conversation_id}/documents")
def get_documents(conversation_id: str) -> list[dict]:
    conn = connect()
    try:
        if get_conversation(conn, conversation_id) is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        return list_documents(conn, conversation_id)
    finally:
        conn.close()


@app.post("/api/conversations/{conversation_id}/documents", status_code=201)
def post_document(conversation_id: str, file: UploadFile = File()) -> dict:
    filename = Path(file.filename or "upload").name
    data = file.file.read()
    limit = get_settings().max_upload_mb * 1024 * 1024
    if len(data) > limit:
        raise HTTPException(
            status_code=413,
            detail=f"File is larger than {get_settings().max_upload_mb} MB",
        )
    conn = connect()
    try:
        if get_conversation(conn, conversation_id) is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        try:
            return ingest(conn, conversation_id, filename, data)
        except UnsupportedDocument as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        conn.close()


@app.delete("/api/documents/{document_id}", status_code=204)
def remove_document(document_id: str) -> None:
    conn = connect()
    try:
        if not delete_document(conn, document_id):
            raise HTTPException(status_code=404, detail="Document not found")
    finally:
        conn.close()


@app.get("/api/threads/{thread_id}/messages")
def get_messages(thread_id: str) -> dict:
    conn = connect()
    try:
        thread = get_thread(conn, thread_id)
        if thread is None:
            raise HTTPException(status_code=404, detail="Thread not found")
        view = thread_view(conn, thread)
        view["messages"] = [slim_message(message) for message in view["messages"]]
        view["forked_from"] = slim_message(view["forked_from"])
        return view
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


@app.delete("/api/threads/{thread_id}", status_code=204)
def remove_thread(thread_id: str) -> None:
    conn = connect()
    try:
        deleted = delete_thread(conn, thread_id)
        if deleted is False:
            raise HTTPException(status_code=404, detail="Thread not found")
        if deleted is None:
            raise HTTPException(status_code=400, detail="The center node cannot be deleted")
    finally:
        conn.close()


def _fail_turn(conn, thread_id: str, message_id: str, undo: dict) -> None:
    delete_message(conn, message_id)
    undo_user_message(conn, thread_id, undo)


def _name_first_turn(conn, thread_id: str, content: str, undo: dict, reply_text: str = "") -> None:
    """Name the node after its first successful reply. A title failure keeps the turn."""
    if not undo.get("first_turn"):
        return
    try:
        title = (suggest_title(content, reply_text) or "").strip() or short_title(content)
        rename_thread(conn, thread_id, title)
    except Exception:
        logger.exception("could not name the node")
        try:
            rename_thread(conn, thread_id, short_title(content))
        except Exception:
            logger.exception("could not store the fallback title")


def _chat_events(
    thread_id: str,
    content: str,
    model: str | None,
    web: bool,
    docs: bool,
    effort: str | None = None,
    extended_thinking: bool = False,
    charts: bool = False,
) -> Iterator[str]:
    conn = connect()
    message_id: str | None = None
    undo: dict = {}
    try:
        thread = get_thread(conn, thread_id)
        if thread is None:
            yield _sse("error", {"error": "Thread not found"})
            return
        parent_id = next_parent_id(conn, thread)
        blocks: list[dict] = []
        if docs:
            has_chunks = conn.execute(
                "SELECT 1 FROM chunks WHERE conversation_id = ? LIMIT 1",
                (thread["conversation_id"],),
            ).fetchone()
            if has_chunks:
                blocks = to_search_result_blocks(search(conn, thread["conversation_id"], content))
        user_message = insert_message(
            conn,
            thread_id=thread_id,
            parent_id=parent_id,
            role="user",
            content=[*blocks, {"type": "text", "text": content}],
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
            for event in stream_chat(
                path,
                goal,
                model,
                web=web,
                docs=bool(blocks),
                effort=effort,
                extended_thinking=extended_thinking,
                charts=charts,
            ):
                if event["type"] == "delta":
                    yield _sse("delta", {"text": event["text"]})
                elif event["type"] == "thinking":
                    yield _sse("thinking", {"text": event["text"]})
                elif event["type"] == "compaction":
                    yield _sse("compaction", {"content": event["content"]})
                elif event["type"] == "web_activity":
                    yield _sse("web_activity", event)
                elif event["type"] == "web_result":
                    yield _sse("web_result", event)
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
            reply_text = text_of(done["content"])
            if reply_text:
                _name_first_turn(conn, thread_id, content, undo, reply_text)
            elif undo.get("first_turn"):
                try:
                    rename_thread(conn, thread_id, short_title(content))
                except Exception:
                    logger.exception("could not store the fallback title")
            yield _sse("done", slim_message(assistant))
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
            for chunk in _chat_events(
                thread_id,
                content,
                body.model,
                body.web,
                body.docs,
                body.effort,
                body.extended_thinking,
                charts=body.charts,
            ):
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
