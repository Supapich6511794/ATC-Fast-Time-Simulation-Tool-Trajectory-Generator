"""Ingest Thai eAIP ENR 1.10 flight-planning routes into a local JSON.

ENR 1.10 ("Flight planning") publishes the predefined FROM / TO / ROUTE
tables — the real filed routes the generator should fly instead of a
computed best-route. This scraper parses those tables (handling the
rowspan-merged FROM column), keeps only AERODROME→AERODROME pairs (the
generator anchors ADEP/ADES, so overfly-fix rows aren't usable), splits the
RNAV vs Non-RNAV sections, captures conditional options, and writes
``web/public/data/aip_routes_VT.json``::

    { "airac": "...", "routes": [
        {"adep":"VTBD","ades":"VTCC","rnav":true,"route":"OLVUK Y26 MARNI"}, ...
    ]}

Rules mirrored from the AIP:
  * FROM/TO cells may list several aerodromes ("VTUN/VTUK/...") or mix in
    "Overfly X" / a co-located navaid ("VTCC/CMA"); we expand the slash
    list and keep only tokens that are known aerodromes (from aip_VT.json).
  * ROUTE strings hold only published fixes/airways — no ADEP/ADES ICAO.
  * Conditional routes "(1) … or (2) … (when VT D60 is not active)" become
    one entry per option, each tagged with its ``condition`` note.

Run after a new AIRAC (and after ingest_aip.py / complete_navdata.py so the
fixes resolve)::

    python scripts/ingest_aip_routes.py --airac 2026-06-11
    python scripts/ingest_aip_routes.py --airac 2026-06-11 --dry-run
"""

from __future__ import annotations

import argparse
import json
import re
import ssl
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
_AIP = _ROOT / "web" / "public" / "data" / "aip_VT.json"
_OUT = _ROOT / "web" / "public" / "data" / "aip_routes_VT.json"

_BASE = "https://aip.caat.or.th/{airac}-AIRAC/html/eAIP/"
_PAGE = "VT-ENR-1.10-en-GB.html"
_UA = "Mozilla/5.0 (ATC-FastTime-Sim navdata ingester)"

_ICAO_RE = re.compile(r"^[A-Z]{4}$")


def _fetch(airac: str) -> str:
    url = _BASE.format(airac=airac) + _PAGE
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=90, context=ctx) as r:
        return r.read().decode("utf-8", errors="replace")


