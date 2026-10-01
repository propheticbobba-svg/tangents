"""Compare PDF extraction pipelines on one document.

Not a pytest test: it downloads layout and OCR models and, with --answer, calls Claude.

    uv run python scripts/bench_pdf.py --answer
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from markitdown import MarkItDown  # noqa: E402

from app.config import get_settings  # noqa: E402
from app.db import connect, create_conversation, init_db  # noqa: E402
from app.pdf import get_engines, group_rows, pdf_to_markdown, render_page  # noqa: E402
from app.rag import (  # noqa: E402
    DOCS_INSTRUCTION,
    DEFAULT_MAX_WORDS,
    DEFAULT_OVERLAP,
    Chunk,
    _title,
    chunk_markdown,
    search,
    store_document,
    to_search_result_blocks,
)

import pypdfium2  # noqa: E402

_HEADING = re.compile(r"^(#{1,6})\s+(.*\S)\s*$")
_TABLE_LINE = re.compile(r"^\s*\|.*\|\s*$")
_TABLE_SEPARATOR = re.compile(r"^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$")
_TABLE_CAPTION = re.compile(r"^\s*<!--\s*table-caption:\s*(.*?)\s*-->\s*$")
_ROW_ID = re.compile(r"#\d{3}")
HEADER_WORDS = ["id", "name", "category", "status", "value"]
CELL_TOTAL = 150
ORDER_ANCHORS = (
    "large introductory paragraph",
    "second paragraph provides",
    "paragraph appears below the table",
    "final paragraph concludes",
)
NEGATIVE_MARKERS = (
    "do not",
    "does not",
    "don't",
    "doesn't",
    "no information",
    "not mention",
    "not include",
    "not specified",
    "not stated",
)
INPUT_USD_PER_MILLION = 1.0
OUTPUT_USD_PER_MILLION = 5.0


def legacy_chunk_markdown(
    text: str, max_words: int = DEFAULT_MAX_WORDS, overlap: int = DEFAULT_OVERLAP
) -> list[Chunk]:
    """The chunker from before table-aware splitting. Frozen for the baseline."""
    if max_words < 1 or overlap < 0 or overlap >= max_words:
        raise ValueError("need max_words >= 1 and 0 <= overlap < max_words")

    sections: list[tuple[str, str]] = []
    stack: list[tuple[int, str]] = []
    lines: list[str] = []

    def flush() -> None:
        body = " ".join(" ".join(lines).split())
        if body:
            sections.append((" > ".join(title for _, title in stack), body))
        lines.clear()

    for line in text.splitlines():
        match = _HEADING.match(line)
        if match is None:
            lines.append(line)
            continue
        flush()
        level = len(match.group(1))
        while stack and stack[-1][0] >= level:
            stack.pop()
        stack.append((level, match.group(2).strip("# ").strip()))
    flush()

    chunks: list[Chunk] = []
    step = max_words - overlap
    for heading, body in sections:
        words = body.split()
        for start in range(0, len(words), step):
            chunks.append(Chunk(heading, " ".join(words[start : start + max_words])))
            if start + max_words >= len(words):
                break
    return chunks


def words(text: str) -> list[str]:
    kept = [
        line
        for line in text.splitlines()
        if not _TABLE_SEPARATOR.match(line) and not _TABLE_CAPTION.match(line)
    ]
    return re.findall(r"\w+", "\n".join(kept).lower())


def wer(ref: list[str], hyp: list[str]) -> float:
    if not ref:
        return 0.0 if not hyp else 1.0
    previous = list(range(len(hyp) + 1))
    for index, left in enumerate(ref, start=1):
        current = [index]
        for column, right in enumerate(hyp, start=1):
            current.append(
                min(previous[column] + 1, current[-1] + 1, previous[column - 1] + (left != right))
            )
        previous = current
    return previous[-1] / len(ref)


def norm_answer(text: str) -> str:
    text = text.lower().replace("$", "").replace(",", "")
    text = re.sub(r"\.00\b", "", text)
    return " ".join(text.split())


def has(text: str, phrase: str) -> bool:
    return re.search(rf"(?<!\w){re.escape(phrase)}(?!\w)", text) is not None


def norm_text(text: str) -> str:
    return " ".join(text.lower().split())


def split_cells(line: str) -> list[str]:
    return [cell.strip() for cell in re.split(r"(?<!\\)\|", line.strip())[1:-1]]


def pipe_tables(text: str) -> list[list[list[str]]]:
    tables: list[list[list[str]]] = []
    current: list[list[str]] = []
    for line in text.splitlines():
        if not _TABLE_LINE.match(line):
            if current:
                tables.append(current)
                current = []
            continue
        if _TABLE_SEPARATOR.match(line):
            continue
        current.append(split_cells(line))
    if current:
        tables.append(current)
    return tables


def norm_cell(value: str) -> str:
    return " ".join(value.split()).lower()


def data_rows(tables: list[list[list[str]]]) -> list[list[str]]:
    rows: list[list[str]] = []
    for table in tables:
        rows.extend(table[1:])
    return rows


def header_ok(tables: list[list[list[str]]]) -> bool:
    if not tables or not tables[0]:
        return False
    return [norm_cell(cell) for cell in tables[0][0]] == HEADER_WORDS


def cell_accuracy(output: str, expected_rows: list[list[str]]) -> float:
    found: dict[str, list[str]] = {}
    for row in data_rows(pipe_tables(output)):
        if row:
            found.setdefault(norm_cell(row[0]), row)
    correct = 0
    for expected in expected_rows:
        got = found.get(norm_cell(expected[0])) if expected else None
        if not got:
            continue
        for index, cell in enumerate(expected):
            if index < len(got) and norm_cell(got[index]) == norm_cell(cell):
                correct += 1
    return correct / CELL_TOTAL


def order_ok(text: str) -> bool:
    flat = " ".join(words(text))
    table_anchor = "id name category status value"
    if table_anchor not in flat:
        table_anchor = "001"
    anchors = [
        ORDER_ANCHORS[0],
        ORDER_ANCHORS[1],
        table_anchor,
        ORDER_ANCHORS[2],
        ORDER_ANCHORS[3],
    ]
    positions = []
    for anchor in anchors:
        position = flat.find(anchor)
        if position < 0:
            return False
        positions.append(position)
    return positions == sorted(positions)


def tokens(text: str) -> list[str]:
    return re.findall(r"\w+", text.lower())


def has_sequence(haystack: list[str], needle: list[str]) -> bool:
    width = len(needle)
    if width == 0:
        return True
    return any(haystack[index : index + width] == needle for index in range(len(haystack) - width + 1))


def prose_runs(expected: str) -> set[tuple[str, ...]]:
    lines = [line for line in expected.splitlines() if line.strip() and not line.strip().startswith("|")]
    prose = tokens(" ".join(lines))
    return {tuple(prose[index : index + 6]) for index in range(max(0, len(prose) - 5))}


def chunk_metrics(chunks: list[Chunk], expected: str, expected_rows: list[list[str]]) -> dict[str, object]:
    runs = prose_runs(expected)
    mixed = 0
    with_id = 0
    with_header = 0
    seen_in: dict[str, set[int]] = {}
    chunk_tokens = [tokens(chunk.text) for chunk in chunks]
    for index, (chunk, chunk_words) in enumerate(zip(chunks, chunk_tokens)):
        ids = set(_ROW_ID.findall(chunk.text))
        for row_id in ids:
            seen_in.setdefault(row_id, set()).add(index)
        if not ids:
            continue
        with_id += 1
        if has_sequence(chunk_words, HEADER_WORDS):
            with_header += 1
        if any(tuple(chunk_words[index : index + 6]) in runs for index in range(len(chunk_words) - 5)):
            mixed += 1
    intact = 0
    for row in expected_rows:
        needle = tokens(" ".join(row))
        if any(has_sequence(chunk_words, needle) for chunk_words in chunk_tokens):
            intact += 1
    duplicates = sorted(row_id for row_id, places in seen_in.items() if len(places) > 1)
    return {
        "chunk_count": len(chunks),
        "mixed_chunks": mixed,
        "table_chunks_with_header": f"{with_header}/{with_id}",
        "rows_intact": f"{intact}/{len(expected_rows)}",
        "duplicate_rows": duplicates,
    }


def contains_all(text: str, evidence: list[str]) -> bool:
    haystack = norm_text(text)
    return all(norm_text(item) in haystack for item in evidence)


def retrieval_rank(hits: list[dict], question: dict) -> int | None:
    evidence = question["evidence"]
    if question["kind"] == "table_multi":
        blob = ""
        for index, hit in enumerate(hits, start=1):
            blob += "\n" + hit["text"]
            if contains_all(blob, evidence):
                return index
        return None
    for index, hit in enumerate(hits, start=1):
        if contains_all(hit["text"], evidence):
            return index
    return None


def grade(question: dict, answer: str) -> str:
    if question["kind"] == "negative":
        lowered = answer.lower()
        if any(marker in lowered for marker in NEGATIVE_MARKERS):
            return "pass?"
        return "fail?"
    normalized = norm_answer(answer)
    passed = all(any(has(normalized, choice) for choice in group) for group in question["accept"])
    return "pass" if passed else "fail"


def baseline_markdown(path: Path) -> str:
    return MarkItDown().convert(str(path)).text_content or ""


def ocr_only_markdown(data: bytes) -> str:
    document = pypdfium2.PdfDocument(data)
    engines = get_engines()
    lines: list[str] = []
    try:
        for index in range(len(document)):
            page = document[index]
            try:
                for row in group_rows(engines.ocr(render_page(page))):
                    text = " ".join(" ".join(unit.text for unit in row).split())
                    if text:
                        lines.append(text)
            finally:
                page.close()
    finally:
        document.close()
    return "\n".join(lines) + ("\n" if lines else "")


def extract(name: str, path: Path, data: bytes) -> tuple[str, list[Chunk], float]:
    started = time.perf_counter()
    if name == "baseline":
        markdown = baseline_markdown(path)
        chunks = legacy_chunk_markdown(markdown)
    elif name == "ocr_only":
        markdown = ocr_only_markdown(data)
        chunks = chunk_markdown(markdown)
    elif name == "hybrid":
        markdown = pdf_to_markdown(data)
        chunks = chunk_markdown(markdown)
    elif name == "hybrid_forced_ocr":
        markdown = pdf_to_markdown(data, force_ocr=True)
        chunks = chunk_markdown(markdown)
    else:
        raise SystemExit(f"unknown pipeline {name}")
    return markdown, chunks, time.perf_counter() - started


def extraction_metrics(markdown: str, expected: str, expected_rows: list[list[str]], seconds: float, pages: int) -> dict:
    tables = pipe_tables(markdown)
    return {
        "wer": wer(words(expected), words(markdown)),
        "tables_found": len(tables),
        "header_ok": header_ok(tables),
        "rows_found": len(data_rows(tables)),
        "cell_accuracy": cell_accuracy(markdown, expected_rows),
        "order_ok": order_ok(markdown),
        "seconds": seconds,
        "seconds_per_page": seconds / pages if pages else 0.0,
    }


def open_search(markdown: str, chunks: list[Chunk], filename: str):
    temporary = tempfile.TemporaryDirectory()
    os.environ["TANGENTS_DB"] = str(Path(temporary.name) / "bench.db")
    init_db()
    conn = connect()
    conversation_id = create_conversation(conn)["id"]
    store_document(conn, conversation_id, filename, _title(markdown, filename), chunks)
    return temporary, conn, conversation_id


def ask(question: str, hits: list[dict], model: str) -> tuple[str, int, int]:
    import anthropic

    settings = get_settings()
    if not settings.api_key:
        raise SystemExit("ANTHROPIC_API_KEY is not set in backend/.env")
    response = anthropic.Anthropic(api_key=settings.api_key).messages.create(
        model=model,
        max_tokens=400,
        system=DOCS_INSTRUCTION,
        messages=[
            {
                "role": "user",
                "content": [
                    *to_search_result_blocks(hits),
                    {"type": "text", "text": question},
                ],
            }
        ],
    )
    answer = "".join(block.text for block in response.content if getattr(block, "type", "") == "text")
    return answer, response.usage.input_tokens, response.usage.output_tokens


def hybrid_pass_bar(metrics: dict, chunks: dict, questions: list[dict]) -> list[str]:
    failures = []
    if metrics["tables_found"] != 1:
        failures.append(f"tables_found {metrics['tables_found']} != 1")
    if not metrics["header_ok"]:
        failures.append("header_ok is false")
    if metrics["rows_found"] != 30:
        failures.append(f"rows_found {metrics['rows_found']} != 30")
    if metrics["cell_accuracy"] != 1:
        failures.append(f"cell_accuracy {metrics['cell_accuracy']:.3f} != 1")
    if not metrics["order_ok"]:
        failures.append("order_ok is false")
    if metrics["wer"] > 0.01:
        failures.append(f"wer {metrics['wer']:.3f} > 0.01")
    if chunks["mixed_chunks"] != 0:
        failures.append(f"mixed_chunks {chunks['mixed_chunks']} != 0")
    header_hit, header_total = str(chunks["table_chunks_with_header"]).split("/")
    if header_total == "0" or header_hit != header_total:
        failures.append(f"table chunks missing header ({chunks['table_chunks_with_header']})")
    if chunks["rows_intact"] != "30/30":
        failures.append(f"rows_intact {chunks['rows_intact']} != 30/30")
    if chunks["duplicate_rows"]:
        failures.append(f"duplicate_rows {chunks['duplicate_rows']}")
    for question in questions:
        if question["kind"] not in ("table_cell", "prose"):
            continue
        rank = question.get("rank")
        if rank is None or rank > 2:
            failures.append(f"{question['id']} rank {rank} is not hit@2")
    return failures


def forced_ocr_note(metrics: dict) -> str:
    accuracy = metrics["cell_accuracy"]
    error = metrics["wer"]
    if accuracy >= 0.95 and error <= 0.03:
        return "meets the scan-path target (cell_accuracy >= 0.95 and wer <= 0.03)"
    return (
        f"misses the scan-path target: cell_accuracy {accuracy:.3f} (want >= 0.95), "
        f"wer {error:.3f} (want <= 0.03)"
    )


def write_report(path: Path, pages: int, results: list[dict]) -> None:
    lines = ["# PDF benchmark", "", f"Pages: {pages}", ""]
    for result in results:
        metrics = result["metrics"]
        chunks = result["chunks"]
        retrieval = result["retrieval"]
        lines.append(f"## {result['name']}")
        lines.append("")
        lines.append("| metric | value |")
        lines.append("| --- | --- |")
        for key in (
            "wer",
            "tables_found",
            "header_ok",
            "rows_found",
            "cell_accuracy",
            "order_ok",
            "seconds",
            "seconds_per_page",
        ):
            value = metrics[key]
            if isinstance(value, float):
                value = f"{value:.4f}"
            lines.append(f"| {key} | {value} |")
        lines.append(f"| chunk_count | {chunks['chunk_count']} |")
        lines.append(f"| mixed_chunks | {chunks['mixed_chunks']} |")
        lines.append(f"| table_chunks_with_header | {chunks['table_chunks_with_header']} |")
        lines.append(f"| rows_intact | {chunks['rows_intact']} |")
        lines.append(f"| duplicate_rows | {', '.join(chunks['duplicate_rows']) or 'none'} |")
        lines.append(f"| hit@1 | {retrieval['hit@1']:.3f} |")
        lines.append(f"| hit@2 | {retrieval['hit@2']:.3f} |")
        lines.append(f"| MRR | {retrieval['mrr']:.3f} |")
        if result["name"] == "hybrid":
            failures = result["pass_bar"]
            lines.append("")
            lines.append("Pass bar: " + ("PASS" if not failures else "FAIL"))
            for failure in failures:
                lines.append(f"- {failure}")
        if result["name"] == "hybrid_forced_ocr":
            lines.append("")
            lines.append(forced_ocr_note(metrics))
        lines.append("")
        lines.append("| id | kind | rank | ords | expected | grade |")
        lines.append("| --- | --- | --- | --- | --- | --- |")
        for question in result["questions"]:
            grade_cell = question.get("grade", "")
            lines.append(
                f"| {question['id']} | {question['kind']} | {question['rank']} | {question['ords']} | {question['expected']} | {grade_cell} |"
            )
        if result["answered"]:
            lines.append("")
            lines.append(
                f"Tokens in {result['input_tokens']}, out {result['output_tokens']}. "
                f"Estimated cost ${result['cost']:.4f} at ${INPUT_USD_PER_MILLION}/M input and "
                f"${OUTPUT_USD_PER_MILLION}/M output."
            )
            for question in result["questions"]:
                lines.append("")
                lines.append(f"### {question['id']}")
                lines.append("")
                lines.append(question["question"])
                lines.append("")
                lines.append(f"Expected: {question['expected']}")
                lines.append("")
                lines.append(question.get("answer") or "")
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


def print_summary(results: list[dict]) -> None:
    print()
    for result in results:
        metrics = result["metrics"]
        retrieval = result["retrieval"]
        print(
            f"{result['name']}: wer={metrics['wer']:.4f} tables={metrics['tables_found']} "
            f"header={metrics['header_ok']} rows={metrics['rows_found']} "
            f"cells={metrics['cell_accuracy']:.3f} order={metrics['order_ok']} "
            f"chunks={result['chunks']['chunk_count']} mixed={result['chunks']['mixed_chunks']} "
            f"header_chunks={result['chunks']['table_chunks_with_header']} "
            f"intact={result['chunks']['rows_intact']} dups={result['chunks']['duplicate_rows'] or 'none'} "
            f"hit@1={retrieval['hit@1']:.3f} hit@2={retrieval['hit@2']:.3f} mrr={retrieval['mrr']:.3f} "
            f"sec={metrics['seconds']:.2f}"
        )
        if result["name"] == "hybrid":
            print("hybrid pass bar:", "PASS" if not result["pass_bar"] else "FAIL " + "; ".join(result["pass_bar"]))
        if result["name"] == "hybrid_forced_ocr":
            print(forced_ocr_note(metrics))


def main() -> None:
    logging.getLogger().setLevel(logging.WARNING)
    for name in ("RapidOCR", "rapidocr", "rapid_layout", "rapid_table"):
        logging.getLogger(name).setLevel(logging.WARNING)

    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", type=Path, default=ROOT / "tests" / "fixtures" / "test_document.pdf")
    parser.add_argument("--expected", type=Path, default=ROOT / "bench" / "test_document.expected.md")
    parser.add_argument("--questions", type=Path, default=ROOT / "bench" / "test_document.questions.json")
    parser.add_argument(
        "--pipelines",
        default="baseline,ocr_only,hybrid,hybrid_forced_ocr",
    )
    parser.add_argument("--answer", action="store_true")
    parser.add_argument("--model", default="claude-haiku-4-5")
    args = parser.parse_args()

    data = args.pdf.read_bytes()
    expected = args.expected.read_text(encoding="utf-8")
    questions = json.loads(args.questions.read_text(encoding="utf-8"))
    expected_rows = data_rows(pipe_tables(expected))
    document = pypdfium2.PdfDocument(data)
    pages = len(document)
    document.close()
    out_dir = ROOT / "bench" / "results"
    out_dir.mkdir(parents=True, exist_ok=True)
    results = []

    for name in [item.strip() for item in args.pipelines.split(",") if item.strip()]:
        print(f"running {name}...", flush=True)
        markdown, chunks, seconds = extract(name, args.pdf, data)
        (out_dir / f"{name}.md").write_text(markdown, encoding="utf-8")
        chunk_lines = []
        for index, chunk in enumerate(chunks):
            chunk_lines.append(f"=== chunk {index} | {chunk.heading} ===")
            chunk_lines.append(chunk.text)
            chunk_lines.append("")
        (out_dir / f"{name}.chunks.txt").write_text("\n".join(chunk_lines), encoding="utf-8")

        metrics = extraction_metrics(markdown, expected, expected_rows, seconds, pages)
        chunk_info = chunk_metrics(chunks, expected, expected_rows)
        temporary, conn, conversation_id = open_search(markdown, chunks, args.pdf.name)
        scored: list[dict] = []
        input_tokens = 0
        output_tokens = 0
        try:
            for question in questions:
                record = {
                    "id": question["id"],
                    "kind": question["kind"],
                    "question": question["question"],
                    "expected": question["expected"],
                    "rank": None,
                    "ords": "",
                }
                if question["kind"] == "negative" and not args.answer:
                    scored.append(record)
                    continue
                k = 5 if question["kind"] != "negative" else get_settings().rag_top_k
                if args.answer:
                    k = max(k, get_settings().rag_top_k)
                hits = search(conn, conversation_id, question["question"], k=k)
                if question["kind"] != "negative":
                    record["rank"] = retrieval_rank(hits[:5], question)
                shown = hits[: get_settings().rag_top_k] if args.answer else hits[:5]
                record["ords"] = ",".join(str(hit["ord"]) for hit in shown)
                if args.answer:
                    answer, used_in, used_out = ask(question["question"], hits[: get_settings().rag_top_k], args.model)
                    record["answer"] = answer
                    record["grade"] = grade(question, answer)
                    input_tokens += used_in
                    output_tokens += used_out
                scored.append(record)
        finally:
            conn.close()
            temporary.cleanup()

        ranked = [record["rank"] for record in scored if record["kind"] != "negative"]
        retrieval = {
            "hit@1": sum(rank == 1 for rank in ranked) / len(ranked) if ranked else 0.0,
            "hit@2": sum(rank is not None and rank <= 2 for rank in ranked) / len(ranked) if ranked else 0.0,
            "mrr": sum((1 / rank) if rank else 0 for rank in ranked) / len(ranked) if ranked else 0.0,
        }
        result = {
            "name": name,
            "metrics": metrics,
            "chunks": chunk_info,
            "retrieval": retrieval,
            "questions": scored,
            "answered": args.answer,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cost": input_tokens / 1_000_000 * INPUT_USD_PER_MILLION
            + output_tokens / 1_000_000 * OUTPUT_USD_PER_MILLION,
            "pass_bar": [],
        }
        if name == "hybrid":
            result["pass_bar"] = hybrid_pass_bar(metrics, chunk_info, scored)
        results.append(result)

    report = out_dir / "report.md"
    write_report(report, pages, results)
    print_summary(results)
    print(f"wrote {report}")


if __name__ == "__main__":
    main()
