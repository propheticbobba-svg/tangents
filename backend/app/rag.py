"""Document retrieval for one conversation.

A file becomes Markdown, Markdown becomes chunks, and each chunk is stored with
a normalized embedding and an FTS5 row. search() merges the vector ranking and
the keyword ranking with reciprocal rank fusion.
"""

from __future__ import annotations

import re
import sqlite3
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import numpy as np

from app.config import BACKEND_DIR, get_settings
from app.db import new_id, now

TEXT_EXTENSIONS = frozenset({".txt", ".md", ".markdown"})
MARKITDOWN_EXTENSIONS = frozenset({".docx", ".pptx", ".xlsx", ".html", ".htm", ".epub"})
SEARCH_MODES = ("hybrid", "vector", "keyword")
RRF_K = 60
CANDIDATES = 20
DEFAULT_MAX_WORDS = 180
DEFAULT_OVERLAP = 30
EMBED_CACHE_DIR = BACKEND_DIR / ".cache" / "fastembed"
STOPWORDS = frozenset(
    {
        "a", "an", "and", "are", "as", "at", "be", "by", "did", "do", "does",
        "for", "from", "how", "in", "is", "it", "of", "on", "or", "the", "to",
        "was", "were", "what", "when", "where", "which", "who", "why", "with",
    }
)
DOCS_INSTRUCTION = (
    "Search results from the user's documents are attached to this message. "
    "Answer from them and cite the results you use. "
    "If they do not contain the answer, say the documents do not say, "
    "even if you know an answer from elsewhere. "
    "Do not add facts that are not in the results."
)

_HEADING = re.compile(r"^(#{1,6})\s+(.*\S)\s*$")
_WORD = re.compile(r"\w+")
_TABLE_LINE = re.compile(r"^\s*\|.*\|\s*$")
_TABLE_SEPARATOR = re.compile(r"^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$")
_TABLE_CAPTION = re.compile(r"^\s*<!--\s*table-caption:\s*(.*?)\s*-->\s*$")
_RETRIEVAL_PREFIX = "Represent this sentence for searching relevant passages: "
QUERY_PREFIXES = {
    "BAAI/bge-small-en-v1.5": _RETRIEVAL_PREFIX,
    "BAAI/bge-base-en-v1.5": _RETRIEVAL_PREFIX,
    "snowflake/snowflake-arctic-embed-m": _RETRIEVAL_PREFIX,
    "snowflake/snowflake-arctic-embed-l": _RETRIEVAL_PREFIX,
}


def query_text(model_name: str, text: str) -> str:
    return QUERY_PREFIXES.get(model_name, "") + text


class UnsupportedDocument(ValueError):
    pass


@dataclass(frozen=True)
class Chunk:
    heading: str
    text: str

    @property
    def indexed_text(self) -> str:
        return f"{self.heading}\n{self.text}" if self.heading else self.text


class Embedder(Protocol):
    def passages(self, texts: list[str]) -> np.ndarray: ...

    def query(self, text: str) -> np.ndarray: ...


def _normalize(vectors: np.ndarray) -> np.ndarray:
    vectors = np.asarray(vectors, dtype=np.float32)
    norms = np.linalg.norm(vectors, axis=-1, keepdims=True)
    norms[norms == 0] = 1.0
    return vectors / norms


_load_lock = threading.Lock()


class FastEmbedder:
    """Local ONNX embeddings. The model downloads on first use into backend/.cache."""

    def __init__(self, model_name: str) -> None:
        self.model_name = model_name
        self._model: Any = None

    def _load(self) -> Any:
        if self._model is not None:
            return self._model
        with _load_lock:
            if self._model is None:
                from fastembed import TextEmbedding

                EMBED_CACHE_DIR.mkdir(parents=True, exist_ok=True)
                self._model = TextEmbedding(model_name=self.model_name, cache_dir=str(EMBED_CACHE_DIR))
        return self._model

    def passages(self, texts: list[str]) -> np.ndarray:
        return _normalize(np.vstack(list(self._load().passage_embed(texts))))

    def query(self, text: str) -> np.ndarray:
        prefixed = query_text(self.model_name, text)
        return _normalize(np.vstack(list(self._load().query_embed([prefixed]))))[0]


