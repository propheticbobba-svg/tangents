import io
from pathlib import Path

import pypdfium2
import pytest

from app.pdf import (
    Box,
    Block,
    Region,
    Unit,
    assign_units,
    blocks_to_markdown,
    group_rows,
    join_units,
    merge_cross_page_tables,
    normalize_label,
    parse_table_html,
    pdf_to_markdown,
    table_markdown,
    xy_cut,
)
from app.rag import UnsupportedDocument

FIXTURE = Path(__file__).parent / "fixtures" / "test_document.pdf"
PAGE = Box(0, 0, 100_000, 100_000)


@pytest.fixture(autouse=True)
def _no_real_engines(monkeypatch):
    def explode() -> None:
        raise AssertionError("real engines in tests")

    monkeypatch.setattr("app.pdf.get_engines", explode)


class FakeEngines:
    def __init__(self, layout_regions=None, ocr_units=None, table_rows=None):
        self.layout_regions = [] if layout_regions is None else layout_regions
        self.ocr_units = [] if ocr_units is None else ocr_units
        self.table_rows = [] if table_rows is None else table_rows
        self.ocr_calls = []
        self.table_calls = []

    def layout(self, image):
        if callable(self.layout_regions):
            return self.layout_regions(image)
        return self.layout_regions

    def ocr(self, image):
        self.ocr_calls.append(image)
        if callable(self.ocr_units):
            return self.ocr_units(image)
        return self.ocr_units

    def table(self, image):
        self.table_calls.append(image)
        if callable(self.table_rows):
            return self.table_rows(image)
        return self.table_rows


def test_normalize_label():
    assert normalize_label("Plain Text") == "text"
    assert normalize_label("abandon") == "drop"
    assert normalize_label("Paragraph-Title") == "title"
    assert normalize_label("something_new") == "text"


def test_xy_cut_reads_columns_after_the_title():
    def block(x0, y0, x1, y1, text):
        return Block(0, Box(x0, y0, x1, y1), "text", text=text)

    ordered = xy_cut(
        [
            block(60, 40, 100, 70, "right-bottom"),
            block(0, 20, 40, 40, "left-top"),
            block(0, 0, 100, 10, "title"),
            block(60, 20, 100, 40, "right-top"),
            block(0, 40, 40, 70, "left-bottom"),
        ]
    )
    assert [block.text for block in ordered] == [
        "title",
        "left-top",
        "left-bottom",
        "right-top",
        "right-bottom",
    ]


def test_assign_units_prefers_table_and_keeps_orphans():
    text = Region(Box(0, 0, 100, 100), "text")
    table = Region(Box(0, 0, 50, 50), "table")
    inside = Unit(Box(10, 10, 12, 12), "cell")
    outside = Unit(Box(200, 200, 210, 210), "out")
    assigned, orphans = assign_units([inside, outside], [text, table])
    assert orphans == [outside]
    assert assigned == [(table, [inside])]


def test_group_rows_and_hyphen_join():
    rows = group_rows(
        [
            Unit(Box(20, 0, 30, 10), "beta"),
            Unit(Box(0, 0, 10, 10), "alpha"),
            Unit(Box(0, 30, 10, 40), "gamma"),
        ]
    )
    assert [[unit.text for unit in row] for row in rows] == [["alpha", "beta"], ["gamma"]]
    assert join_units(
        [Unit(Box(0, 0, 10, 10), "exam-"), Unit(Box(0, 30, 10, 40), "ple")]
    ) == "example"


