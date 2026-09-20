"""Re-file a real CAT062 surveillance day as an importable FPL plan file.

``cat062_20251223.csv`` is 2.29 million radar returns — 2 953 distinct flights
over Thailand on 23 Dec 2025. It is a record of what was FLOWN: position, level
and speed, sampled every few seconds. It is not a set of flight plans, and the
tool imports flight plans.

This turns the one into the other, in the same shape as
``dummy_data/fts_traffic_20260709Star.csv`` — one row per flight, terminal
procedures filled in:

    callsign,actype,adep,ades,eobt,rfl,dep_rwy,arr_rwy,sid,star,approach,route

What comes from the surveillance day, and what has to come from somewhere else,
is worth being explicit about:

  * **callsign / adep / ades** — read straight off the track (``acid``, ``dep``,
    ``dest``).
  * **eobt** — the departure time carried in the flight key itself. Keys read
    ``ACID_ADEP_ADES_YYYY-MM-DD HH:MM``, and that time is the flight's
    departure rather than the first moment Thai radar saw it: it sits a median
    19 minutes before a Thai departure's first return, and a median 113 minutes
    before an inbound's, which is the flight it had already made to get here.
    So inbound legs get a real off-blocks time too.
  * **rfl** — the level actually cruised at: the highest ``measured_fl`` the
    flight HELD for more than a few returns, rounded to the nearest ten. Held,
    not touched, so one spurious plot cannot file the flight ten levels high;
    and the top one rather than a percentile, because an arrival spends most of
    its returns in the descent and on the ground, which drags a percentile down
    into the descent.
  * **actype** — NOT in CAT062, so it is borrowed from the reference day, which
    carries a type for every callsign it holds. 1 506 of these callsigns appear
    there by name and keep their own type; the rest take the type that operator
    flies most often in the reference; a handful of operators appear in neither
    and fall back to the reference day's own most common type. The fleet mix
    therefore matches the file this one is shaped after.
  * **route** — NOT in CAT062 either: a radar track has no filed route, so it
    comes from a table, in this order of confidence:

      1. the published AIP route for the pair (``aip_routes_VT.json``, RNAV
         preferred — the same table and order the generator panel offers);
      2. the same pair in the reference day;
      3. that pair the other way round, token-reversed — a route is fixes and
         the airways between them, so backwards is backwards;
      4. failing all three, a reference route to or from the same Thai
         aerodrome, choosing the one whose FIR boundary fix lies nearest to
         where this flight was really first (or last) seen. Nearest rather than
         most common, so a Frankfurt arrival is not filed in over the Gulf of
         Thailand.

    Flights that reach the end of that list are dropped. ``DCT`` alone was the
    first fallback tried and is not a route the engine accepts — "No waypoints
    parsed from route string" — so it would have written 1 498 rows that cannot
    be flown.
  * **dep_rwy / arr_rwy / sid / star / approach** — the same machinery as
    ``make_fts_star_traffic.py``, imported rather than copied, so the two files
    are filed by one set of rules: the measured default runway for that
    aerodrome and month (December here), the best-connecting procedure for the
    route at that runway, and an approach only where the runway publishes
    exactly one.

**Scope.** Only flights with at least one end in Thailand are written. The 538
pure overflights in the day have neither aerodrome in the 54 the tool knows, so
they could never be given a runway or a procedure, and a plan whose ADEP the
engine cannot resolve is not a plan. Dropped with them: tracks that never got
airborne (a stand's worth of ground returns under a flight key), tracks too
short to read a level off, and flights whose city pair appears in no route table
at all. Every count is printed.

**The clock.** These timestamps are UTC, despite
``make_dummyCAT062_flights.py`` documenting them as Thai local and subtracting
seven hours. Read as UTC, this day's Thai departures correlate at 0.90 with the
reference day's, whose times are explicitly UTC; shifted seven hours either way
the correlation collapses to -0.09 and -0.37. Bangkok has a departure bank at
07:00 local, not at 01:00. That sibling script has not been changed here — it
produces a committed dummy file — but its offset is worth a look.

Output: dummy_data/cat062_20251223_fpl.csv

Run:  python scripts/make_cat062_fpl.py [--verify 100]

``--verify N`` generates a spread of N of the written rows through the real
backend and reports any that fail, so the file is known to be flyable rather
than merely well-formed. ``--verify -1`` does all of them (slow); 0 skips it.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))

from scripts.make_fts_star_traffic import (  # noqa: E402
    Procedures,
    aip_routes,
    refile,
    runway_defaults,
)

SRC = _ROOT / "cat062_20251223.csv"
#: Where the aircraft types come from — the day this file is shaped after.
REF = _ROOT / "dummy_data" / "fts_traffic_20260709Star.csv"
OUT = _ROOT / "dummy_data" / "flight_plans_20251223.csv"

#: The import columns, in the order TrajX reads them. `gs` is the one addition
#: to the reference day's header: that file deliberately carried no ground speed
#: because its source cruised everything at a flat 460 kt, whereas here the
#: speed is measured off the track and is worth having.
FIELDS = [
    "callsign", "actype", "adep", "ades", "eobt", "rfl", "gs",
    "dep_rwy", "arr_rwy", "sid", "star", "approach", "route",
]

#: How many returns a level must hold to count as one the flight CRUISED at,
#: rather than one it passed through or one bad plot. Both a floor and a share,
#: so it means the same thing for a 40-return hop and a 2 700-return haul.
_HELD_MIN, _HELD_PCT = 3, 0.01
#: Filed levels are multiples of ten, and so is every level the panel offers.
_FL_STEP = 10
#: Above this nothing files; below it nothing here was really flying — see
#: `cruise_fl`, which drops rather than rounds a track that never got airborne.
_FL_FLOOR, _FL_MAX = 70, 450
#: A track this short is a fragment — a handover glimpse, or one stray return —
#: not a flight anyone can file a cruising level for.
_MIN_SAMPLES = 10
#: Total miss, entry plus exit, allowed when a route is matched to a track by
#: its ends. Beyond this the best candidate is simply the least bad one and is
#: not this flight's route; the flight is dropped instead of being given it.
_ROUTE_MATCH_MAX_NM = 260.0


def _pos(row: dict) -> tuple[float, float] | None:
    """The return's position, or None when the row carries no usable one."""
    try:
        return (float(row["latitude"]), float(row["longitude"]))
    except (TypeError, ValueError, KeyError):
        return None


