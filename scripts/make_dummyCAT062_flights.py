"""Generate a dummy flight file timed off the real CAT062 surveillance log.

Same export format and FPL set as scripts/make_dummyAll_flights.py (1 FPL =
1 published AIP route, 682 flights), but with three changes the brief asks for:

  * **Specific Departure / Arrival runway** is shown for every flight, taken
    from the chosen SID/STAR's runway transition (e.g. OLVU1B → RW03L).
  * **SID and STAR are shown** explicitly (named procedure per flight).
  * **No two aircraft start together** — each flight's reference start time is
    the *first* ``time_of_track`` of the matching flight key in
    web/Data/cat062_20251223.csv, taken in file order (flight N ⇄ Nth distinct
    flight key). ``time_of_track`` is Thai local (UTC+7), so the UTC start =
    time_of_track − 7h. e.g. the 1st key AAE142_VHHH_OMDW_2025-12-23 13:00 has
    first track 2025-12-23 14:44:30 → 2025-12-23T07:44:30Z.

  * **Flight key matches the CAT062 format** ``ACID_ADEP_ADES_YYYY-MM-DD HH:MM``
    (e.g. THA100_VTBD_VTCC_2025-12-23 07:44), built from each flight's own
    ACID/ADEP/ADES + its UTC start time (minute precision).

Outputs (round-trip through web/lib/flightFile.ts):
  * dummy_data/dummyCAT062_flights.csv      — stacked "FLIGHT n of N" blocks.
  * dummy_data/dummyCAT062_flights.geojson  — route LineString + POINT Z samples.

Run:  python scripts/make_dummyCAT062_flights.py
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import random
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

SAMPLES_PER_ROUTE = 16  # points written per route table (cosmetic)
_ICT_OFFSET_H = 7       # CAT062 time_of_track is Thai local (UTC+7)
# Realistic in-trail separation enforced between flights that share a departure
# corridor (same ADEP + SID) or an arrival corridor (same ADES + STAR). 180 s
# at ~450 kt ≈ 22 NM spacing, so aircraft on one track no longer stack up.
_SEP_S = 180.0
_GS_KT = 450.0
_NM_PER_DEG = 60.0  # ~1 NM per arc-minute (good enough for a duration estimate)

_ROOT = Path(__file__).resolve().parent.parent

import sys  # noqa: E402

sys.path.insert(0, str(_ROOT))
from _dummy_procs import (  # noqa: E402
    load_proc_runways,
    load_thr_elevs,
    make_expand_runway,
)
from trajectory_sim.performance import (  # noqa: E402
    reachable_ceiling_ft,
    register_field_elevations,
    register_runway_elevations,
    runway_threshold_elevation_ft,
)
from trajectory_sim.validation import (  # noqa: E402
    cab_cruising_level_capped,
)

OUT_DIR = _ROOT / "dummy_data"
AIP_PATH = _ROOT / "web" / "public" / "data" / "aip_VT.json"
ROUTES_PATH = _ROOT / "web" / "public" / "data" / "aip_routes_VT.json"
CAT062_PATH = _ROOT / "web" / "Data" / "cat062_20251223.csv"

_SID_LINE = _ROOT / "web" / "public" / "data" / "sid" / "sid_line_thai.geojson"
_STAR_LINE = _ROOT / "web" / "public" / "data" / "star" / "star_line.geojson"
_PBN_WPTS = _ROOT / "web" / "public" / "data" / "pbn" / "pbn_waypoint.geojson"


def _load_aip() -> tuple[dict, dict, dict]:
    data = json.loads(AIP_PATH.read_text(encoding="utf-8"))
    waypoints = {
        ident: (float(w["lat"]), float(w["lon"]))
        for ident, w in data["waypoints"].items()
    }
    airways = {desig: list(seq) for desig, seq in data["airways"].items()}
    airports: dict[str, tuple[float, float, int]] = {}
    for icao, a in data.get("airports", {}).items():
        if "lat" in a and "lon" in a:
            airports[icao] = (
                float(a["lat"]),
                float(a["lon"]),
                int(round(float(a.get("elev_ft", 0)))),
            )
    return waypoints, airways, airports


WAYPOINTS, AIRWAYS, AIRPORTS = _load_aip()


SIDS, SID_RWY = load_proc_runways(_SID_LINE)
STARS, STAR_RWY = load_proc_runways(_STAR_LINE)


def _load_approaches() -> dict[str, dict[str, list[str]]]:
    """Airport -> {"RW09": ["R09-Y", "R09-Z"], …} PBN instrument approaches,
    grouped by the arrival runway they serve.

    Mirrors ``web/lib/geojson.ts`` ``buildApproachIndex``: PBN procedures are
    named ``R{rwy}`` / ``R{rwy}-{variant}`` (e.g. R18, R09-Y), so the landing
    runway is parsed from the name and the approach is filed under the same
    ``RW{rwy}`` ident the web app's Arrival-RWY picker lists — so an imported
    flight pre-selects it instead of falling back to "None".
    """
    fc = json.loads(_PBN_WPTS.read_text(encoding="utf-8"))
    out: dict[str, dict[str, set[str]]] = {}
    for f in fc["features"]:
        p = f.get("properties") or {}
        airport = p.get("airport_identifier")
        name = p.get("procedure_identifier")
        if not airport or not name:
            continue
        m = re.match(r"^R(\d{2}[LCR]?)(?:-.*)?$", name.strip().upper())
        if not m:
            continue
        out.setdefault(airport, {}).setdefault(f"RW{m.group(1)}", set()).add(name)
    return {a: {r: sorted(v) for r, v in byr.items()} for a, byr in out.items()}


APPROACHES = _load_approaches()


def _pick_approach(ades: str, arr_rwy: str) -> str:
    """First published PBN approach that lands on ``arr_rwy`` at ``ades``
    (sorted, matching the web picker's order), or "" when none is coded."""
    if not arr_rwy:
        return ""
    opts = APPROACHES.get(ades, {}).get(arr_rwy, [])
    return opts[0] if opts else ""


def _ang_diff(a: float, b: float) -> float:
    """Smallest absolute angle (deg, 0-180) between two headings."""
    d = abs(a - b) % 360.0
    return d if d <= 180.0 else 360.0 - d


def _pick_arrival_fallback(ades: str, inbound_brg: float) -> tuple[str, str]:
    """Pick a landing runway + PBN approach for a flight that has no STAR (or
    whose STAR runway carries no coded approach).

    Without an arrival runway the sample descends straight onto the aerodrome
    point and slices across the field on final. Here we choose, among the
    aerodrome's published-approach runways, the one whose heading best lines up
    with the inbound track (``inbound_brg`` = bearing of the last route leg into
    the field), then take that runway's first approach — matching the web
    picker's order. Returns ("", "") when the aerodrome has no coded PBN
    approach at all (e.g. VTPT, VTUN)."""
    byr = APPROACHES.get(ades) or {}
    best: tuple[float, str, str] | None = None
    for rwy, names in byr.items():
        if not names:
            continue
        m = re.match(r"^RW(\d{2})", rwy)
        if not m:
            continue
        hdg = (int(m.group(1)) % 36) * 10.0
        cand = (_ang_diff(hdg, inbound_brg), rwy, names[0])
        if best is None or cand < best:
            best = cand
    return (best[1], best[2]) if best else ("", "")

# Feed the same elevation tables the engine uses so the dummy's cosmetic
# samples (and any later round-trip through the engine) share one source of
# truth: runway-threshold elevations, with the AIP field elevation as the
# fallback for runways/airports not in the threshold table.
THR_ELEV = load_thr_elevs()
register_runway_elevations(THR_ELEV)
register_field_elevations({icao: elev for icao, (_la, _lo, elev) in AIRPORTS.items()})
_expand_runway = make_expand_runway(THR_ELEV)


def _load_cat062_start_times() -> list[datetime]:
    """First ``time_of_track`` per distinct flight key (file order), as UTC.

    ``time_of_track`` is Thai local (UTC+7); UTC = local − 7h. The ordering is
    used to stagger the dummy flights so no two start at the same instant.
    """
    out: list[datetime] = []
    seen: set[str] = set()
    with CAT062_PATH.open(encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(fh):
            key = row["flight_key"]
            if key in seen:
                continue
            seen.add(key)
            local = datetime.strptime(
                row["time_of_track"].strip(), "%Y-%m-%d %H:%M:%S"
            )
            out.append(
                local.replace(tzinfo=timezone.utc)
                - timedelta(hours=_ICT_OFFSET_H)
            )
    return out


REF_TIMES = _load_cat062_start_times()


def _pick_proc(opts: list[str], fix: str | None) -> str:
    """First procedure whose alphabetic prefix matches the connecting fix
    (Thai naming: OLVUK → OLVU1B…), else "" (direct / no procedure)."""
    if not fix:
        return ""
    for n in opts:
        m = re.match(r"^[A-Z]+", n)
        if m and fix.startswith(m.group(0)):
            return n
    return ""


def _rwy(table: dict[tuple, str], airport: str, proc: str) -> str:
    """Runway for a chosen procedure as the full RW… transition id (e.g.
    "RW03L") — the exact value the web app's runway picker lists, so the
    imported flight pre-selects it instead of falling back to "Auto"."""
    return table.get((airport, proc), "")


def _route_fixes(route_str: str) -> tuple[str | None, str | None]:
    toks = [t.split("/")[0] if "/" in t else t for t in route_str.upper().split()]
    fixes = [t for t in toks if t != "DCT" and t in WAYPOINTS]
    return (fixes[0] if fixes else None, fixes[-1] if fixes else None)


ACTYPES = ["B738", "A320", "A321", "A333", "A359", "B77W", "B789", "B763"]
AIRLINES = ["THA", "AIQ", "TGW", "BKP", "DMK", "SEH", "NOK", "THD", "TVJ", "PGY"]
_RFL_RNAV = [340, 360, 380, 320, 300, 400, 350, 370]
_RFL_NON = [240, 220, 200, 180, 160]  # Non-RNAV: FL250 or below


def resolve_route_coords(route_str: str) -> list[tuple[str, float, float]]:
    """(ident, lat, lon) along an Item-15 route — expands `<fix> <airway>
    <fix>` spans and collapses slash airway alternatives, mirroring the
    server resolver. Unknown tokens are skipped."""
    toks = [t.split("/")[0] if "/" in t else t for t in route_str.upper().split()]
    out: list[tuple[str, float, float]] = []
    prev: str | None = None
    pending: str | None = None
    for t in toks:
        if t == "DCT":
            pending = None
            continue
        if t in AIRWAYS and t not in WAYPOINTS:
            pending = t
            continue
        if t in WAYPOINTS:
            if pending and prev and prev in WAYPOINTS:
                seq = [f for f in AIRWAYS[pending] if f in WAYPOINTS]
                if prev in seq and t in seq:
                    i, j = seq.index(prev), seq.index(t)
                    step = 1 if i < j else -1
                    for k in range(i + step, j, step):
                        out.append((seq[k], *WAYPOINTS[seq[k]]))
            la, lo = WAYPOINTS[t]
            out.append((t, la, lo))
            prev = t
            pending = None
    return out


def bearing(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return int(round(math.degrees(math.atan2(x, y)))) % 360


def alt_speed(f, rfl_ft, dep_elev, des_elev):
    if f < 0.2:
        return dep_elev + (rfl_ft - dep_elev) * (f / 0.2), 280, "climb"
    if f > 0.8:
        return des_elev + (rfl_ft - des_elev) * ((1 - f) / 0.2), 270, "descent"
    return rfl_ft, 460, "cruise"


def _point_at(coords, seglen, target):
    acc = 0.0
    for i in range(len(coords) - 1):
        if seglen[i] <= 0:
            continue
        if acc + seglen[i] >= target or i == len(coords) - 2:
            t = min(1.0, max(0.0, (target - acc) / seglen[i]))
            (a_lat, a_lon), (b_lat, b_lon) = coords[i], coords[i + 1]
            t2 = min(1.0, t + 0.01)
            return (
                a_lat + (b_lat - a_lat) * t,
                a_lon + (b_lon - a_lon) * t,
                a_lat + (b_lat - a_lat) * t2,
                a_lon + (b_lon - a_lon) * t2,
            )
        acc += seglen[i]
    lat, lon = coords[-1]
    return lat, lon, lat, lon


def route_seconds(route_pts) -> float:
    """Rough flight time (s) along the route polyline at a fixed cruise GS —
    used only to space arrivals on a shared STAR (great-circle, lat-corrected)."""
    nm = 0.0
    for i in range(len(route_pts) - 1):
        la1, lo1 = route_pts[i][1], route_pts[i][2]
        la2, lo2 = route_pts[i + 1][1], route_pts[i + 1][2]
        dlat = (la2 - la1) * _NM_PER_DEG
        dlon = (lo2 - lo1) * _NM_PER_DEG * math.cos(math.radians((la1 + la2) / 2))
        nm += math.hypot(dlat, dlon)
    return nm / _GS_KT * 3600.0


def sample_points(route_pts, eobt, rfl_ft, dep_elev, des_elev):
    coords = [(p[1], p[2]) for p in route_pts]
    seglen = [math.dist(coords[i], coords[i + 1]) for i in range(len(coords) - 1)]
    total = sum(seglen) or 1.0
    out = []
    for k in range(SAMPLES_PER_ROUTE):
        f = k / (SAMPLES_PER_ROUTE - 1)
        lat, lon, nlat, nlon = _point_at(coords, seglen, f * total)
        alt_ft, gs, phase = alt_speed(f, rfl_ft, dep_elev, des_elev)
        out.append({
            "lat": lat, "lon": lon, "alt_ft": alt_ft, "gs": gs,
            "trk": bearing(lat, lon, nlat, nlon), "phase": phase,
            "ts": eobt + timedelta(seconds=k * 360.0),
        })
    return out


def csv_block(callsign, actype, adep, ades, rfl, route_str, eobt, samples,
              sid="", star="", approach="", dep_rwy="", arr_rwy=""):
    lines = [
        f"ROUTE: {route_str}",
        f"DEP: {adep}",
        f"DEST: {ades}",
        f"ACTYPE: {actype}",
        f"FL: F{rfl}",
        f"ATD: {eobt.strftime('%Y-%m-%d %H:%M:%S')}",
    ]
    if dep_rwy:
        lines.append(f"DEP RWY: {dep_rwy}")
    if arr_rwy:
        lines.append(f"ARR RWY: {arr_rwy}")
    if sid:
        lines.append(f"SID: {sid}")
    if star:
        lines.append(f"STAR: {star}")
    if approach:
        lines.append(f"APPROACH: {approach}")
    lines += [
        "",
        "---",
        "",
        "Timestamp,UTC,Callsign,Lat,Lon,Altitude,Speed,Direction",
    ]
    for s in samples:
        epoch = int(s["ts"].timestamp())
        iso = s["ts"].strftime("%Y-%m-%dT%H:%M:%SZ")
        lines.append(
            f"{epoch},{iso},{callsign},{s['lat']:.6f},{s['lon']:.6f},"
            f"{int(round(s['alt_ft']))},{s['gs']},{s['trk']}"
        )
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Generate the dummy CAT062 flight file."
    )
    ap.add_argument(
        "--limit", type=int, default=None,
        help="keep only N flights, sampled evenly across the route list so the "
             "subset still spans varied city pairs (default: all 682)",
    )
    ap.add_argument(
        "--spread-min", type=float, default=None,
        help="space departures this many minutes apart so aircraft fly well "
             "separated — only a few airborne at once (default: real CAT062 timing)",
    )
    ap.add_argument(
        "--out", default="dummyCAT062_flights",
        help="output basename under dummy_data/ (default: dummyCAT062_flights)",
    )
    args = ap.parse_args()

    all_routes = json.loads(ROUTES_PATH.read_text(encoding="utf-8"))["routes"]
    # Keep only routes that resolve to a real polyline and whose aerodromes
    # have coordinates (so the cosmetic samples + map line draw correctly).
    usable = []
    for r in all_routes:
        if r["adep"] not in AIRPORTS or r["ades"] not in AIRPORTS:
            continue
        if "CTRI" in r["route"].split():  # AIP "CTR I" typo — no coords
            continue
        coords = resolve_route_coords(r["route"])
        if len(coords) >= 1:
            usable.append((r, coords))
    if args.limit and args.limit < len(usable):
        # Pick + order the subset by *round-robin over departure airports* so
        # (a) the flights leave from many random ADEPs instead of one busy hub,
        # and (b) consecutive departure slots are always different airports —
        # with the even-spread timing below, two flights leaving the same ADEP
        # end up ~(#airports) slots apart, never at nearly the same time.
        rng = random.Random(20251223)
        by_adep: dict[str, list] = {}
        for item in usable:
            by_adep.setdefault(item[0]["adep"], []).append(item)
        for lst in by_adep.values():
            rng.shuffle(lst)          # random route within each airport
        adeps = list(by_adep)
        rng.shuffle(adeps)            # random, but fixed, airport cycle order
        picked = []
        while len(picked) < args.limit:
            progressed = False
            for ap in adeps:          # one departure per airport per pass
                if by_adep[ap]:
                    picked.append(by_adep[ap].pop())
                    progressed = True
                    if len(picked) >= args.limit:
                        break
            if not progressed:
                break
        usable = picked

    if args.spread_min is None and not REF_TIMES:
        raise SystemExit(f"No CAT062 start times loaded from {CAT062_PATH}")

    # --- 1) Build each flight's fixed attributes + its CAT062 *base* start
    # time (flight N ⇄ Nth distinct CAT062 key, cycling if we outgrow the log).
    prelim = []
    for i, (r, coords) in enumerate(usable):
        adep, ades = r["adep"], r["ades"]
        first0, last0 = _route_fixes(r["route"])
        sid = _pick_proc(SIDS.get(adep, []), first0)
        star = _pick_proc(STARS.get(ades, []), last0)
        la1, lo1, e1 = AIRPORTS[adep]
        la2, lo2, e2 = AIRPORTS[ades]
        route_pts = (
            [(adep, la1, lo1)]
            + [(f, la, lo) for (f, la, lo) in coords]
            + [(ades, la2, lo2)]
        )
        actype = ACTYPES[i % len(ACTYPES)]
        # Concrete departure/arrival runway (expand a "both-parallels" STAR
        # runway RWxxB to a real side so it matches the app + threshold table).
        dep_rwy = _expand_runway(adep, _rwy(SID_RWY, adep, sid)) if sid else ""
        arr_rwy = _expand_runway(ades, _rwy(STAR_RWY, ades, star)) if star else ""
        # PBN instrument approach that lands on the chosen arrival runway (so
        # the imported flight pre-fills the Approach picker).
        approach = _pick_approach(ades, arr_rwy)
        # When the STAR path yields no coded approach — no STAR at all, or a STAR
        # whose runway has no PBN procedure — the flight would otherwise land
        # without an arrival runway and cut straight across the field on final.
        # Fall back to the published approach whose runway best lines up with the
        # inbound track, and adopt its runway as the arrival runway so the sample
        # (and any engine round-trip) descends onto a real threshold instead.
        if not approach:
            if last0 and last0 in WAYPOINTS:
                fla, flo = WAYPOINTS[last0]
                inbound = bearing(fla, flo, la2, lo2)
            else:
                inbound = bearing(la1, lo1, la2, lo2)
            fb_rwy, fb_app = _pick_arrival_fallback(ades, inbound)
            if fb_app:
                arr_rwy, approach = fb_rwy, fb_app
        # Snap the picked level to a CAB-compliant cruising level for the
        # ADEP->ADES track (odd FL eastbound 000-179, even FL westbound
        # 180-359; CAB Rules of the Air §2.4.2), capped to the level this
        # airframe can actually reach under the Thai APM data (e.g. B738 tops
        # at FL380) so the filed level == cruise level when the sim runs it.
        desired = (
            _RFL_RNAV[i % len(_RFL_RNAV)] if r.get("rnav")
            else _RFL_NON[i % len(_RFL_NON)]
        )
        rfl = cab_cruising_level_capped(
            bearing(la1, lo1, la2, lo2), desired,
            int(reachable_ceiling_ft(actype) // 100),
        )
        prelim.append({
            "callsign": f"{AIRLINES[i % len(AIRLINES)]}{100 + i:03d}",
            "actype": actype,
            "adep": adep, "ades": ades, "sid": sid, "star": star,
            "approach": approach,
            "dep_rwy": dep_rwy,
            "arr_rwy": arr_rwy,
            "rfl": rfl,
            "route_str": r["route"], "route_pts": route_pts,
            # Anchor the cosmetic climb/descent to the selected runway
            # thresholds (falls back to field elevation for an Auto runway).
            "dep_elev": runway_threshold_elevation_ft(adep, dep_rwy),
            "des_elev": runway_threshold_elevation_ft(ades, arr_rwy),
            "base": REF_TIMES[i % len(REF_TIMES)] if REF_TIMES else None,
            "dur": round(route_seconds(route_pts)),  # whole seconds
        })

    # --- 2) Separation pass. Working in CAT062-time order, push any flight
    # that would depart too close behind another on the *same departure
    # corridor* (ADEP + SID), or arrive too close behind another on the *same
    # arrival corridor* (ADES + STAR), out to the minimum separation. This is
    # what spreads the stack of same-runway departures into a realistic in-trail
    # stream instead of a solid line. Different SIDs/STARs diverge, so they're
    # treated as independent. Exact-instant collisions are nudged 1 s apart.
    if args.spread_min is not None:
        # Even global spread: every flight departs `spread_min` after the one
        # before it, regardless of corridor. With a ~50 min sector and a wide
        # gap only a handful are airborne at any instant, so the aircraft fly
        # well apart ("บินห่างๆกัน") instead of stacking into busy streams.
        origin = datetime(2025, 12, 23, 0, 0, tzinfo=timezone.utc)
        gap = timedelta(minutes=args.spread_min)
        for i, p in enumerate(prelim):
            p["eobt"] = origin + gap * i
    else:
        sep = timedelta(seconds=_SEP_S)
        dep_last: dict[tuple, datetime] = {}
        arr_last: dict[tuple, datetime] = {}
        used_starts: set[datetime] = set()
        for p in sorted(prelim, key=lambda x: x["base"]):
            dep_key = (p["adep"], p["sid"] or p["dep_rwy"] or "-")
            arr_key = (p["ades"], p["star"] or p["arr_rwy"] or "-")
            dur = timedelta(seconds=p["dur"])
            t = p["base"]
            if dep_key in dep_last:
                t = max(t, dep_last[dep_key] + sep)
            if arr_key in arr_last:
                t = max(t, arr_last[arr_key] + sep - dur)
            while t in used_starts:
                t += timedelta(seconds=1)
            used_starts.add(t)
            p["eobt"] = t
            dep_last[dep_key] = t
            arr_last[arr_key] = t + dur

    # --- 3) Build the flight records (samples + CAT062-format flight key) from
    # the separated start times.
    flights = []
    for p in prelim:
        eobt = p["eobt"]
        flight_key = (
            f"{p['callsign']}_{p['adep']}_{p['ades']}_"
            f"{eobt.strftime('%Y-%m-%d %H:%M')}"
        )
        flights.append({
            "callsign": p["callsign"], "actype": p["actype"],
            "adep": p["adep"], "ades": p["ades"],
            "eobt": eobt, "sid": p["sid"], "star": p["star"],
            "approach": p["approach"],
            "dep_rwy": p["dep_rwy"], "arr_rwy": p["arr_rwy"],
            "routes": [{
                "flight_key": flight_key,
                "route_str": p["route_str"],
                "rfl": p["rfl"],
                "route_pts": p["route_pts"],
                "samples": sample_points(
                    p["route_pts"], eobt, p["rfl"] * 100.0,
                    p["dep_elev"], p["des_elev"],
                ),
            }],
        })

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # ---- combined CSV (one block per flight; 1 route each) ----
    all_blocks = [(fl, rt) for fl in flights for rt in fl["routes"]]
    total = len(all_blocks)
    blocks = []
    for i, (fl, rt) in enumerate(all_blocks, start=1):
        banner = (
            "=" * 64
            + f"\nFLIGHT {i} of {total}  -  {rt['flight_key']}\n"
            + "=" * 64
            + "\n\n"
        )
        blocks.append(
            banner
            + csv_block(
                fl["callsign"], fl["actype"], fl["adep"], fl["ades"],
                rt["rfl"], rt["route_str"], fl["eobt"], rt["samples"],
                sid=fl["sid"], star=fl["star"], approach=fl["approach"],
                dep_rwy=fl["dep_rwy"], arr_rwy=fl["arr_rwy"],
            )
        )
    csv_path = OUT_DIR / f"{args.out}.csv"
    csv_path.write_text("\n\n\n".join(blocks) + "\n", encoding="utf-8")

    # ---- combined GeoJSON ----
    features = []
    for fl in flights:
        for rt in fl["routes"]:
            features.append({
                "type": "Feature",
                "properties": {
                    "feature_type": "route",
                    "flight_key": rt["flight_key"],
                    "route": rt["route_str"],
                    "callsign": fl["callsign"],
                    "aircraft_type": fl["actype"],
                    "adep": fl["adep"],
                    "ades": fl["ades"],
                    "rfl": rt["rfl"],
                    "sid": fl["sid"],
                    "star": fl["star"],
                    "approach": fl["approach"],
                    "dep_rwy": fl["dep_rwy"],
                    "arr_rwy": fl["arr_rwy"],
                    "eobt": fl["eobt"].isoformat(),
                    "idents": [p[0] for p in rt["route_pts"]],
                },
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[p[2], p[1]] for p in rt["route_pts"]],
                },
            })
            for s in rt["samples"]:
                features.append({
                    "type": "Feature",
                    "properties": {
                        "flight_key": rt["flight_key"],
                        "callsign": fl["callsign"],
                        "aircraft_type": fl["actype"],
                        "adep": fl["adep"],
                        "ades": fl["ades"],
                        "epoch_ts": s["ts"].strftime("%Y-%m-%d %H:%M:%S+00:00"),
                        "altitude_ft": round(s["alt_ft"], 1),
                        "tas_kt": None,
                        "gs_kt": float(s["gs"]),
                        "track_deg": s["trk"],
                        "phase": s["phase"],
                    },
                    "geometry": {
                        "type": "Point",
                        "coordinates": [
                            round(s["lon"], 6), round(s["lat"], 6),
                            round(s["alt_ft"] * 0.3048, 1),
                        ],
                    },
                })
    geojson_path = OUT_DIR / f"{args.out}.geojson"
    geojson_path.write_text(
        json.dumps({"type": "FeatureCollection", "features": features}),
        encoding="utf-8",
    )

    proc = sum(1 for fl in flights if fl["sid"] or fl["star"])
    rwys = sum(1 for fl in flights if fl["dep_rwy"] or fl["arr_rwy"])
    apps = sum(1 for fl in flights if fl["approach"])
    span = (
        f"{min(f['eobt'] for f in flights).isoformat()} … "
        f"{max(f['eobt'] for f in flights).isoformat()}"
    )
    print(f"Flights: {len(flights)} (1 FPL = 1 route) | with SID/STAR: {proc} "
          f"| with RWY: {rwys} | with APPROACH: {apps}")
    print(f"UTC span: {span}")
    print(f"CSV:     {csv_path}")
    print(f"GeoJSON: {geojson_path}")


if __name__ == "__main__":
    main()
