def get_context(messages: list[dict], message_id: str) -> list[dict]:
    """Return the path from the root to message_id (inclusive), oldest first.

    Walk parent_id pointers back to the root (parent_id None), then reverse.
    That path is the only context sent to the API for this message.

    `messages` are row dicts with id, parent_id, role, content (list of content
    blocks), thread_id, created_at. Returns the same dicts, unmodified.
    Raises KeyError if message_id is unknown, or if a parent_id does not
    point at a message in `messages`.
    """
    by_id = {message["id"]: message for message in messages}
    if message_id not in by_id:
        raise KeyError(message_id)

    path: list[dict] = []
    seen: set[str] = set()
    current_id: str | None = message_id
    while current_id is not None:
        if current_id in seen:
            raise ValueError(f"parent cycle at {current_id}")
        seen.add(current_id)
        current = by_id[current_id]
        path.append(current)
        current_id = current["parent_id"]

    path.reverse()
    return path