def _secs(stamp: str) -> float | None:
    try:
        return datetime.strptime(stamp.strip(), "%Y-%m-%d %H:%M:%S").timestamp()
    except ValueError:
        return None


#: A leg between two returns is only believed as a speed sample inside these.
#: Below a second the quantised timestamps make the speed meaningless; above a
#: minute the aircraft has been out of coverage and the straight line between
#: the two plots is not the path it flew. The speed bounds throw out the plots
#: that jump.
_DT_MIN_S, _DT_MAX_S = 1.0, 60.0
_GS_MIN_KT, _GS_MAX_KT = 60, 700


def read_day(path: Path) -> dict[str, dict]:
    """One record per flight key, built in a single streaming pass.

    2.29 million rows is too many to hold, and nothing here needs them: the
    levels collapse into a counter as they arrive and only the first timestamp
    is kept, so the memory is one small record per flight rather than per
    return.
    """
    out: dict[str, dict] = {}
    with path.open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            key = row["flight_key"]
            rec = out.get(key)
            if rec is None:
                rec = out[key] = {
                    "key": key,
                    "acid": row["acid"].strip().upper(),
                    "adep": row["dep"].strip().upper(),
                    "ades": row["dest"].strip().upper(),
                    "first": row["time_of_track"],
                    # Where the track enters and leaves the picture. Used to
                    # choose a boundary fix that is on the right side of the
                    # country when no route is published for the pair.
                    "first_pos": _pos(row),
                    "last_pos": _pos(row),
                    "levels": Counter(),
                    # Observed ground speed, bucketed by the level it was flown
                    # at, so the CRUISE speed can be read off later without
                    # keeping a sample per return.
                    "gs": defaultdict(Counter),
                    "prev": None,
                    "n": 0,
                }
            rec["n"] += 1
            pos = _pos(row)
            rec["last_pos"] = pos or rec["last_pos"]

            # Ground speed straight off the track: the distance between two
            # consecutive returns over the time between them. This is measured,
            # not modelled — `ias_dap` in the same file is an AIRspeed, which is
            # a different number and not the one the plan field wants.
            t = _secs(row["time_of_track"])
            if pos and t is not None:
                prev = rec["prev"]
                if prev:
                    dt = t - prev[0]
                    if _DT_MIN_S <= dt <= _DT_MAX_S:
                        kt = _nm(prev[1], pos) / (dt / 3600.0)
                        if _GS_MIN_KT <= kt <= _GS_MAX_KT:
                            try:
                                fl = int(float(row["measured_fl"]))
                            except (TypeError, ValueError):
                                fl = 0
                            bucket = int(round(fl / _FL_STEP) * _FL_STEP)
                            rec["gs"][bucket][int(round(kt / 5) * 5)] += 1
                rec["prev"] = (t, pos)
            try:
                rec["levels"][int(float(row["measured_fl"]))] += 1
            except (TypeError, ValueError):
                pass
    return out