_embedder: FastEmbedder | None = None


def get_embedder() -> FastEmbedder:
    global _embedder
    if _embedder is None:
        _embedder = FastEmbedder(get_settings().embed_model)
    return _embedder


def to_markdown(filename: str, data: bytes) -> str:
    suffix = Path(filename).suffix.lower()
    if suffix in TEXT_EXTENSIONS:
        return data.decode("utf-8-sig", errors="replace")
    if suffix == ".pdf":
        from app.pdf import pdf_to_markdown

        try:
            return pdf_to_markdown(data)
        except UnsupportedDocument as exc:
            raise UnsupportedDocument(f"{filename} {exc}") from exc
    if suffix in MARKITDOWN_EXTENSIONS:
        from markitdown import MarkItDown

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / f"upload{suffix}"
            path.write_bytes(data)
            text = MarkItDown().convert(str(path)).text_content or ""
        if not text.strip():
            raise UnsupportedDocument(f"{filename} has no extractable text (scanned PDFs need OCR)")
        return text
    raise UnsupportedDocument(f"Unsupported file type: {suffix or filename}")


def chunk_markdown(
    text: str, max_words: int = DEFAULT_MAX_WORDS, overlap: int = DEFAULT_OVERLAP
) -> list[Chunk]:
    """Split on headings, then window long sections. Headings are joined with ' > '.

    Pipe tables keep their line breaks, split by whole rows, and repeat the header
    in every chunk. A table never shares a chunk with prose.
    """
    if max_words < 1 or overlap < 0 or overlap >= max_words:
        raise ValueError("need max_words >= 1 and 0 <= overlap < max_words")

    chunks: list[Chunk] = []
    stack: list[tuple[int, str]] = []
    prose: list[str] = []
    table: list[str] = []
    caption = ""

    def path() -> str:
        return " > ".join(title for _, title in stack)

    def flush_prose() -> None:
        body = " ".join(" ".join(prose).split())
        prose.clear()
        if not body:
            return
        words = body.split()
        step = max_words - overlap
        for start in range(0, len(words), step):
            chunks.append(Chunk(path(), " ".join(words[start : start + max_words])))
            if start + max_words >= len(words):
                break

    def flush_table() -> None:
        nonlocal caption
        lines = [line.strip() for line in table]
        table.clear()
        if not lines:
            return
        heading = " > ".join(part for part in (path(), caption) if part)
        caption = ""
        head = lines[:2] if len(lines) >= 2 and _TABLE_SEPARATOR.match(lines[1]) else []
        head_words = sum(len(_WORD.findall(line)) for line in head)
        group: list[str] = []
        used = head_words
        for row in lines[len(head) :]:
            count = len(_WORD.findall(row))
            if group and used + count > max_words:
                chunks.append(Chunk(heading, "\n".join(head + group)))
                group, used = [], head_words
            group.append(row)
            used += count
        if group or head:
            chunks.append(Chunk(heading, "\n".join(head + group)))

    def caption_as_prose() -> None:
        nonlocal caption
        if caption:
            prose.append(caption)
            caption = ""

    for line in text.splitlines():
        caption_match = _TABLE_CAPTION.match(line)
        if caption_match:
            flush_table()
            caption_as_prose()
            flush_prose()
            caption = caption_match.group(1)
            continue
        if _TABLE_LINE.match(line):
            flush_prose()
            table.append(line)
            continue
        if not line.strip():
            if table:
                flush_table()
            else:
                prose.append(line)
            continue
        flush_table()
        caption_as_prose()
        match = _HEADING.match(line)
        if match is None:
            prose.append(line)
            continue
        flush_prose()
        level = len(match.group(1))
        while stack and stack[-1][0] >= level:
            stack.pop()
        stack.append((level, match.group(2).strip("# ").strip()))
    flush_table()
    caption_as_prose()
    flush_prose()
    return chunks


