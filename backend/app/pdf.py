"""PDF to Markdown. Text-layer pages stay exact; scans go through RapidOCR.

RapidLayout supplies region labels. Tables come from pdfplumber when the page
has a text layer, and from RapidTable otherwise. A table that continues on the
next page is one table.
"""

from __future__ import annotations

import io
import re
import threading
from dataclasses import dataclass, field
from html.parser import HTMLParser
from typing import Protocol

import numpy as np
import pdfplumber
import pypdfium2

from app.config import get_settings
from app.rag import UnsupportedDocument

RENDER_DPI = 200
SCALE = RENDER_DPI / 72
MIN_TEXT_LAYER_CHARS = 20
TABLE_PAD_PT = 4
CROP_PAD_PX = 8
LAYOUT_MODEL = "pp_doc_layoutv3"

LABELS = {
    "doc_title": "doc_title",
    "title": "title",
    "paragraph_title": "title",
    "section_header": "title",
    "table": "table",
    "table_caption": "table_caption",
    "table_title": "table_caption",
    "figure": "figure",
    "image": "figure",
    "chart": "figure",
    "header": "drop",
    "footer": "drop",
    "page_header": "drop",
    "page_footer": "drop",
    "abandon": "drop",
    "number": "drop",
    "header_image": "drop",
    "footer_image": "drop",
    "seal": "drop",
}


def normalize_label(name: str) -> str:
    key = re.sub(r"[\s\-]+", "_", name.strip().lower())
    return LABELS.get(key, "text")


@dataclass(frozen=True)
class Box:
    x0: float
    y0: float
    x1: float
    y1: float

    @property
    def center(self) -> tuple[float, float]:
        return ((self.x0 + self.x1) / 2, (self.y0 + self.y1) / 2)

    @property
    def area(self) -> float:
        return max(0.0, self.x1 - self.x0) * max(0.0, self.y1 - self.y0)

    @property
    def height(self) -> float:
        return max(0.0, self.y1 - self.y0)

    def contains(self, x: float, y: float) -> bool:
        return self.x0 <= x <= self.x1 and self.y0 <= y <= self.y1

    def union(self, other: Box) -> Box:
        return Box(
            min(self.x0, other.x0),
            min(self.y0, other.y0),
            max(self.x1, other.x1),
            max(self.y1, other.y1),
        )


@dataclass(frozen=True)
class Unit:
    box: Box
    text: str


@dataclass(frozen=True)
class Region:
    box: Box
    kind: str


@dataclass
class Block:
    page: int
    box: Box
    kind: str
    text: str = ""
    rows: list[list[str]] = field(default_factory=list)


class Engines(Protocol):
    def layout(self, image: np.ndarray) -> list[Region]: ...

    def ocr(self, image: np.ndarray) -> list[Unit]: ...

    def table(self, image: np.ndarray) -> list[list[str]]: ...


def _missing(value: object) -> bool:
    return value is None or len(value) == 0  # type: ignore[arg-type]


class RapidEngines:
    """Local ONNX layout, OCR, and table models. Downloaded on first use."""

    def __init__(self) -> None:
        from rapid_layout import RapidLayout
        from rapid_table import ModelType, RapidTable, RapidTableInput
        from rapidocr import RapidOCR

        self._layout = RapidLayout(model_type=LAYOUT_MODEL)
        self._ocr = RapidOCR()
        self._table = RapidTable(RapidTableInput(model_type=ModelType.SLANETPLUS))

    def layout(self, image: np.ndarray) -> list[Region]:
        result = self._layout(image)
        boxes = result.boxes
        names = result.class_names
        if _missing(boxes) or names is None:
            return []
        return [
            Region(Box(*(float(value) for value in box[:4])), normalize_label(str(name)))
            for box, name in zip(boxes, names)
        ]

    def ocr(self, image: np.ndarray) -> list[Unit]:
        result = self._ocr(image)
        if result is None or _missing(result.boxes) or _missing(result.txts):
            return []
        units: list[Unit] = []
        for points, text in zip(result.boxes, result.txts):
            quad = np.asarray(points, dtype=float)
            units.append(
                Unit(
                    Box(
                        float(quad[:, 0].min()),
                        float(quad[:, 1].min()),
                        float(quad[:, 0].max()),
                        float(quad[:, 1].max()),
                    ),
                    str(text),
                )
            )
        return units

    def table(self, image: np.ndarray) -> list[list[str]]:
        ocr = self._ocr(image)
        if ocr is None or _missing(ocr.boxes) or _missing(ocr.txts):
            return []
        out = self._table(image, ocr_results=[(ocr.boxes, ocr.txts, ocr.scores)])
        if _missing(out.pred_htmls):
            return []
        return parse_table_html(out.pred_htmls[0])


