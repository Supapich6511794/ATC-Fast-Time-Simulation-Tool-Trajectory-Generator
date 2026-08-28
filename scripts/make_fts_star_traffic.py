"""Re-file the FTS traffic day with procedures: SID, STAR, runways, AIP routes.

``dummy_data/fts_traffic_20260709.csv`` is a whole day of Thai traffic — 1 990
flights — but filed the plain way: an en-route string, no terminal procedures,
no runways. Every flight therefore leaves and joins its aerodrome on a DCT,
which is not what any of them actually fly and not what the sequencer, the
departure check or the arrival ladder are there to work on.

This writes the same day back out as a PLAN file (the app's importable
callsign,actype,adep,ades,… form, one row per flight) with the arrival and
departure ends filled in the way the generator panel would fill them:

  * **Route** — for a city pair the AIP publishes a route for, the FILED route
    replaces the improvised one (RNAV preferred, as the panel's picker offers
    it). 581 of the day's 612 domestic flights have one; international legs and
    the handful of pairs with nothing published keep the route they came with.
  * **Runways** — the MEASURED default for that aerodrome and month
    (``runway_default.csv``, July here), departures off the DEP rows and
    arrivals off the ARR rows. A runway that publishes no procedure is dropped
    back to Auto rather than forced.
  * **SID / STAR** — the best-connecting procedure for the route AT THAT
    RUNWAY, from the same ``/api/suggest-procedure`` the panel calls. Where the
    chosen runway publishes none, the runway constraint is lifted before giving
    up on the procedure.
  * **Approach** — only where the arrival runway publishes exactly ONE, which
    is the same rule the panel now applies (`lib/procedureLink.ts`). Two
    approaches is a choice, and choices are left to the user.
No ground speed column is written. The source day cruises every aircraft at a
flat 460 kt — an AT76 included — so carrying it over would only propagate a
synthetic constant; left out, each flight is flown on its own type's
performance model, which is what the engine does with a filed level anyway.

Output: dummy_data/fts_traffic_20260709Star.csv

Run:  python scripts/make_fts_star_traffic.py [--verify 100]

``--verify N`` generates a spread of N of the written rows through the real
backend and reports any that fail, so the file is known to be flyable rather
than merely well-formed. ``--verify -1`` does all 1 990 (slow); 0 skips it.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))

SRC = _ROOT / "dummy_data" / "fts_traffic_20260709.csv"
OUT = _ROOT / "dummy_data" / "fts_traffic_20260709Star.csv"
ROUTES = _ROOT / "web" / "public" / "data" / "aip_routes_VT.json"
RUNWAYS = _ROOT / "web" / "public" / "data" / "airports" / "runway_default.csv"

FIELDS = [
    "callsign", "actype", "adep", "ades", "eobt", "rfl",
    "dep_rwy", "arr_rwy", "sid", "star", "approach", "route",
]

#: The banner that opens each block — "FLIGHT 12 of 1990  -  BKP211_VTBS_VTPO_…".
#: It sits BETWEEN two rule lines, so the blocks are sliced from banner to
#: banner rather than split on the rules (which would part a flight from its
#: own callsign).
_BANNER = re.compile(r"^FLIGHT \d+ of \d+\s+-\s+(.+)$", re.M)


def parse_source(text: str) -> list[dict]:
    """One record per FLIGHT block: the plan, plus the cruise speed flown."""
    banners = list(_BANNER.finditer(text))
    out: list[dict] = []
    for i, m in enumerate(banners):
        end = banners[i + 1].start() if i + 1 < len(banners) else len(text)
        body = text[m.end() : end]
        callsign = m.group(1).strip().split("_")[0]

        def field(name: str, b: str = body) -> str:
            f = re.search(rf"^{name}: (.*)$", b, re.M)
            return f.group(1).strip() if f else ""

        dep, dest = field("DEP"), field("DEST")
        if not (callsign and dep and dest):
            continue
        fl = field("FL").lstrip("F") or "0"
        atd = field("ATD")
        out.append({
            "callsign": callsign,
            "actype": field("ACTYPE"),
            "adep": dep,
            "ades": dest,
            "eobt": atd.replace(" ", "T") + "Z" if atd else "",
            "rfl": int(fl) if fl.isdigit() else 0,
            "route": field("ROUTE"),
        })
    return out


def aip_routes() -> dict[tuple[str, str], str]:
    """Filed route per directional city pair, RNAV first — the panel's order."""
    raw = json.loads(ROUTES.read_text(encoding="utf-8"))["routes"]
    out: dict[tuple[str, str], str] = {}
    for r in sorted(raw, key=lambda r: not r.get("rnav")):
        out.setdefault((r["adep"], r["ades"]), r["route"])
    return out


def runway_defaults() -> dict[tuple[str, int, str], str]:
    """(airport, month, DEP/ARR) -> the runway actually used most, as RW…"""
    out: dict[tuple[str, int, str], str] = {}
    with RUNWAYS.open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row["is_default"].strip().lower() != "t":
                continue
            out[(
                row["airport"].strip().upper(),
                int(row["month_of_year"]),
                row["direction"].strip().upper(),
            )] = f"RW{row['runway'].strip().upper()}"
    return out


