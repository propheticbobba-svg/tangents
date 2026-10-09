"""Conversation map sent with a turn. It is not stored on any message."""

from __future__ import annotations

from typing import Any

MAP_HEADER = (
    "This block is a map of the current conversation, added by the app. It is not the user's message. Do not answer it, quote it, or tell the user it arrived.\n"
    "Messages before this one are the path from the root to here. They win over a sketch when they disagree, including a sketch that says there are no turns yet.\n"
    "The user's new message is the last text block of this same turn. Answer that, even when it is short or it disagrees with a sketch or with the pinned goal.\n"
    "Document passages, if any, sit between this map and that last text block. They are sources, not the question.\n"
    "The pinned goal is background, not the question. Branched-from lines name the parent node. They are not quotes of a message.\n"
    "Do not treat a sketch as a fact, a quote, or an answer. Do not fill in what a sketch leaves out.\n"
    "Use the map only to see what the user has been learning, which tangent came from which node, and what kind of work each node holds."
)
MAP_FOOTER = (
    "End of map. The user's new message is the last text block of this same turn, after this map. Answer that text. Do not answer this map."
)
MAP_MAX_CHARS = 8000
GOAL_MAX_CHARS = 500
_TRUNCATED = "(map truncated)"


def _children_of(threads: list[dict[str, Any]], parent_id: str) -> list[dict[str, Any]]:
    kids = [thread for thread in threads if thread.get("parent_thread_id") == parent_id]
    kids.sort(
        key=lambda thread: (
            thread["fork_position"] if thread.get("fork_position") is not None else -1,
            thread.get("created_at") or "",
            thread.get("id") or "",
        )
    )
    return kids


def _roots(threads: list[dict[str, Any]]) -> list[dict[str, Any]]:
    roots = [thread for thread in threads if thread.get("parent_thread_id") is None]
    roots.sort(key=lambda thread: (thread.get("created_at") or "", thread.get("id") or ""))
    return roots


def _protected_ids(by_id: dict[str, dict[str, Any]], current_thread_id: str) -> set[str]:
    """The current node and every ancestor. Empty when the current id is unknown."""
    protected: set[str] = set()
    current = by_id.get(current_thread_id)
    seen: set[str] = set()
    while current is not None and current["id"] not in seen:
        seen.add(current["id"])
        protected.add(current["id"])
        parent_id = current.get("parent_thread_id")
        current = by_id.get(parent_id) if parent_id else None
    return protected


def _finish(body: str) -> str:
    return f"{body}\n\n{MAP_FOOTER}"


def _render_body(
    threads: list[dict[str, Any]],
    current_thread_id: str,
    goal: str | None,
    excluded: set[str],
    truncated: bool,
) -> str:
    by_id = {thread["id"]: thread for thread in threads}
    lines: list[str] = [MAP_HEADER, ""]

    if goal and goal.strip():
        collapsed = " ".join(goal.split())
        if len(collapsed) > GOAL_MAX_CHARS:
            collapsed = collapsed[:GOAL_MAX_CHARS].rstrip() + "…"
        lines.append(f"Pinned goal: {collapsed}")
        lines.append("")

    def emit(thread: dict[str, Any], depth: int) -> None:
        if thread["id"] in excluded:
            return
        indent = "  " * depth
        here = " (you are here)" if thread["id"] == current_thread_id else ""
        lines.append(f"{indent}- {thread['title']}{here}")
        detail = f"{indent}  "
        parent_id = thread.get("parent_thread_id")
        if parent_id:
            parent = by_id.get(parent_id)
            parent_title = parent["title"] if parent else "unknown"
            lines.append(f"{detail}Branched from: {parent_title}")
        sketch = (thread.get("sketch") or "").strip()
        lines.append(f"{detail}Sketch: {sketch if sketch else 'No turns yet.'}")
        for kid in _children_of(threads, thread["id"]):
            emit(kid, depth + 1)

    for root in _roots(threads):
        emit(root, 0)
    if truncated:
        lines.append(_TRUNCATED)
    return "\n".join(lines)


def _drop_candidate(
    threads: list[dict[str, Any]],
    excluded: set[str],
    protected: set[str],
) -> str | None:
    """The deepest unprotected node still on the map. Later siblings win ties."""
    best: tuple[int, int, str] | None = None

    def walk(thread: dict[str, Any], depth: int, sibling_index: int) -> None:
        nonlocal best
        if thread["id"] in excluded:
            return
        if thread["id"] not in protected:
            key = (depth, sibling_index, thread["id"])
            if best is None or key > best:
                best = key
        for index, kid in enumerate(_children_of(threads, thread["id"])):
            walk(kid, depth + 1, index)

    for index, root in enumerate(_roots(threads)):
        walk(root, 0, index)
    return best[2] if best is not None else None


def _hard_clip(body: str) -> str:
    suffix = f"\n{_TRUNCATED}\n\n{MAP_FOOTER}"
    room = MAP_MAX_CHARS - len(suffix)
    clipped = body[: max(room, 0)]
    if "\n" in clipped:
        clipped = clipped.rsplit("\n", 1)[0]
    if len(clipped) > room:
        clipped = clipped[: max(room, 0)]
    return clipped + suffix


def render_learning_map(
    threads: list[dict],
    current_thread_id: str,
    goal: str | None,
    path_message_ids: set[str],
) -> str:
    """A title-and-sketch outline of every node in this conversation."""
    del path_message_ids
    by_id = {thread["id"]: thread for thread in threads}
    protected = _protected_ids(by_id, current_thread_id)

    body = _render_body(threads, current_thread_id, goal, set(), False)
    text = _finish(body)
    if len(text) <= MAP_MAX_CHARS:
        return text

    excluded: set[str] = set()
    while True:
        candidate = _drop_candidate(threads, excluded, protected)
        if candidate is None:
            return _hard_clip(_render_body(threads, current_thread_id, goal, excluded, False))
        excluded.add(candidate)
        text = _finish(_render_body(threads, current_thread_id, goal, excluded, True))
        if len(text) <= MAP_MAX_CHARS:
            return text