def _title(markdown: str, filename: str) -> str:
    for line in markdown.splitlines():
        match = _HEADING.match(line)
        if match and len(match.group(1)) == 1:
            return match.group(2).strip("# ").strip()
    return Path(filename).stem


def ingest(
    conn: sqlite3.Connection,
    conversation_id: str,
    filename: str,
    data: bytes,
    *,
    embedder: Embedder | None = None,
    max_words: int = DEFAULT_MAX_WORDS,
    overlap: int = DEFAULT_OVERLAP,
) -> dict[str, Any]:
    markdown = to_markdown(filename, data)
    chunks = chunk_markdown(markdown, max_words, overlap)
    return store_document(
        conn,
        conversation_id,
        filename,
        _title(markdown, filename),
        chunks,
        embedder=embedder,
    )


def store_document(
    conn: sqlite3.Connection,
    conversation_id: str,
    filename: str,
    title: str,
    chunks: list[Chunk],
    *,
    embedder: Embedder | None = None,
) -> dict[str, Any]:
    if not chunks:
        raise UnsupportedDocument(f"{filename} has no text")
    vectors = (embedder or get_embedder()).passages([chunk.indexed_text for chunk in chunks])

    document = {
        "id": new_id(),
        "conversation_id": conversation_id,
        "filename": filename,
        "title": title,
        "created_at": now(),
    }
    conn.execute(
        "INSERT INTO documents (id, conversation_id, filename, title, created_at) VALUES (?, ?, ?, ?, ?)",
        (document["id"], conversation_id, filename, document["title"], document["created_at"]),
    )
    for ord_, (chunk, vector) in enumerate(zip(chunks, vectors)):
        chunk_id = new_id()
        conn.execute(
            """
            INSERT INTO chunks (id, document_id, conversation_id, ord, heading, text, embedding)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                chunk_id,
                document["id"],
                conversation_id,
                ord_,
                chunk.heading,
                chunk.text,
                np.asarray(vector, dtype=np.float32).tobytes(),
            ),
        )
        conn.execute(
            "INSERT INTO chunks_fts (text, chunk_id, conversation_id) VALUES (?, ?, ?)",
            (chunk.indexed_text, chunk_id, conversation_id),
        )
    conn.commit()
    return {**document, "chunk_count": len(chunks)}


def list_documents(conn: sqlite3.Connection, conversation_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT d.id, d.filename, d.title, d.created_at, COUNT(c.id) AS chunk_count
        FROM documents d
        LEFT JOIN chunks c ON c.document_id = d.id
        WHERE d.conversation_id = ?
        GROUP BY d.id
        ORDER BY d.created_at DESC
        """,
        (conversation_id,),
    ).fetchall()
    return [
        {
            "id": row["id"],
            "filename": row["filename"],
            "title": row["title"],
            "created_at": row["created_at"],
            "chunk_count": row["chunk_count"],
        }
        for row in rows
    ]


def delete_document(conn: sqlite3.Connection, document_id: str) -> bool:
    row = conn.execute("SELECT id FROM documents WHERE id = ?", (document_id,)).fetchone()
    if row is None:
        return False
    conn.execute(
        "DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)",
        (document_id,),
    )
    conn.execute("DELETE FROM chunks WHERE document_id = ?", (document_id,))
    conn.execute("DELETE FROM documents WHERE id = ?", (document_id,))
    conn.commit()
    return True


def fts_query(text: str) -> str:
    """Quoted words joined by OR, so FTS5 operators in user text are inert."""
    words = [word for word in _WORD.findall(text.lower()) if len(word) > 1 and word not in STOPWORDS]
    return " OR ".join(f'"{word}"' for word in dict.fromkeys(words))


