import re
import sqlite3
import zlib

import numpy as np
import pytest

from app.db import connect, create_conversation, delete_conversation, init_db
from app.rag import (
    UnsupportedDocument,
    chunk_markdown,
    fts_query,
    ingest,
    query_text,
    reciprocal_rank_fusion,
    search,
    to_markdown,
    to_search_result_blocks,
)


class FakeEmbedder:
    """Hashed bag of words. Deterministic across runs (crc32, not hash())."""

    def _vector(self, text):
        vector = np.zeros(128, dtype=np.float32)
        for word in re.findall(r"\w+", text.lower()):
            vector[zlib.crc32(word.encode()) % 128] += 1
        norm = np.linalg.norm(vector)
        return vector / norm if norm else vector

    def passages(self, texts):
        return np.vstack([self._vector(text) for text in texts])

    def query(self, text):
        return self._vector(text)


@pytest.fixture()
def conn(tmp_path, monkeypatch):
    monkeypatch.setenv("TANGENTS_DB", str(tmp_path / "tangents.db"))
    init_db()
    connection = connect()
    yield connection
    connection.close()


DOC = b"# Walls\n\n## Names\nWall Maria, Wall Rose, and Wall Sina.\n\n## Enemy\nMarley planned the breach.\n"


def test_chunk_markdown_splits_on_headings():
    chunks = chunk_markdown("# Title\n\n## A\nalpha text\n\n## B\nbeta text")
    assert [chunk.heading for chunk in chunks] == ["Title > A", "Title > B"]
    assert [chunk.text for chunk in chunks] == ["alpha text", "beta text"]


def test_chunk_markdown_windows_long_sections():
    body = " ".join(f"w{i}" for i in range(100))
    chunks = chunk_markdown(f"## S\n{body}", max_words=40, overlap=10)
    assert len(chunks) == 3
    assert chunks[1].text.startswith("w30")
    assert chunks[-1].text.endswith("w99")
    assert all(len(chunk.text.split()) <= 40 for chunk in chunks)


def test_chunk_markdown_without_headings():
    chunks = chunk_markdown("just some text")
    assert len(chunks) == 1
    assert chunks[0].heading == ""
    assert chunks[0].text == "just some text"


def test_chunk_markdown_rejects_bad_window():
    with pytest.raises(ValueError):
        chunk_markdown("text", max_words=10, overlap=10)
    with pytest.raises(ValueError):
        chunk_markdown("text", max_words=0)


def test_reciprocal_rank_fusion_order():
    fused = reciprocal_rank_fusion([["a", "b", "c"], ["b", "c", "d"]])
    assert [item for item, _score in fused] == ["b", "c", "a", "d"]


def test_query_text_adds_prefix_for_known_models():
    prefixed = query_text("BAAI/bge-small-en-v1.5", "where is the basement")
    assert prefixed == (
        "Represent this sentence for searching relevant passages: where is the basement"
    )
    assert query_text("snowflake/snowflake-arctic-embed-l", "walls").startswith(
        "Represent this sentence for searching relevant passages: "
    )


def test_query_text_leaves_unknown_models_unchanged():
    assert query_text("some-other-model", "where is the basement") == "where is the basement"


def test_fts_query_neutralizes_operators():
    assert fts_query('What is "Wall" OR NEAR(x)?') == '"wall" OR "near"'
    assert fts_query("the a of") == ""


def test_to_markdown_text_types():
    assert to_markdown("a.txt", "\ufeffhello".encode()) == "hello"
    assert to_markdown("a.md", b"# T") == "# T"


def test_to_markdown_html_uses_markitdown():
    text = to_markdown("a.html", b"<h1>Title</h1><p>hello world</p>")
    assert "# Title" in text
    assert "hello world" in text


def test_to_markdown_rejects_unknown():
    for name in ("a.doc", "a.png", "noext"):
        with pytest.raises(UnsupportedDocument):
            to_markdown(name, b"hello")


def test_ingest_empty_file_raises(conn):
    cid = create_conversation(conn)["id"]
    with pytest.raises(UnsupportedDocument):
        ingest(conn, cid, "e.txt", b"   ", embedder=FakeEmbedder())


def test_ingest_unknown_conversation_fails(conn):
    with pytest.raises(sqlite3.IntegrityError):
        ingest(conn, "missing", "a.txt", b"hello world", embedder=FakeEmbedder())


def test_search_finds_keyword_section(conn):
    cid = create_conversation(conn)["id"]
    ingest(conn, cid, "walls.md", DOC, embedder=FakeEmbedder())
    for mode in ("hybrid", "vector", "keyword"):
        hits = search(conn, cid, "Sina", k=1, mode=mode, embedder=FakeEmbedder())
        assert hits[0]["heading"] == "Walls > Names"


def test_search_stays_in_conversation(conn):
    first = create_conversation(conn)["id"]
    second = create_conversation(conn)["id"]
    doc_a = ingest(conn, first, "a.md", b"# A\n\nWall Maria stands.", embedder=FakeEmbedder())
    ingest(conn, second, "b.md", b"# B\n\nWall Maria falls.", embedder=FakeEmbedder())
    for mode in ("hybrid", "vector", "keyword"):
        hits = search(conn, first, "Wall Maria", k=5, mode=mode, embedder=FakeEmbedder())
        assert hits
        assert {hit["document_id"] for hit in hits} == {doc_a["id"]}


def test_search_empty_conversation(conn):
    cid = create_conversation(conn)["id"]
    for mode in ("hybrid", "vector", "keyword"):
        assert search(conn, cid, "Sina", k=5, mode=mode, embedder=FakeEmbedder()) == []


def test_search_rejects_bad_mode_and_k(conn):
    cid = create_conversation(conn)["id"]
    with pytest.raises(ValueError):
        search(conn, cid, "Sina", k=1, mode="x", embedder=FakeEmbedder())
    with pytest.raises(ValueError):
        search(conn, cid, "Sina", k=0, embedder=FakeEmbedder())


def test_search_result_blocks_shape(conn):
    cid = create_conversation(conn)["id"]
    ingest(conn, cid, "walls.md", DOC, embedder=FakeEmbedder())
    hits = search(conn, cid, "Sina", k=1, mode="keyword", embedder=FakeEmbedder())
    blocks = to_search_result_blocks(hits)
    assert blocks[0]["type"] == "search_result"
    assert blocks[0]["citations"] == {"enabled": True}
    assert blocks[0]["title"] == "Walls - Names"
    assert blocks[0]["content"][0]["text"] == hits[0]["text"]


def test_delete_conversation_removes_documents(conn):
    kept = create_conversation(conn)["id"]
    gone = create_conversation(conn)["id"]
    ingest(conn, kept, "kept.md", DOC, embedder=FakeEmbedder())
    ingest(conn, gone, "gone.md", DOC, embedder=FakeEmbedder())
    assert delete_conversation(conn, gone) is True

    def counts(conversation_id):
        return [
            conn.execute(
                f"SELECT COUNT(*) FROM {table} WHERE conversation_id = ?",
                (conversation_id,),
            ).fetchone()[0]
            for table in ("documents", "chunks", "chunks_fts")
        ]

    assert counts(gone) == [0, 0, 0]
    assert all(count > 0 for count in counts(kept))