def test_merge_cross_page_tables():
    box = Box(0, 0, 10, 10)
    continued = merge_cross_page_tables(
        [
            Block(0, box, "table", rows=[["ID", "Name"], ["a", "b"], ["c", "d"]]),
            Block(1, box, "table", rows=[["e", "f"], ["g", "h"]]),
        ]
    )
    assert len(continued) == 1
    assert continued[0].rows == [["ID", "Name"], ["a", "b"], ["c", "d"], ["e", "f"], ["g", "h"]]

    repeated = merge_cross_page_tables(
        [
            Block(0, box, "table", rows=[["ID", "Name"], ["#001", "Item 1"]]),
            Block(1, box, "table", rows=[["ID", "Name"], ["#002", "Item 2"]]),
        ]
    )
    assert repeated[0].rows == [["ID", "Name"], ["#001", "Item 1"], ["#002", "Item 2"]]

    different = merge_cross_page_tables(
        [
            Block(0, box, "table", rows=[["H1", "H2"], ["a", "b"]]),
            Block(1, box, "table", rows=[["c", "d", "e"]]),
        ]
    )
    assert len(different) == 2

    separated = merge_cross_page_tables(
        [
            Block(0, box, "table", rows=[["H1", "H2"], ["a", "b"]]),
            Block(0, box, "text", text="between"),
            Block(1, box, "table", rows=[["c", "d"]]),
        ]
    )
    assert [block.kind for block in separated] == ["table", "text", "table"]


def test_table_markdown_escapes_and_pads():
    assert table_markdown([["a|b", "c"], ["1"]]) == "| a\\|b | c |\n| --- | --- |\n| 1 |  |"


def test_parse_table_html():
    html = "<table><tr><td>a</td><td>b</td></tr><tr><td>1</td><td></td></tr></table>"
    assert parse_table_html(html) == [["a", "b"], ["1", ""]]


def test_blocks_to_markdown_moves_caption_before_table():
    box = Box(0, 0, 10, 10)
    text = blocks_to_markdown(
        [
            Block(0, box, "table", rows=[["A", "B"], ["1", "2"]]),
            Block(0, box, "table_caption", text="Totals"),
        ]
    )
    assert text.startswith("<!-- table-caption: Totals -->")
    assert "| A | B |" in text
    lone = blocks_to_markdown([Block(0, box, "table_caption", text="Just a note")])
    assert lone.strip() == "Just a note"


def test_text_layer_page_skips_ocr():
    engines = FakeEngines(layout_regions=[Region(PAGE, "text")])
    text = pdf_to_markdown(FIXTURE.read_bytes(), engines=engines)
    assert engines.ocr_calls == []
    assert text.index("introductory") < text.index("molestiae")


def test_text_layer_table_uses_pdfplumber():
    engines = FakeEngines(layout_regions=[Region(PAGE, "table")])
    text = pdf_to_markdown(FIXTURE.read_bytes(), engines=engines)
    assert engines.table_calls == []
    assert text.count("| ID | Name | Category | Status | Value |") == 1
    assert "#001" in text and "#020" in text and "#030" in text


def test_force_ocr_ignores_the_text_layer():
    engines = FakeEngines(ocr_units=[Unit(Box(0, 0, 20, 10), "scanned line")])
    text = pdf_to_markdown(FIXTURE.read_bytes(), force_ocr=True, engines=engines)
    assert len(engines.ocr_calls) == 2
    assert "scanned line" in text
    assert "introductory" not in text


def _image_only_pdf() -> bytes:
    document = pypdfium2.PdfDocument(FIXTURE)
    images = []
    try:
        for index in range(len(document)):
            page = document[index]
            images.append(page.render(scale=1).to_pil().convert("RGB"))
            page.close()
    finally:
        document.close()
    buffer = io.BytesIO()
    images[0].save(buffer, format="PDF", save_all=True, append_images=images[1:])
    return buffer.getvalue()


def test_image_only_pdf_uses_ocr_and_empty_ocr_raises():
    engines = FakeEngines()
    with pytest.raises(UnsupportedDocument, match="no extractable text"):
        pdf_to_markdown(_image_only_pdf(), engines=engines)
    assert len(engines.ocr_calls) == 2


def test_page_limit(monkeypatch):
    monkeypatch.setenv("PDF_MAX_PAGES", "1")
    monkeypatch.setattr("app.config._settings", None)
    with pytest.raises(UnsupportedDocument, match="the limit is 1"):
        pdf_to_markdown(FIXTURE.read_bytes(), engines=FakeEngines())


def test_unreadable_pdf_raises():
    with pytest.raises(UnsupportedDocument, match="could not be read as a PDF"):
        pdf_to_markdown(b"not a pdf", engines=FakeEngines())