def reciprocal_rank_fusion(rankings: list[list[str]], k: int = RRF_K) -> list[tuple[str, float]]:
    scores: dict[str, float] = {}
    for ranking in rankings:
        for rank, item in enumerate(ranking, start=1):
            scores[item] = scores.get(item, 0.0) + 1.0 / (k + rank)
    return sorted(scores.items(), key=lambda pair: -pair[1])


def _vector_ranking(
    conn: sqlite3.Connection, conversation_id: str, query: str, embedder: Embedder
) -> list[str]:
    rows = conn.execute(
        "SELECT id, embedding FROM chunks WHERE conversation_id = ?", (conversation_id,)
    ).fetchall()
    if not rows:
        return []
    matrix = np.vstack([np.frombuffer(row["embedding"], dtype=np.float32) for row in rows])
    query_vector = embedder.query(query)
    if matrix.shape[1] != query_vector.shape[0]:
        raise RuntimeError("Stored embeddings came from a different EMBED_MODEL; re-ingest the documents")
    scores = matrix @ query_vector
    order = np.argsort(-scores, kind="stable")[:CANDIDATES]
    return [rows[int(index)]["id"] for index in order]


def _keyword_ranking(conn: sqlite3.Connection, conversation_id: str, query: str) -> list[str]:
    match = fts_query(query)
    if not match:
        return []
    rows = conn.execute(
        """
        SELECT chunk_id FROM chunks_fts
        WHERE chunks_fts MATCH ? AND conversation_id = ?
        ORDER BY bm25(chunks_fts)
        LIMIT ?
        """,
        (match, conversation_id, CANDIDATES),
    ).fetchall()
    return [row["chunk_id"] for row in rows]


def search(
    conn: sqlite3.Connection,
    conversation_id: str,
    query: str,
    k: int | None = None,
    *,
    mode: str = "hybrid",
    embedder: Embedder | None = None,
) -> list[dict[str, Any]]:
    if mode not in SEARCH_MODES:
        raise ValueError(f"mode must be one of {SEARCH_MODES}")
    k = get_settings().rag_top_k if k is None else k
    if k < 1:
        raise ValueError("k must be at least 1")

    rankings: list[list[str]] = []
    if mode in ("hybrid", "vector"):
        rankings.append(_vector_ranking(conn, conversation_id, query, embedder or get_embedder()))
    if mode in ("hybrid", "keyword"):
        rankings.append(_keyword_ranking(conn, conversation_id, query))
    fused = reciprocal_rank_fusion(rankings)[:k]
    if not fused:
        return []

    ids = [chunk_id for chunk_id, _ in fused]
    placeholders = ", ".join("?" for _ in ids)
    rows = conn.execute(
        f"""
        SELECT c.id, c.document_id, c.ord, c.heading, c.text, d.filename, d.title
        FROM chunks c JOIN documents d ON d.id = c.document_id
        WHERE c.id IN ({placeholders})
        """,
        ids,
    ).fetchall()
    by_id = {row["id"]: row for row in rows}
    return [
        {
            "chunk_id": chunk_id,
            "document_id": by_id[chunk_id]["document_id"],
            "filename": by_id[chunk_id]["filename"],
            "document_title": by_id[chunk_id]["title"],
            "heading": by_id[chunk_id]["heading"],
            "ord": by_id[chunk_id]["ord"],
            "text": by_id[chunk_id]["text"],
            "score": score,
        }
        for chunk_id, score in fused
        if chunk_id in by_id
    ]


def to_search_result_blocks(hits: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Anthropic search_result content blocks, to sit before the user's text block."""
    blocks: list[dict[str, Any]] = []
    for hit in hits:
        section = hit["heading"].split(" > ")[-1] if hit["heading"] else ""
        title = hit["document_title"]
        if section and section != title:
            title = f"{title} - {section}"
        blocks.append(
            {
                "type": "search_result",
                "source": f"doc:{hit['document_id']}#{hit['ord']}",
                "title": title,
                "content": [{"type": "text", "text": hit["text"]}],
                "citations": {"enabled": True},
            }
        )
    return blocks