class Procedures:
    """The panel's procedure questions, asked once each and remembered."""

    def __init__(self, client) -> None:
        self.c = client
        self._suggest: dict[tuple, str | None] = {}
        self._names: dict[tuple[str, str], list[str]] = {}

    def suggest(self, airport: str, kind: str, route: str, runway: str) -> str:
        key = (airport, kind, route, runway)
        if key not in self._suggest:
            params = {"type": kind, "route": route}
            if runway:
                params["runway"] = runway
            r = self.c.get(f"/api/suggest-procedure/{airport}", params=params)
            name = r.json().get("name") if r.status_code == 200 else None
            self._suggest[key] = str(name) if name else None
        return self._suggest[key] or ""

    def names(self, airport: str, kind: str) -> list[str]:
        key = (airport, kind)
        if key not in self._names:
            r = self.c.get(f"/api/procedures/{airport}", params={"type": kind})
            got = r.json().get(kind) if r.status_code == 200 else None
            self._names[key] = list(got or [])
        return self._names[key]

    def sole_approach(self, airport: str, runway: str) -> str:
        """The approach at `runway`, when the field publishes exactly one —
        the same rule `lib/procedureLink.ts` applies in the panel."""
        if not runway:
            return ""
        digits = runway[2:]
        served = [
            n for n in self.names(airport, "APPROACH")
            if re.match(rf"^R{re.escape(digits)}(-|$)", n.upper())
        ]
        return served[0] if len(served) == 1 else ""


def refile(rec: dict, routes, rwys, procs: Procedures) -> dict:
    """One source flight, filed the way the panel would file it."""
    dep, ades = rec["adep"], rec["ades"]
    month = int(rec["eobt"][5:7]) if len(rec["eobt"]) >= 7 else 0

    # 1. The published route for the pair, where there is one.
    route = routes.get((dep, ades), rec["route"])

    # 2. The runway that aerodrome really uses this month...
    dep_rwy = rwys.get((dep, month, "DEP")) or rwys.get((dep, month, "ALL"), "")
    arr_rwy = rwys.get((ades, month, "ARR")) or rwys.get((ades, month, "ALL"), "")

    # 3. ...and the procedure that connects the route to it. A runway with no
    #    published procedure is not worth forcing: drop the constraint, keep
    #    the procedure, and let the engine resolve the runway.
    sid = procs.suggest(dep, "SID", route, dep_rwy)
    if not sid and dep_rwy:
        sid = procs.suggest(dep, "SID", route, "")
        if sid:
            dep_rwy = ""
    star = procs.suggest(ades, "STAR", route, arr_rwy)
    if not star and arr_rwy:
        star = procs.suggest(ades, "STAR", route, "")
        if star:
            arr_rwy = ""

    return {
        **rec,
        "route": route,
        "dep_rwy": dep_rwy,
        "arr_rwy": arr_rwy,
        "sid": sid,
        "star": star,
        "approach": procs.sole_approach(ades, arr_rwy),
    }


def verify(client, rows: list[dict], n: int) -> None:
    """Generate a spread of the written rows for real and report failures."""
    if n == 0 or not rows:
        return
    picks = rows if n < 0 else [
        rows[i * len(rows) // min(n, len(rows))] for i in range(min(n, len(rows)))
    ]
    bad: list[str] = []
    for r in picks:
        spec = {
            "source": "fpl",
            "callsign": r["callsign"],
            "actype": r["actype"],
            "adep": r["adep"],
            "ades": r["ades"],
            "route": r["route"],
            "eobt": r["eobt"].replace("Z", ""),
            "rfl": r["rfl"],
        }
        for key, field in (
            ("sid", "sid"), ("star", "star"), ("approach", "approach"),
            ("sid_runway", "dep_rwy"), ("star_runway", "arr_rwy"),
        ):
            if r[field]:
                spec[key] = r[field]
        resp = client.post("/api/generate", json=spec)
        if resp.status_code != 200:
            bad.append(f"{r['callsign']} {r['adep']}->{r['ades']}: {resp.text[:110]}")
    print(f"Verified: {len(picks) - len(bad)}/{len(picks)} sampled plans generate")
    for line in bad[:10]:
        print(f"  FAIL {line}")
    if bad:
        raise SystemExit(f"{len(bad)} of {len(picks)} sampled plans do not generate")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--verify", type=int, default=100,
        help="generate this many of the written rows for real (-1 = all, 0 = none)",
    )
    args = ap.parse_args()

    from fastapi.testclient import TestClient  # noqa: PLC0415

    from api.server import app  # noqa: PLC0415

    src = parse_source(SRC.read_text(encoding="utf-8"))
    if not src:
        raise SystemExit(f"No flights parsed from {SRC}")
    routes, rwys = aip_routes(), runway_defaults()
    client = TestClient(app)
    procs = Procedures(client)

    rows = [refile(r, routes, rwys, procs) for r in src]

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows({k: r[k] for k in FIELDS} for r in rows)

    filed = sum(1 for r, s in zip(rows, src) if r["route"] != s["route"])
    print(f"Flights:  {len(rows)}")
    print(f"AIP route filed:  {filed}")
    print(f"SID:      {sum(1 for r in rows if r['sid'])}")
    print(f"STAR:     {sum(1 for r in rows if r['star'])}")
    print(f"Approach: {sum(1 for r in rows if r['approach'])}")
    print(f"DEP RWY:  {sum(1 for r in rows if r['dep_rwy'])}"
          f"   ARR RWY: {sum(1 for r in rows if r['arr_rwy'])}")
    print(f"CSV:      {OUT}")
    verify(client, rows, args.verify)


if __name__ == "__main__":
    main()