_engines: RapidEngines | None = None
_engines_lock = threading.Lock()


def get_engines() -> RapidEngines:
    global _engines
    if _engines is not None:
        return _engines
    with _engines_lock:
        if _engines is None:
            _engines = RapidEngines()
    return _engines


def render_page(page: pypdfium2.PdfPage) -> np.ndarray:
    pil = page.render(scale=SCALE).to_pil().convert("RGB")
    return np.ascontiguousarray(np.asarray(pil)[:, :, ::-1])


def crop(image: np.ndarray, box: Box) -> np.ndarray:
    height, width = image.shape[:2]
    x0 = max(0, int(np.floor(box.x0)) - CROP_PAD_PX)
    y0 = max(0, int(np.floor(box.y0)) - CROP_PAD_PX)
    x1 = min(width, int(np.ceil(box.x1)) + CROP_PAD_PX)
    y1 = min(height, int(np.ceil(box.y1)) + CROP_PAD_PX)
    if x1 <= x0 or y1 <= y0:
        return image[0:0, 0:0]
    return image[y0:y1, x0:x1]


def assign_units(
    units: list[Unit], regions: list[Region]
) -> tuple[list[tuple[Region, list[Unit]]], list[Unit]]:
    buckets: dict[int, list[Unit]] = {index: [] for index in range(len(regions))}
    orphans: list[Unit] = []
    for unit in units:
        x, y = unit.box.center
        candidates = [index for index, region in enumerate(regions) if region.box.contains(x, y)]
        if not candidates:
            orphans.append(unit)
            continue
        tables = [index for index in candidates if regions[index].kind == "table"]
        pool = tables or candidates
        chosen = min(pool, key=lambda index: (regions[index].box.area, index))
        buckets[chosen].append(unit)
    assigned = [(regions[index], buckets[index]) for index in range(len(regions)) if buckets[index]]
    return assigned, orphans


def group_rows(units: list[Unit]) -> list[list[Unit]]:
    if not units:
        return []
    ordered = sorted(units, key=lambda unit: (unit.box.center[1], unit.box.x0))
    rows: list[list[Unit]] = [[ordered[0]]]
    span = (ordered[0].box.y0, ordered[0].box.y1)
    for unit in ordered[1:]:
        overlap = min(span[1], unit.box.y1) - max(span[0], unit.box.y0)
        smaller = min(span[1] - span[0], unit.box.height)
        if smaller <= 0 or overlap < 0.5 * smaller:
            rows.append([unit])
            span = (unit.box.y0, unit.box.y1)
            continue
        rows[-1].append(unit)
        span = (min(span[0], unit.box.y0), max(span[1], unit.box.y1))
    for row in rows:
        row.sort(key=lambda unit: unit.box.x0)
    return rows


def join_units(units: list[Unit]) -> str:
    parts: list[str] = []
    for row in group_rows(units):
        piece = " ".join(" ".join(unit.text for unit in row).split())
        if not piece:
            continue
        if parts and parts[-1].endswith("-") and piece[0].islower():
            parts[-1] = parts[-1][:-1] + piece
        else:
            parts.append(piece)
    return " ".join(parts)


