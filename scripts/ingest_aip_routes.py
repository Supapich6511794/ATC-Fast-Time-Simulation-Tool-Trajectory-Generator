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
import math
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


# "Overfly BKK" / "Overflying GOLUD" → the fix overflown (uppercase ident only,
# so "Overfly Bangkok FIR" — lower-case — is ignored).
_OVF_RE = re.compile(r"[Oo]verfl(?:y|ying)\s+([A-Z][A-Z0-9]{2,4})\b")


def _overfly_hubs(cell: str, waypoints: set[str]) -> list[str]:
    """Overfly hub fixes named in a FROM/TO cell ("Overfly BKK" → BKK), kept
    only when the fix is a known waypoint (drops "Bangkok FIR" etc.)."""
    out: list[str] = []
    for m in _OVF_RE.finditer(cell):
        h = m.group(1).upper()
        if h in waypoints and h not in out:
            out.append(h)
    return out


def _dist_nm(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Great-circle distance (NM) between two (lat, lon) points."""
    r = 3440.065
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dphi = math.radians(b[0] - a[0])
    dlmb = math.radians(b[1] - a[1])
    h = (
        math.sin(dphi / 2) ** 2
        + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    )
    return 2 * r * math.asin(min(1.0, math.sqrt(h)))


# An overfly-mix join is kept only when going via the hub is at most this much
# longer than the direct ADEP→ADES great circle — rejects nonsensical detours
# (e.g. VTBD→VTBS "via" far-off TIDAR/HTY) while keeping a hub that genuinely
# lies en route (VTCC→VTSP via BKK).
_MIX_MAX_DETOUR = 1.6


def _join_overfly(arr_route: str, dep_route: str, hub: str) -> str | None:
    """Splice an ``A → Overfly H`` arrival half (ends at the hub fix) with an
    ``Overfly H → B`` departure half (starts at it) at their shared hub —
    e.g. "PANTA Y7 BKK" + "BKK Y8 SAVSA" → "PANTA Y7 BKK Y8 SAVSA". ``None``
    when the hub fix isn't actually on both halves."""
    at = [t for t in arr_route.split() if t not in ("...", "…")]
    dt = [t for t in dep_route.split() if t not in ("...", "…")]
    if hub not in at or hub not in dt:
        return None
    a_end = len(at) - 1 - at[::-1].index(hub)  # last hub in the arrival half
    d_start = dt.index(hub)  # first hub in the departure half
    return " ".join(at[: a_end + 1] + dt[d_start + 1:])


# Source typos in the AIP where a fix and airway got concatenated.
_FIXUPS = {"DORNAW32": "DORNA W32"}


def _route_options(cell: str) -> list[tuple[str, str | None]]:
    """(route, condition) options from a ROUTE cell.

    Splits numbered "(1) … or (2) …" variants AND inline "(OR)" alternatives,
    lifts EVERY parenthetical note (incl. nested, e.g. "(MON-FRI … (Excluding
    …))" and "(for jet aircraft)") out of the route into the condition,
    collapses slash-separated airway alternatives ("Y22/Y23" → "Y22"), and
    drops overfly ellipses. Returns [] when nothing usable remains.

    An AIP "(OR)" inside a ROUTE cell separates two ALTERNATIVE filed routes
    (e.g. "NOBER W21 SURGU (OR) ALBOS R474 CMP W21 SURGU" = two routes), not a
    continuation — so it delimits options exactly like the numbered markers.
    """
    cell = cell.strip()
    if not cell:
        return []
    # Option delimiters: numbered "(1)/(2)" markers and the inline "(OR)".
    parts = re.split(r"\(\s*\d+\s*\)|\(\s*or\s*\)", cell, flags=re.I)
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

    aip = json.loads(_AIP.read_text(encoding="utf-8"))
    known = set(aip.get("airports", {}))
    waypoints = set(aip.get("waypoints", {}))
    # (lat, lon) for aerodromes and fixes — for the overfly-mix detour check.
    coord: dict[str, tuple[float, float]] = {}
    for icao, a in aip.get("airports", {}).items():
        if "lat" in a and "lon" in a:
            coord[icao] = (float(a["lat"]), float(a["lon"]))
    for ident, w in aip.get("waypoints", {}).items():
        coord[ident] = (float(w["lat"]), float(w["lon"]))
    print(f"  known aerodromes: {len(known)} | waypoints: {len(waypoints)}")

    p = _TableParser()
    p.feed(html)
    modes = _table_modes(html, len(p.tables))

    routes: list[dict[str, object]] = []
    seen: set[tuple[str, str, bool, str]] = set()
    direct_pairs: set[tuple[str, str]] = set()
    # Overfly half-routes for the mix step: hub fix + RNAV → list of
    # (aerodrome, route). `arr` = aerodrome → Overfly hub (ends at the hub);
    # `dep` = Overfly hub → aerodrome (starts at it).
    arr_halves: dict[tuple[str, bool], list[tuple[str, str]]] = {}
    dep_halves: dict[tuple[str, bool], list[tuple[str, str]]] = {}
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
            from_hubs = _overfly_hubs(row[fi], waypoints)
            to_hubs = _overfly_hubs(row[ti], waypoints)
            for route, cond in _route_options(row[ri]):
                # Direct aerodrome → aerodrome (the published filed route).
                for a in froms:
                    for b in tos:
                        if a == b:
                            continue
                        direct_pairs.add((a, b))
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
                # Overfly half-routes — collected for the join step below.
                for a in froms:
                    for hub in to_hubs:
                        arr_halves.setdefault((hub, rnav), []).append((a, route))
                for hub in from_hubs:
                    for b in tos:
                        dep_halves.setdefault((hub, rnav), []).append((b, route))

    # Overfly MIX (gap-fill): join an `A → Overfly H` arrival half with an
    # `Overfly H → B` departure half at the shared hub, for every overfly hub,
    # but ONLY for pairs with no published direct route (e.g. VTCC → VTSP via
    # BKK). Tagged ``via`` so a synthesized route is distinguishable from a
    # filed one.
    mixed = 0
    mseen: set[tuple[str, str, bool, str]] = set()
    for (hub, rnav), arrs in arr_halves.items():
        deps = dep_halves.get((hub, rnav), [])
        for a_apt, a_rt in arrs:
            for b_apt, b_rt in deps:
                if a_apt == b_apt or (a_apt, b_apt) in direct_pairs:
                    continue
                joined = _join_overfly(a_rt, b_rt, hub)
                if not joined:
                    continue
                toks = joined.split()
                # Reject a join that revisits a fix (an out-and-back loop).
                fixes = [t for t in toks if t in waypoints]
                if len(fixes) != len(set(fixes)):
                    continue
                # Reject a geographic detour: via-hub must be ≤ _MIX_MAX_DETOUR
                # × the direct ADEP→ADES distance (kills VTBD→VTBS "via" a
                # far-off hub; keeps a hub that's truly en route).
                ll_a, ll_b, ll_h = (
                    coord.get(a_apt),
                    coord.get(b_apt),
                    coord.get(hub),
                )
                if ll_a and ll_b and ll_h:
                    direct_d = _dist_nm(ll_a, ll_b)
                    via_d = _dist_nm(ll_a, ll_h) + _dist_nm(ll_h, ll_b)
                    if direct_d <= 0 or via_d > _MIX_MAX_DETOUR * direct_d:
                        continue
                key = (a_apt, b_apt, rnav, joined)
                if key in mseen:
                    continue
                mseen.add(key)
                routes.append(
                    {
                        "adep": a_apt,
                        "ades": b_apt,
                        "rnav": rnav,
                        "route": joined,
                        "via": hub,
                    }
                )
                mixed += 1

    routes.sort(key=lambda r: (r["adep"], r["ades"], not r["rnav"]))
    print(f"  route tables parsed: {route_tables}")
    direct = len(routes) - mixed
    print(f"  routes: {len(routes)} (direct: {direct} | overfly-mix: {mixed})")
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
            "options carry a 'condition' note. Entries with a 'via' field are "
            "overfly-mix routes — synthesized for a pair with no direct filed "
            "route by joining its two halves at the named overfly hub fix "
            "(e.g. VTCC->VTSP = PANTA Y7 BKK Y8 SAVSA, via BKK)."
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