def cruise_gs(rec: dict, rfl: int) -> int:
    """The ground speed the flight held AT ITS CRUISE LEVEL.

    Bucketed by level and read at the cruise, so a climb-out or a descent —
    where the ground speed is nothing like the cruise — cannot drag the figure
    down. The median of that bucket rather than the mean: a couple of surviving
    bad plots should not move it. Widens to the levels near the cruise when the
    exact bucket is thin, and returns 0 when the track supports no honest
    answer at all, which the caller reports rather than papers over.
    """
    buckets: defaultdict[int, Counter] = rec["gs"]
    pool = Counter(buckets.get(rfl, Counter()))
    if sum(pool.values()) < 5:
        for fl, c in buckets.items():
            if fl >= rfl * 0.8:
                pool.update(c)
    total = sum(pool.values())
    if not total:
        return 0
    seen = 0
    for kt in sorted(pool):
        seen += pool[kt]
        if seen >= total / 2:
            return int(kt)
    return 0


def cruise_fl(levels: Counter) -> int:
    """The level a flight cruised at: the HIGHEST one it held, not the highest
    one it touched and not a percentile of all of them.

    A percentile looked reasonable and is wrong for the shape of this data. An
    arrival spends far more returns in a long descent and on the ground than it
    does at cruise, so most of its plots are low and the percentile lands in the
    descent — one Chiang Mai–Bangkok flight came out at FL149 against a real
    FL340. Taking the top level that lasted more than a few returns is immune to
    that, and equally immune to the single spurious plot that made a percentile
    look necessary in the first place.

    Returns 0 when the track never got airborne at all, which is a real case:
    some flight keys in the day are nothing but ground returns at the stand.
    Rounding one of those up to the filing floor would invent a cruise that was
    never flown, so the caller drops them instead.
    """
    total = sum(levels.values())
    if not total:
        return 0
    held = max(_HELD_MIN, int(total * _HELD_PCT))
    candidates = [fl for fl, n in levels.items() if n >= held]
    top = max(candidates) if candidates else max(levels)
    rounded = int(round(top / _FL_STEP) * _FL_STEP)
    return 0 if rounded < _FL_FLOOR else min(_FL_MAX, rounded)


def to_utc(stamp: str, fmt: str = "%Y-%m-%d %H:%M:%S") -> str:
    """`2025-12-23 14:44:30` -> `2025-12-23 14:44`.

    No offset. The clock in this file is ALREADY UTC, which is worth stating
    because `make_dummyCAT062_flights.py` says the opposite and subtracts seven
    hours for Thai local. The departure profile settles it: taken as UTC, this
    day's Thai departures correlate at 0.90 with the reference day's, whose
    times are explicitly UTC; shifted by seven hours either way the correlation
    collapses to -0.09 and -0.37. A 07:00 local Bangkok bank is a real thing and
    a 01:00 one is not.
    """
    # `YYYY-MM-DD HH:MM`, which the importer reads as UTC — a naive value is
    # UTC by the project's own rule, and the field is labelled "EOBT (UTC)".
    # `normEobt` in `lib/flightFile.ts` takes this shape and the explicit
    # `...T...Z` one equally; this is the one asked for.
    return datetime.strptime(stamp.strip(), fmt).strftime("%Y-%m-%d %H:%M")