def split_on_gaps(blocks: list[Block], axis: str) -> list[list[Block]]:
    lo = (lambda block: block.box.y0) if axis == "y" else (lambda block: block.box.x0)
    hi = (lambda block: block.box.y1) if axis == "y" else (lambda block: block.box.x1)
    ordered = sorted(blocks, key=lo)
    groups: list[list[Block]] = [[ordered[0]]]
    end = hi(ordered[0])
    for block in ordered[1:]:
        if lo(block) > end:
            groups.append([block])
            end = hi(block)
        else:
            groups[-1].append(block)
            end = max(end, hi(block))
    return groups


def xy_cut(blocks: list[Block]) -> list[Block]:
    if len(blocks) <= 1:
        return list(blocks)
    for axis in ("y", "x"):
        groups = split_on_gaps(blocks, axis)
        if len(groups) > 1:
            return [block for group in groups for block in xy_cut(group)]
    return sorted(blocks, key=lambda block: (block.box.y0, block.box.x0))


def clean_rows(rows: list[list[str | None]]) -> list[list[str]]:
    cleaned: list[list[str]] = []
    for row in rows:
        cells = ["" if cell is None else " ".join(str(cell).split()) for cell in row]
        if any(cells):
            cleaned.append(cells)
    return cleaned


def table_ok(rows: list[list[str]]) -> bool:
    return bool(rows) and any(len(row) >= 2 for row in rows)


def text_layer_table(plumber_page: pdfplumber.page.Page, box: Box) -> list[list[str]]:
    x0 = box.x0 / SCALE - TABLE_PAD_PT
    y0 = box.y0 / SCALE - TABLE_PAD_PT
    x1 = box.x1 / SCALE + TABLE_PAD_PT
    y1 = box.y1 / SCALE + TABLE_PAD_PT
    px0, py0, px1, py1 = plumber_page.bbox
    bbox = (max(px0, x0), max(py0, y0), min(px1, x1), min(py1, y1))
    if bbox[2] <= bbox[0] or bbox[3] <= bbox[1]:
        return []
    tables = plumber_page.crop(bbox, strict=False).extract_tables() or []
    best = max(tables, key=lambda table: sum(len(row or []) for row in table), default=None)
    if not best:
        return []
    return clean_rows(best)


class _TableHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.rows: list[list[str]] = []
        self._row: list[str] | None = None
        self._cell: list[str] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag == "tr":
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell = []

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in ("td", "th") and self._cell is not None and self._row is not None:
            self._row.append("".join(self._cell))
            self._cell = None
        elif tag == "tr" and self._row is not None:
            self.rows.append(self._row)
            self._row = None

    def handle_data(self, data: str) -> None:
        if self._cell is not None:
            self._cell.append(data)


def parse_table_html(html: str) -> list[list[str]]:
    parser = _TableHTMLParser()
    parser.feed(html)
    return clean_rows(parser.rows)


def _row_width(rows: list[list[str]]) -> int:
    return max((len(row) for row in rows), default=0)


def _norm_row(row: list[str]) -> list[str]:
    return [" ".join(cell.lower().split()) for cell in row]


def merge_cross_page_tables(blocks: list[Block]) -> list[Block]:
    merged: list[Block] = []
    for block in blocks:
        prev = merged[-1] if merged else None
        if (
            block.kind == "table"
            and prev is not None
            and prev.kind == "table"
            and block.page == prev.page + 1
            and _row_width(block.rows) == _row_width(prev.rows)
        ):
            rows = block.rows
            if rows and _norm_row(rows[0]) == _norm_row(prev.rows[0]):
                rows = rows[1:]
            prev.rows.extend(rows)
            continue
        merged.append(block)
    return merged


def table_markdown(rows: list[list[str]]) -> str:
    width = max(len(row) for row in rows)

    def line(row: list[str]) -> str:
        padded = row + [""] * (width - len(row))
        cells = [cell.replace("|", "\\|") for cell in padded]
        return "| " + " | ".join(cells) + " |"

    lines = [line(rows[0]), "| " + " | ".join("---" for _ in range(width)) + " |"]
    lines.extend(line(row) for row in rows[1:])
    return "\n".join(lines)