class _TableParser(HTMLParser):
    """Collects every <table> as a grid (rowspan/colspan expanded). One grid
    per <table> tag (empty tables kept) so the grid index lines up 1:1 with
    the ``<table`` positions used for position-based RNAV/Non-RNAV tagging."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tables: list[list[list[str]]] = []
        self._in_table = False
        self._grid: list[list[str]] = []
        self._row: list[str] = []
        # Cells spanning into FUTURE rows: col -> (text, rows_remaining).
        self._carry: dict[int, tuple[str, int]] = {}
        self._occupied: set[int] = set()  # columns already filled this row
        self._in_cell = False
        self._cell: list[str] = []
        self._cell_span = 1
        self._cell_rowspan = 1
        self._col = 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "br" and self._in_cell:
            self._cell.append("\n")
            return
        if tag == "table":
            self._in_table = True
            self._grid = []
            self._carry = {}
            return
        if not self._in_table:
            return
        if tag == "tr":
            self._row = []
            self._col = 0
            self._occupied = set()
            # Pre-place cells carried down from earlier rows' rowspans, then
            # consume one row of each span (dropping those now exhausted).
            for col, (txt, _left) in sorted(self._carry.items()):
                while len(self._row) <= col:
                    self._row.append("")
                self._row[col] = txt
                self._occupied.add(col)
            self._carry = {
                col: (txt, left - 1)
                for col, (txt, left) in self._carry.items()
                if left - 1 > 0
            }
        elif tag in ("td", "th"):
            self._in_cell = True
            self._cell = []
            self._cell_span = int(a.get("colspan", "1") or "1")
            self._cell_rowspan = int(a.get("rowspan", "1") or "1")

    def handle_endtag(self, tag):
        if tag == "table" and self._in_table:
            self._in_table = False
            self.tables.append(self._grid)
            return
        if not self._in_table:
            return
        if tag in ("td", "th") and self._in_cell:
            self._in_cell = False
            text = re.sub(r"[ \t]+", " ", "".join(self._cell)).strip()
            while self._col in self._occupied:  # skip carried-down columns
                self._col += 1
            while len(self._row) <= self._col:
                self._row.append("")
            self._row[self._col] = text
            for k in range(self._cell_span):
                self._occupied.add(self._col + k)
            if self._cell_rowspan > 1:
                self._carry[self._col] = (text, self._cell_rowspan - 1)
            self._col += self._cell_span
        elif tag == "tr" and self._in_table:
            if any(c.strip() for c in self._row):
                self._grid.append(self._row)

    def handle_data(self, data):
        if self._in_cell:
            self._cell.append(data)


def _table_modes(html: str, n_tables: int) -> list[bool | None]:
    """RNAV(True)/Non-RNAV(False)/None for each <table>, by position: each
    table inherits the most recent preceding "… RNAV capable aircraft" /
    "… Non-RNAV capable aircraft" heading."""
    events: list[tuple[int, int, bool | None]] = []
    for m in re.finditer(r"<table", html):
        events.append((m.start(), 1, None))  # kind 1 = table
    for m in re.finditer(r"(NON[-\s]?)?RNAV\s+capable", html, re.I):
        is_rnav = not (m.group(1) and m.group(1).strip())
        events.append((m.start(), 0, is_rnav))  # kind 0 = heading
    events.sort(key=lambda e: (e[0], e[1]))  # heading before table at same pos
    modes: list[bool | None] = []
    cur: bool | None = None
    for _pos, kind, val in events:
        if kind == 0:
            cur = val
        else:
            modes.append(cur)
    # Guard: if counts drift, pad/truncate to n_tables.
    if len(modes) < n_tables:
        modes += [None] * (n_tables - len(modes))
    return modes[:n_tables]


def _airports(tokens: str, known: set[str]) -> list[str]:
    """Aerodrome ICAOs from a FROM/TO cell (split '/' and newlines; keep
    only known aerodromes — drops 'Overfly X' and navaid aliases)."""
    out: list[str] = []
    for part in re.split(r"[/\n]", tokens):
        t = part.strip().upper()
        if _ICAO_RE.match(t) and t in known and t not in out:
            out.append(t)
    return out


# Source typos in the AIP where a fix and airway got concatenated.
_FIXUPS = {"DORNAW32": "DORNA W32"}


def _route_options(cell: str) -> list[tuple[str, str | None]]:
    """(route, condition) options from a ROUTE cell.

    Splits numbered "(1) … or (2) …" variants, lifts EVERY parenthetical
    note (incl. nested, e.g. "(MON-FRI … (Excluding …))" and "(for jet
    aircraft)") out of the route into the condition, collapses slash-separated
    airway alternatives ("Y22/Y23" → "Y22"), and drops overfly ellipses.
    Returns [] when nothing usable remains.
    """
    cell = cell.strip()
    if not cell:
        return []
    parts = re.split(r"\(\s*\d+\s*\)", cell)  # numbered option markers
    chunks = [p for p in (s.strip() for s in parts) if p]
    out: list[tuple[str, str | None]] = []
    for ch in chunks:
        # Lift all parentheticals (innermost-first handles nesting).
        conds: list[str] = []
        while True:
            m = re.search(r"\(([^()]*)\)", ch)
            if not m:
                break
            note = m.group(1).strip()
            if note:
                conds.append(note)
            ch = ch[: m.start()] + " " + ch[m.end():]
        ch = re.sub(r"\bor\b", " ", ch, flags=re.I)  # drop 'or' connectors
        ch = ch.replace("…", " ").replace("...", " ")  # overfly continuations
        # Keep "A/B" airway alternatives (e.g. Y22/Y23) verbatim for display
        # fidelity; the generator collapses them to the first when flying.
        ch = " ".join(_FIXUPS.get(t, t) for t in ch.split())
        ch = re.sub(r"\s+", " ", ch).strip()
        if ch and re.search(r"[A-Z]{2,}", ch):
            cond = "; ".join(conds) or None
            out.append((ch, cond))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--airac", required=True, help="AIRAC date, e.g. 2026-06-11")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--html", help="parse a local HTML file instead of fetching")
    args = ap.parse_args()

    html = (
        Path(args.html).read_text(encoding="utf-8", errors="replace")
        if args.html
        else _fetch(args.airac)
    )

    known = set(json.loads(_AIP.read_text(encoding="utf-8")).get("airports", {}))
    print(f"  known aerodromes: {len(known)}")

    p = _TableParser()
    p.feed(html)
    modes = _table_modes(html, len(p.tables))

    routes: list[dict[str, object]] = []
    seen: set[tuple[str, str, bool, str]] = set()
    route_tables = 0
    for grid, rnav in zip(p.tables, modes):
        if rnav is None or not grid:
            continue
        header = [c.strip().upper() for c in grid[0]]
        if "FROM" not in header or "TO" not in header or "ROUTE" not in header:
            continue
        route_tables += 1
        fi, ti, ri = header.index("FROM"), header.index("TO"), header.index("ROUTE")
        for row in grid[1:]:
            if max(fi, ti, ri) >= len(row):
                continue
            froms = _airports(row[fi], known)
            tos = _airports(row[ti], known)
            if not froms or not tos:
                continue
            for route, cond in _route_options(row[ri]):
                for a in froms:
                    for b in tos:
                        if a == b:
                            continue
                        key = (a, b, rnav, route)
                        if key in seen:
                            continue
                        seen.add(key)
                        entry: dict[str, object] = {
                            "adep": a,
                            "ades": b,
                            "rnav": rnav,
                            "route": route,
                        }
                        if cond:
                            entry["condition"] = cond
                        routes.append(entry)

    routes.sort(key=lambda r: (r["adep"], r["ades"], not r["rnav"]))
    print(f"  route tables parsed: {route_tables}")
    print(f"  aerodrome-aerodrome routes: {len(routes)}")
    rn = sum(1 for r in routes if r["rnav"])
    print(f"    RNAV: {rn} | Non-RNAV: {len(routes) - rn}")
    pairs = {(r["adep"], r["ades"]) for r in routes}
    print(f"  distinct directional pairs: {len(pairs)}")
    for r in routes[:8]:
        tag = "RNAV" if r["rnav"] else "non"
        print(f"    {r['adep']}->{r['ades']} [{tag}] {r['route']}")

    if args.dry_run:
        print("  (dry-run: nothing written)")
        return

    payload = {
        "_comment": (
            "Predefined AIP flight-planning routes (ENR 1.10), scraped by "
            "scripts/ingest_aip_routes.py. route = published fixes/airways "
            "only (no ADEP/ADES ICAO); directional; rnav split; conditional "
            "options carry a 'condition' note."
        ),
        "airac": args.airac,
        "routes": routes,
    }
    _OUT.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"  wrote {_OUT.relative_to(_ROOT)} ({len(routes)} routes)")


if __name__ == "__main__":
    main()