def key_eobt(flight_key: str) -> str:
    """The departure time carried in the flight key itself.

    Keys read `ACID_ADEP_ADES_YYYY-MM-DD HH:MM`, and that trailing time is the
    flight's DEPARTURE, not the first time Thai radar saw it: across the day it
    sits a median 19 minutes before a Thai departure's first return (a taxi) and
    a median 113 minutes before an arrival's first return (the flight from
    wherever it came). So it is the off-blocks time an FPL wants, for inbound
    legs as much as outbound ones, and none of this has to be estimated.

    Empty when the key carries no parseable time, and the caller falls back.
    """
    try:
        return to_utc(flight_key.rsplit("_", 1)[-1], "%Y-%m-%d %H:%M")
    except (ValueError, IndexError):
        return ""


def fleet() -> tuple[dict[str, str], dict[str, str], str]:
    """Types from the reference day: by callsign, by operator, and a fallback.

    A callsign is the best answer — the same flight number is usually the same
    aeroplane — and the three-letter operator prefix is the next best. Both are
    read off the file this one is being shaped after, so the two days end up
    with the same fleet mix rather than an invented one.
    """
    by_callsign: dict[str, str] = {}
    by_operator: defaultdict[str, Counter] = defaultdict(Counter)
    overall: Counter = Counter()
    with REF.open(newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            cs, actype = row["callsign"].strip().upper(), row["actype"].strip().upper()
            if not cs or not actype:
                continue
            by_callsign[cs] = actype
            by_operator[cs[:3]][actype] += 1
            overall[actype] += 1
    operator = {op: c.most_common(1)[0][0] for op, c in by_operator.items()}
    return by_callsign, operator, overall.most_common(1)[0][0]


# --- Routes -----------------------------------------------------------------
#
# A radar track has no filed route, so every route here comes from a table. The
# order below is the order of confidence, and the last resort is to drop the
# flight rather than file something that would fly it round the wrong side of
# the country.

WAYPOINTS_VT = _ROOT / "web" / "public" / "data" / "airway_waypoint.geojson"
WAYPOINTS_ALL = _ROOT / "web" / "public" / "data" / "airways" / "airways_reporting.geojson"
#: The reporting-point file is WORLDWIDE and identifiers repeat across regions —
#: BUTRA is a fix in Thailand and another in Central Asia — so points from it are
#: only trusted inside a box around the Bangkok FIR and its neighbours.
_REGION = (0.0, 25.0, 90.0, 115.0)  # lat lo/hi, lon lo/hi


def waypoints() -> dict[str, tuple[float, float]]:
    """Fix identifier -> position, Thai enroute file first."""
    out: dict[str, tuple[float, float]] = {}
    raw = json.loads(WAYPOINTS_ALL.read_text(encoding="utf-8"))
    lo_la, hi_la, lo_lo, hi_lo = _REGION
    for ft in raw.get("features", []):
        wid = (ft.get("properties") or {}).get("waypoint_identifier")
        geom = ft.get("geometry") or {}
        coords = geom.get("coordinates")
        if not wid or not coords:
            continue
        pt = coords[0] if geom.get("type") == "MultiPoint" else coords
        while isinstance(pt, list) and pt and isinstance(pt[0], list):
            pt = pt[0]
        try:
            lat, lon = float(pt[1]), float(pt[0])
        except (TypeError, ValueError, IndexError):
            continue
        if lo_la <= lat <= hi_la and lo_lo <= lon <= hi_lo:
            out.setdefault(wid, (lat, lon))
    # The Thai enroute set wins: same identifiers, and these are the right ones.
    raw = json.loads(WAYPOINTS_VT.read_text(encoding="utf-8"))
    for ft in raw.get("features", []):
        p = ft.get("properties") or {}
        for wid_key, la_key, lo_key in (
            ("waypoint_identifier", "waypoint_latitude", "waypoint_longitude"),
            ("waypoint_identifier_2", "waypoint_latitude_2", "waypoint_longitude_2"),
        ):
            wid, la, lo = p.get(wid_key), p.get(la_key), p.get(lo_key)
            if wid and la is not None and lo is not None:
                out[wid] = (float(la), float(lo))
    return out


def reference_routes() -> tuple[dict[tuple[str, str], str], list[str]]:
    """Routes from the day this file is shaped after, indexed two ways.

    By city pair, which is the direct answer; and as a plain catalogue of every
    distinct route, which is what is left when the pair itself is not in the
    file. Both come from a set that was verified flyable when it was written, so
    a route taken from here is one the engine is known to accept.
    """
    by_pair: dict[tuple[str, str], str] = {}
    catalogue: list[str] = []
    with REF.open(newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            adep, ades = row["adep"].strip().upper(), row["ades"].strip().upper()
            route = row["route"].strip()
            if not (adep and ades and route):
                continue
            by_pair.setdefault((adep, ades), route)
            catalogue.append(route)
    return by_pair, list(dict.fromkeys(catalogue))


def _ends(route: str) -> tuple[str, str]:
    """The route's first and last fix. Tokens alternate fix, airway, fix, so
    both ends are always fixes."""
    parts = route.split()
    return (parts[0], parts[-1]) if parts else ("", "")


def _nm(a: tuple[float, float], b: tuple[float, float]) -> float:
    dlat = a[0] - b[0]
    dlon = (a[1] - b[1]) * math.cos(math.radians((a[0] + b[0]) / 2))
    return math.hypot(dlat, dlon) * 60.0


def build_rows(
    day: dict[str, dict], infer_routes: bool = False
) -> tuple[list[dict], Counter, Counter]:
    """The plan rows before procedures, what was dropped, and where each route
    came from — the last because a route is the one field here that is not in
    the surveillance data, so its provenance is worth stating rather than
    leaving to be inferred from the file."""
    by_callsign, by_operator, fallback = fleet()
    routes = aip_routes()
    ref_pair, ref_catalogue = reference_routes()
    fixes = waypoints()
    dropped: Counter = Counter()
    sourced: Counter = Counter()
    rows: list[dict] = []

    def route_for(adep: str, ades: str, rec: dict) -> tuple[str, str]:
        """The route to file, and where it came from."""
        # 1. What the AIP publishes for this pair. Best answer there is.
        got = routes.get((adep, ades))
        if got:
            return got, "AIP published"
        # 2. The same pair in the reference day.
        got = ref_pair.get((adep, ades))
        if got:
            return got, "reference, same pair"
        # 3. The pair the other way round. A route reads as a list of fixes and
        #    airways between them, so flying it backwards is the token list
        #    backwards — `TARED P646 BETNO` outbound is `BETNO P646 TARED` in.
        got = ref_pair.get((ades, adep))
        if got:
            return " ".join(reversed(got.split())), "reference, reversed"
        # 4. Nothing for the pair. OFF by default: what follows infers a route
        #    from the SHAPE of the track rather than from the pair, which is a
        #    guess about which published route the aircraft was on. It is a good
        #    guess and it is bounded, but it is still the only step here that
        #    does not tie a route to the city pair it was flown between, so it
        #    is opt-in and the 287 flights it would cover are otherwise dropped.
        if not infer_routes:
            return "", "none"
        #    Score every route the reference day flies by
        #    how well its two ends match where THIS flight was actually first
        #    and last seen, and take the best. Matching both ends is what makes
        #    it work for an overflight as well as for an arrival — the route has
        #    to enter where the aircraft entered and leave where it left — and
        #    choosing on distance rather than popularity is what keeps a
        #    Frankfurt arrival from being filed in over the Gulf of Thailand.
        entry, exit_ = rec["first_pos"], rec["last_pos"]
        if not (entry and exit_):
            return "", "none"
        best, best_nm = "", float("inf")
        for cand in ref_catalogue:
            a, b = _ends(cand)
            pa, pb = fixes.get(a), fixes.get(b)
            if not pa or not pb:
                continue
            d = _nm(entry, pa) + _nm(exit_, pb)
            if d < best_nm:
                best_nm, best = d, cand
        # A route whose ends are nowhere near this flight's is not this
        # flight's route, whatever the ranking says.
        if best and best_nm <= _ROUTE_MATCH_MAX_NM:
            return best, "reference, ends nearest the observed track"
        return "", "none"

    for rec in day.values():
        adep, ades, acid = rec["adep"], rec["ades"], rec["acid"]
        if not (adep and ades and acid):
            dropped["no aerodrome pair"] += 1
            continue
        if adep == ades:
            dropped["departs and lands at the same field"] += 1
            continue
        if rec["n"] < _MIN_SAMPLES:
            dropped[f"fewer than {_MIN_SAMPLES} returns"] += 1
            continue
        rfl = cruise_fl(rec["levels"])
        if rfl <= 0:
            dropped["never airborne (ground returns only)"] += 1
            continue

        route, whence = route_for(adep, ades, rec)
        if not route:
            dropped["no route to file (pair unknown everywhere)"] += 1
            continue
        sourced[whence] += 1

        gs = cruise_gs(rec, rfl)
        if gs <= 0:
            dropped["no usable ground speed on the track"] += 1
            continue

        rows.append({
            "callsign": acid,
            "actype": (
                by_callsign.get(acid)
                or by_operator.get(acid[:3])
                or fallback
            ),
            "adep": adep,
            "ades": ades,
            "eobt": key_eobt(rec["key"]) or to_utc(rec["first"]),
            "rfl": rfl,
            "gs": gs,
            "route": route,
            "dep_rwy": "",
            "arr_rwy": "",
            "sid": "",
            "star": "",
            "approach": "",
        })

    rows.sort(key=lambda r: (r["eobt"], r["callsign"]))
    return rows, dropped, sourced


def verify_rows(client, rows: list[dict], n: int) -> None:
    """Generate a spread of the written rows for real and report failures.

    Local rather than the shared `verify` so the ground speed goes with them:
    a plan that only generates when its speed is dropped is not the plan this
    file writes.
    """
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
            # The API wants the T form; the CSV carries the space form.
            "eobt": r["eobt"].replace(" ", "T"),
            "rfl": r["rfl"],
            "gs_kt": r["gs"],
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
    ap.add_argument(
        "--limit", type=int, default=0,
        help="write only the first N flights of the day (0 = all)",
    )
    ap.add_argument(
        "--infer-routes", action="store_true",
        help="also file flights whose city pair is in no route table, by matching "
             "the published route whose ends best fit the observed track "
             "(+287 flights, and the only routes here not tied to their pair)",
    )
    args = ap.parse_args()

    from fastapi.testclient import TestClient  # noqa: PLC0415

    from api.server import app  # noqa: PLC0415

    if not SRC.exists():
        raise SystemExit(f"Surveillance day not found: {SRC}")
    print(f"Reading {SRC.name} …")
    day = read_day(SRC)
    print(f"  {len(day)} distinct flights")

    rows, dropped, sourced = build_rows(day, infer_routes=args.infer_routes)
    if args.limit > 0:
        rows = rows[: args.limit]
    if not rows:
        raise SystemExit("No flights survived filtering")

    routes, rwys = aip_routes(), runway_defaults()
    client = TestClient(app)
    procs = Procedures(client)
    print(f"Filing {len(rows)} plans …")
    filed = [refile(r, routes, rwys, procs) for r in rows]

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows({k: r[k] for k in FIELDS} for r in filed)

    print()
    print(f"Flights:  {len(filed)}")
    print("  dropped:")
    for why, n in dropped.most_common():
        print(f"    {n:>5}  {why}")
    print("  route from:")
    for whence, n in sourced.most_common():
        print(f"    {n:>5}  {whence}")
    print(f"SID:      {sum(1 for r in filed if r['sid'])}")
    print(f"STAR:     {sum(1 for r in filed if r['star'])}")
    print(f"Approach: {sum(1 for r in filed if r['approach'])}")
    print(f"DEP RWY:  {sum(1 for r in filed if r['dep_rwy'])}"
          f"   ARR RWY: {sum(1 for r in filed if r['arr_rwy'])}")
    print(f"CSV:      {OUT}")
    verify_rows(client, filed, args.verify)


if __name__ == "__main__":
    main()
