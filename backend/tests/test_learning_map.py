"""Conversation map rendering and the threads.sketch migration."""

from app.db import connect, get_thread, init_db, set_thread_sketch
from app.learning_map import MAP_FOOTER, MAP_HEADER, MAP_MAX_CHARS, render_learning_map

WORKED_EXAMPLE = """This block is a map of the current conversation, added by the app. It is not the user's message. Do not answer it, quote it, or tell the user it arrived.
Messages before this one are the path from the root to here. They win over a sketch when they disagree, including a sketch that says there are no turns yet.
The user's new message is the last text block of this same turn. Answer that, even when it is short or it disagrees with a sketch or with the pinned goal.
Document passages, if any, sit between this map and that last text block. They are sources, not the question.
The pinned goal is background, not the question. Branched-from lines name the parent node. They are not quotes of a message.
Do not treat a sketch as a fact, a quote, or an answer. Do not fill in what a sketch leaves out.
Use the map only to see what the user has been learning, which tangent came from which node, and what kind of work each node holds.

Pinned goal: Understand the theorem

- Center
  Sketch: Working through the main argument.
  - Proofs (you are here)
    Branched from: Center
    Sketch: Looking at proof techniques.
  - Examples
    Branched from: Center
    Sketch: Trying numerical examples.

End of map. The user's new message is the last text block of this same turn, after this map. Answer that text. Do not answer this map."""


def _thread(overrides):
    item = {
        "id": "center",
        "parent_thread_id": None,
        "title": "Center",
        "sketch": "Working through the main argument.",
        "fork_message_id": None,
        "fork_snippet": None,
        "fork_position": None,
        "created_at": "2026-01-01T00:00:00+00:00",
    }
    item.update(overrides)
    return item


def test_worked_example_is_byte_for_byte():
    threads = [
        _thread({}),
        _thread(
            {
                "id": "proofs",
                "parent_thread_id": "center",
                "title": "Proofs",
                "sketch": "Looking at proof techniques.",
                "fork_message_id": "proof-fork",
                "fork_snippet": "The proof starts here.",
                "fork_position": 0,
                "created_at": "2026-01-01T00:01:00+00:00",
            }
        ),
        _thread(
            {
                "id": "examples",
                "parent_thread_id": "center",
                "title": "Examples",
                "sketch": "Trying numerical examples.",
                "fork_message_id": "example-fork",
                "fork_snippet": "An example starts here.",
                "fork_position": 1,
                "created_at": "2026-01-01T00:00:30+00:00",
            }
        ),
    ]
    rendered = render_learning_map(
        threads,
        "proofs",
        "Understand the theorem",
        {"proof-fork"},
    )
    assert rendered == WORKED_EXAMPLE
    assert rendered.startswith(MAP_HEADER)
    assert "At:" not in rendered
    assert "The proof starts here." not in rendered


def test_null_sketch_is_a_placeholder():
    rendered = render_learning_map(
        [_thread({"sketch": None})],
        "center",
        "Understand the theorem",
        set(),
    )
    assert "Sketch: No turns yet." in rendered


def test_blank_goal_omits_the_pinned_goal_line():
    rendered = render_learning_map([_thread({})], "center", "  ", set())
    assert "Pinned goal:" not in rendered
    assert rendered.startswith(MAP_HEADER + "\n\n- Center")
    assert rendered.endswith(MAP_FOOTER)


def test_long_goal_is_one_line_and_ends_with_an_ellipsis():
    goal = "word " * 200
    rendered = render_learning_map([_thread({})], "center", goal, set())
    pinned = next(line for line in rendered.split("\n") if line.startswith("Pinned goal:"))
    assert pinned.endswith("…")
    assert pinned.count("\n") == 0


def test_long_map_is_truncated():
    rendered = render_learning_map(
        [_thread({"sketch": "x" * 9000})],
        "center",
        None,
        set(),
    )
    assert MAP_HEADER in rendered
    assert "- Center (you are here)" in rendered
    assert "(map truncated)" in rendered
    assert rendered.endswith(MAP_FOOTER)
    assert len(rendered) <= MAP_MAX_CHARS


def test_crowded_tree_drops_later_siblings_first(monkeypatch):
    monkeypatch.setattr("app.learning_map.MAP_MAX_CHARS", 2500)
    threads = [
        _thread({}),
        _thread(
            {
                "id": "proofs",
                "parent_thread_id": "center",
                "title": "Proofs",
                "sketch": "Looking at proof techniques.",
                "fork_position": 0,
                "created_at": "2026-01-01T00:01:00+00:00",
            }
        ),
    ]
    for index in range(6):
        threads.append(
            _thread(
                {
                    "id": f"extra-{index}",
                    "parent_thread_id": "center",
                    "title": f"Extra {index}",
                    "sketch": "e" * 400,
                    "fork_position": index + 1,
                    "created_at": f"2026-01-01T00:0{index + 2}:00+00:00",
                }
            )
        )
    rendered = render_learning_map(threads, "proofs", None, set())
    assert "Proofs (you are here)" in rendered
    assert "Extra 5" not in rendered
    assert "(map truncated)" in rendered
    assert rendered.endswith(MAP_FOOTER)
    assert len(rendered) <= 2500


def test_fitting_map_keeps_the_footer_and_is_not_truncated():
    rendered = render_learning_map([_thread({})], "center", None, set())
    assert "(map truncated)" not in rendered
    assert rendered.endswith(MAP_FOOTER)


def test_unknown_parent_is_omitted():
    rendered = render_learning_map(
        [
            _thread({}),
            _thread(
                {
                    "id": "orphan",
                    "parent_thread_id": "missing",
                    "title": "Orphan",
                    "sketch": "Should not appear.",
                    "created_at": "2026-01-01T00:03:00+00:00",
                }
            ),
        ],
        "center",
        None,
        set(),
    )
    assert "Orphan" not in rendered
    assert "Should not appear." not in rendered
    assert "- Center" in rendered


def test_init_db_adds_sketch_to_an_existing_threads_table(tmp_path, monkeypatch):
    monkeypatch.setenv("TANGENTS_DB", str(tmp_path / "legacy.db"))
    conn = connect()
    try:
        conn.execute(
            """
            CREATE TABLE conversations (
                id TEXT PRIMARY KEY,
                goal TEXT,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE threads (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL REFERENCES conversations(id),
                parent_thread_id TEXT REFERENCES threads(id),
                fork_message_id TEXT,
                title TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            "INSERT INTO conversations (id, goal, created_at) VALUES (?, NULL, ?)",
            ("c1", "2026-01-01T00:00:00+00:00"),
        )
        conn.execute(
            """
            INSERT INTO threads
                (id, conversation_id, parent_thread_id, fork_message_id, title, created_at)
            VALUES (?, ?, NULL, NULL, 'Center', ?)
            """,
            ("t1", "c1", "2026-01-01T00:00:00+00:00"),
        )
        conn.commit()
        names = [row["name"] for row in conn.execute("PRAGMA table_info(threads)")]
        assert "sketch" not in names
    finally:
        conn.close()

    init_db()
    conn = connect()
    try:
        names = [row["name"] for row in conn.execute("PRAGMA table_info(threads)")]
        assert "sketch" in names
        thread = get_thread(conn, "t1")
        assert thread is not None
        assert thread["sketch"] is None
        set_thread_sketch(conn, "t1", "Working through the main argument.")
        assert get_thread(conn, "t1")["sketch"] == "Working through the main argument."
    finally:
        conn.close()