def _place_captions(blocks: list[Block]) -> list[Block]:
    placed: list[Block] = []
    for index, block in enumerate(blocks):
        nxt = blocks[index + 1] if index + 1 < len(blocks) else None
        follows_table = (
            block.kind == "table_caption"
            and placed
            and placed[-1].kind == "table"
            and placed[-1].page == block.page
        )
        before_table = nxt is not None and nxt.kind == "table"
        if follows_table and not before_table:
            table = placed.pop()
            placed.append(block)
            placed.append(table)
            continue
        placed.append(block)
    return placed


def blocks_to_markdown(blocks: list[Block]) -> str:
    parts: list[str] = []
    ordered = _place_captions(blocks)
    for index, block in enumerate(ordered):
        nxt = ordered[index + 1] if index + 1 < len(ordered) else None
        if block.kind == "doc_title":
            parts.append(f"# {block.text}")
        elif block.kind == "title":
            parts.append(f"## {block.text}")
        elif block.kind == "table":
            parts.append(table_markdown(block.rows))
        elif block.kind == "table_caption" and nxt is not None and nxt.kind == "table" and nxt.page == block.page:
            parts.append(f"<!-- table-caption: {block.text.replace('-->', '')} -->")
        else:
            parts.append(block.text)
    body = "\n\n".join(part for part in parts if part.strip())
    return f"{body}\n" if body else ""


def page_blocks(
    index: int,
    pdfium_page: pypdfium2.PdfPage,
    plumber_page: pdfplumber.page.Page,
    engines: Engines,
    force_ocr: bool,
) -> list[Block]:
    image = render_page(pdfium_page)
    words = plumber_page.extract_words(keep_blank_chars=False, use_text_flow=False)
    text_layer = not force_ocr and sum(len(word["text"]) for word in words) >= MIN_TEXT_LAYER_CHARS
    if text_layer:
        units = [
            Unit(
                Box(
                    word["x0"] * SCALE,
                    word["top"] * SCALE,
                    word["x1"] * SCALE,
                    word["bottom"] * SCALE,
                ),
                word["text"],
            )
            for word in words
        ]
    else:
        units = engines.ocr(image)
    assigned, orphans = assign_units(units, engines.layout(image))
    blocks: list[Block] = []
    for region, region_units in assigned:
        kind = region.kind
        if kind in ("drop", "figure"):
            continue
        if kind == "table":
            rows = text_layer_table(plumber_page, region.box) if text_layer else []
            if not table_ok(rows):
                cropped = crop(image, region.box)
                rows = engines.table(cropped) if cropped.size else []
            if table_ok(rows):
                blocks.append(Block(index, region.box, "table", rows=rows))
                continue
            kind = "text"
        text = join_units(region_units)
        if text:
            blocks.append(Block(index, region.box, kind, text=text))
    for row in group_rows(orphans):
        box = row[0].box
        for unit in row[1:]:
            box = box.union(unit.box)
        blocks.append(Block(index, box, "text", text=join_units(row)))
    return xy_cut(blocks)


def pdf_to_markdown(
    data: bytes, *, force_ocr: bool = False, engines: Engines | None = None
) -> str:
    try:
        pdfium = pypdfium2.PdfDocument(data)
        plumber = pdfplumber.open(io.BytesIO(data))
    except Exception as exc:
        raise UnsupportedDocument("could not be read as a PDF") from exc
    try:
        count = len(pdfium)
        limit = get_settings().pdf_max_pages
        if count > limit:
            raise UnsupportedDocument(f"has {count} pages; the limit is {limit}")
        engines = engines or get_engines()
        blocks: list[Block] = []
        for index in range(count):
            pdfium_page = pdfium[index]
            try:
                blocks.extend(
                    page_blocks(index, pdfium_page, plumber.pages[index], engines, force_ocr)
                )
            finally:
                pdfium_page.close()
        markdown = blocks_to_markdown(merge_cross_page_tables(blocks))
    finally:
        plumber.close()
        pdfium.close()
    if not markdown.strip():
        raise UnsupportedDocument("has no extractable text")
    return markdown
