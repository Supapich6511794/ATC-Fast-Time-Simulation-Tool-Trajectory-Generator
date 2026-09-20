"""The ENR 1.10 scraper must read the route the AIP PUBLISHES.

An AIRAC amendment does not edit the eAIP page in place: the removed text stays
in the HTML as ``<del class="AmdtDeletedAIRAC">`` beside the ``<ins>`` that
replaces it, and the "hide amendments" stylesheet is what makes a reader see
only the new one. A parser that just collects a cell's text sees both. In the
2026-09-03 cycle that turned ``SEMBO A464 BEKOD DCT BEVKU W26 KADAV`` (TK
replaced by BEVKU) into ``… BEVKUTK W26 …`` — a fix that does not exist — and
the routes carrying it silently dropped out of the table.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from ingest_aip_routes import _TableParser  # noqa: E402


def _cells(html: str) -> list[list[str]]:
    p = _TableParser()
    p.feed(html)
    return p.tables[0]


def test_text_removed_by_an_amendment_is_not_part_of_the_route():
    html = (
        "<table><tr><td>VTBD</td><td>VTPM</td>"
        "<td>SEMBO A464 BEKOD DCT "
        '<ins class=" AmdtInsertedAIRAC">BEVKU</ins>'
        '<del class=" AmdtDeletedAIRAC">TK</del>'
        " W26 KADAV</td></tr></table>"
    )
    assert _cells(html) == [["VTBD", "VTPM", "SEMBO A464 BEKOD DCT BEVKU W26 KADAV"]]


def test_a_whole_deleted_fragment_and_a_deleted_suffix_both_go():
    html = (
        "<table><tr><td>A</td><td>"
        "UGUVO Y27 IKISU"
        '<del class="AmdtDeletedAIRAC">/SAGAG</del>'
        "</td></tr></table>"
    )
    assert _cells(html) == [["A", "UGUVO Y27 IKISU"]]


def test_a_page_with_no_amendments_reads_exactly_as_before():
    html = "<table><tr><td>VTBD</td><td>VTCC</td><td>OLVUK Y26 MARNI</td></tr></table>"
    assert _cells(html) == [["VTBD", "VTCC", "OLVUK Y26 MARNI"]]
