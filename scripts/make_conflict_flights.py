"""Generate a dummy flight file that produces **resolvable** conflicts for
testing the web app's Conflict Detection & Resolution (CD&R) — using ONLY real
AIP data.

Requirements this file satisfies:
  * **AIP routes only** — every flight flies a real published route from
    aip_routes_VT.json. Nothing is hand-built or reversed.
  * **RNAV only** — only routes flagged ``rnav`` in the AIP are used.
  * **SID + STAR + Approach** — every flight carries a coded SID at its ADEP, a
    coded STAR at the ADES, and a PBN instrument approach on the arrival runway.

How the conflicts arise — and why they are RESOLVABLE:
  The previous version funnelled every flight into ONE hub/runway (an
  arrival-merge rush). Those conflicts can't be cleared by a vector/level/speed
  because both aircraft *must* reach the same runway — turning one away just
  brings it back to the merge, so the advisory returns "no resolution" and the
  Download never changes.

  This version builds two RESOLVABLE conflict types, timed so each pair meets at
  the same instant at the same level (FL350):

    1. CROSSING (different destinations) — two published routes whose paths cross
       geometrically at a mid-cruise point but continue to DIFFERENT airports. A
       level change, heading offset or speed reduction separates them and they
       fly on to their own destinations — no re-merge. The AIP network is
       hub-and-spoke, so genuine co-altitude crossings are scarce (~3).

    2. IN-TRAIL OVERTAKE (same route) — a faster jet (B77W) behind a slower one
       (A320) on an IDENTICAL published route, timed to close the gap and bust
       separation in cruise. Cleared by slowing (or stepping) the rear aircraft,
       which just re-sequences the pair — same destination is fine because the
       fix INCREASES in-trail spacing rather than re-merging. These fill the
       scenario out to the requested flight count.

  Every pair is therefore Apply-able: fix it → it moves to ✓ FIXED → the Download
  (and a re-import) reflects the post-fix trajectory.

  Timing is CALIBRATED against the real backend engine: because a trajectory's
  shape is EOBT-invariant, each route is generated once to measure the exact
  seconds-from-departure to (and altitude at) the meet point, then EOBTs are set
  so the pair coincides. Crossings whose aircraft aren't level at the meet (e.g.
  a fix that sits in the Bangkok arrival descent) are dropped. Pairs are DISJOINT
  (each flight in exactly one conflict → one departure time) and staggered across
  the timeline so the conflicts don't all happen at once.

Run:  python scripts/make_conflict_flights.py [--n 10] [--pairs 5]
"""

from __future__ import annotations

import argparse
import importlib
import json
import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))
sys.path.insert(0, str(_ROOT / "scripts"))

# Reuse the main dummy generator's AIP resolver, procedure auto-selection,
# samplers and writers so the output is byte-compatible with the importer.
_m = importlib.import_module("make_dummyCAT062_flights")
resolve_route_coords = _m.resolve_route_coords
route_seconds = _m.route_seconds
sample_points = _m.sample_points
csv_block = _m.csv_block
bearing = _m.bearing
WAYPOINTS = _m.WAYPOINTS
AIRPORTS = _m.AIRPORTS
SIDS, SID_RWY = _m.SIDS, _m.SID_RWY
STARS, STAR_RWY = _m.STARS, _m.STAR_RWY
_pick_proc = _m._pick_proc
_rwy = _m._rwy
_expand_runway = _m._expand_runway
_pick_approach = _m._pick_approach
_pick_arrival_fallback = _m._pick_arrival_fallback
_route_fixes = _m._route_fixes
_thr_elev = _m.runway_threshold_elevation_ft
_NM_PER_DEG = _m._NM_PER_DEG

ROUTES_PATH = _ROOT / "web" / "public" / "data" / "aip_routes_VT.json"
OUT_DIR = _ROOT / "dummy_data"

RFL = 350  # everyone at FL350 → co-altitude at the crossing fix
ACTYPES = ["A359", "B789", "A333", "B77W", "A321", "B738", "A320", "B763", "A332", "B739"]
AIRLINES = ["THA", "AIQ", "BKP", "SEH", "NOK", "TVJ", "DMK", "THD", "PGY", "TGW"]

# A crossing must be well inside cruise for BOTH routes (so both are level at
# FL350 and a level change is valid — not mid-climb/descent) and the two tracks
# must actually cross at an angle (not run in-trail down a shared airway). Cruise
# is bounded by DISTANCE, not route fraction. This is only a LOOSE prefilter to
# drop obvious climb/descent crossings cheaply — the real co-altitude gate is the
# engine calibration below, which measures the actual altitude at the fix.
CLIMB_NM = 40.0
DESC_NM = 55.0
MIN_CROSS_ANGLE = 25.0  # deg between the two inbound tracks at the shared fix


def _procs(adep: str, ades: str, route_str: str):
    """SID / STAR / dep-rwy / arr-rwy / PBN approach for a flight (same logic as
    the main dummy). Returns ("","","","","") when a piece isn't coded."""
    first0, last0 = _route_fixes(route_str)
    sid = _pick_proc(SIDS.get(adep, []), first0)
    star = _pick_proc(STARS.get(ades, []), last0)
    dep_rwy = _expand_runway(adep, _rwy(SID_RWY, adep, sid)) if sid else ""
    arr_rwy = _expand_runway(ades, _rwy(STAR_RWY, ades, star)) if star else ""
    approach = _pick_approach(ades, arr_rwy)
    if not approach:
        la1, lo1, _ = AIRPORTS[adep]
        la2, lo2, _ = AIRPORTS[ades]
        if last0 and last0 in WAYPOINTS:
            fla, flo = WAYPOINTS[last0]
            inbound = bearing(fla, flo, la2, lo2)
        else:
            inbound = bearing(la1, lo1, la2, lo2)
        fb_rwy, fb_app = _pick_arrival_fallback(ades, inbound)
        if fb_app:
            arr_rwy, approach = fb_rwy, fb_app
    return sid, star, dep_rwy, arr_rwy, approach


def _ang_gap(a: float, b: float) -> float:
    d = abs(a - b) % 360.0
    return 360.0 - d if d > 180.0 else d


_LAT0 = 13.5  # planar-projection reference latitude (central Thailand)


def _planar(route_pts):
    """Project a polyline to a local equirectangular NM frame for fast 2-D
    segment maths."""
    cos0 = math.cos(math.radians(_LAT0))
    return [(lo * cos0 * 60.0, la * 60.0) for _, la, lo in route_pts]


def _cumnm(xy):
    cum = [0.0]
    for k in range(1, len(xy)):
        cum.append(cum[-1] + math.dist(xy[k - 1], xy[k]))
    return cum


def _seg_int(a1, a2, b1, b2):
    """Intersection of segments a1a2 and b1b2 (planar). Returns ``(t, u)`` in
    [0,1] along each, or None."""
    x1, y1 = a1
    x2, y2 = a2
    x3, y3 = b1
    x4, y4 = b2
    d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3)
    if abs(d) < 1e-9:
        return None  # parallel / collinear
    t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d
    u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d
    if 0.0 <= t <= 1.0 and 0.0 <= u <= 1.0:
        return t, u
    return None


def _first_cross(A, B):
    """First geometric crossing of two route polylines. Returns a dict with the
    crossing lat/lon, along-track distance on each route, and the angle between
    the two tracks — or None if the paths don't cross."""
    xa, ca, pa = A["_xy"], A["_cum"], A["route_pts"]
    xb, cb, pb = B["_xy"], B["_cum"], B["route_pts"]
    for p in range(len(xa) - 1):
        for q in range(len(xb) - 1):
            r = _seg_int(xa[p], xa[p + 1], xb[q], xb[q + 1])
            if not r:
                continue
            t, u = r
            da = ca[p] + t * (ca[p + 1] - ca[p])
            db = cb[q] + u * (cb[q + 1] - cb[q])
            la1, lo1 = pa[p][1], pa[p][2]
            la2, lo2 = pa[p + 1][1], pa[p + 1][2]
            clat = la1 + t * (la2 - la1)
            clon = lo1 + t * (lo2 - lo1)
            ba = bearing(la1, lo1, la2, lo2)
            bb = bearing(pb[q][1], pb[q][2], pb[q + 1][1], pb[q + 1][2])
            return {"lat": clat, "lon": clon, "da": da, "db": db, "ang": _ang_gap(ba, bb)}
    return None


def _nearest_fix(lat, lon):
    """Nearest named waypoint to a point (for display only)."""
    cos0 = math.cos(math.radians(lat))
    best = (9e9, "enroute")
    for name, (fla, flo) in WAYPOINTS.items():
        d = math.hypot((lat - fla) * 60.0, (lon - flo) * 60.0 * cos0)
        if d < best[0]:
            best = (d, name)
    return best[1]


def _candidates():
    """All real AIP RNAV routes that carry a full SID + STAR + approach, resolved
    to a full polyline (adep .. enroute .. ades) with its planar projection. One
    entry per (adep, ades, route)."""
    routes = json.loads(ROUTES_PATH.read_text(encoding="utf-8"))["routes"]
    out = []
    seen = set()
    for r in routes:
        if not r.get("rnav"):
            continue
        adep, ades = r.get("adep"), r.get("ades")
        if adep not in AIRPORTS or ades not in AIRPORTS or adep == ades:
            continue
        key = (adep, ades, r["route"])
        if key in seen:
            continue
        coords = resolve_route_coords(r["route"])
        if len(coords) < 2:
            continue
        sid, star, dep_rwy, arr_rwy, approach = _procs(adep, ades, r["route"])
        if not (sid and star and approach):
            continue
        la1, lo1, _ = AIRPORTS[adep]
        la2, lo2, _ = AIRPORTS[ades]
        route_pts = [(adep, la1, lo1)] + [(f, la, lo) for f, la, lo in coords] + [(ades, la2, lo2)]
        xy = _planar(route_pts)
        cum = _cumnm(xy)
        if cum[-1] < 120:  # ignore tiny hops (no real cruise)
            continue
        seen.add(key)
        out.append({
            "adep": adep, "ades": ades, "route_str": r["route"],
            "sid": sid, "star": star, "dep_rwy": dep_rwy, "arr_rwy": arr_rwy,
            "approach": approach, "route_pts": route_pts,
            "_xy": xy, "_cum": cum, "total_nm": cum[-1],
        })
    return out


def _crossings(cands):
    """Every pair of routes (bound for DIFFERENT destinations) whose paths cross
    geometrically at a point that is loosely mid-cruise for both and where the
    tracks meet at ≥ MIN_CROSS_ANGLE. Records the crossing point + geometry. The
    real co-altitude check happens later, against the engine. Sorted best-first
    (widest angle, most central)."""
    pairs = []
    for i in range(len(cands)):
        A = cands[i]
        for j in range(i + 1, len(cands)):
            B = cands[j]
            if A["ades"] == B["ades"]:
                continue  # same destination → arrival-merge, not resolvable
            x = _first_cross(A, B)
            if not x:
                continue
            da, db, ang = x["da"], x["db"], x["ang"]
            if not (CLIMB_NM <= da <= A["total_nm"] - DESC_NM):
                continue
            if not (CLIMB_NM <= db <= B["total_nm"] - DESC_NM):
                continue
            if ang < MIN_CROSS_ANGLE:
                continue
            central = abs(da / A["total_nm"] - 0.5) + abs(db / B["total_nm"] - 0.5)
            x.update({"i": i, "j": j, "score": ang - central * 40.0,
                      "cell": (round(x["lat"] / 0.4), round(x["lon"] / 0.4))})
            pairs.append(x)
    pairs.sort(key=lambda p: -p["score"])
    return pairs


def _select(xs, cands, want, *, uniq_ades: bool, distinct_cell: bool, distinct_adep: bool):
    """Greedily pick up to `want` crossings under a set of disjointness rules.

    HARD (always): each route used once, so every flight has one EOBT; and the
    two flights of a pair have different destinations (enforced in ``_crossings``)
    so the crossing itself is resolvable. SOFT (relaxed across the fallback
    tiers): globally-unique destinations (no shared ADES anywhere — the strongest
    guard against an incidental arrival-merge), one crossing location per pair (so
    pairs stay geographically separated), and distinct ADEPs (variety). Even when
    a destination is shared, the pair-stagger keeps those flights well in-trail,
    not co-incident, so a shared runway stays conflict-free."""
    used_route: set[int] = set()
    used_ades: set[str] = set()
    used_adep: set[str] = set()
    used_cell: set = set()
    chosen = []
    for x in xs:
        i, j = x["i"], x["j"]
        if i in used_route or j in used_route:
            continue
        A, B = cands[i], cands[j]
        if uniq_ades and (A["ades"] in used_ades or B["ades"] in used_ades):
            continue
        if distinct_cell and x["cell"] in used_cell:
            continue
        if distinct_adep and (A["adep"] in used_adep or B["adep"] in used_adep):
            continue
        used_route |= {i, j}
        used_ades |= {A["ades"], B["ades"]}
        used_adep |= {A["adep"], B["adep"]}
        used_cell.add(x["cell"])
        chosen.append(x)
        if len(chosen) >= want:
            break
    return chosen


def _select_best(xs, cands, want):
    """Try progressively looser tiers until `want` pairs are found. Distinct
    crossing locations are kept as long as possible (relaxed only in the last tier)."""
    tiers = (
        dict(uniq_ades=True, distinct_cell=True, distinct_adep=True),
        dict(uniq_ades=True, distinct_cell=True, distinct_adep=False),
        dict(uniq_ades=False, distinct_cell=True, distinct_adep=True),
        dict(uniq_ades=False, distinct_cell=True, distinct_adep=False),
        dict(uniq_ades=False, distinct_cell=False, distinct_adep=False),
    )
    chosen = []
    for t in tiers:
        chosen = _select(xs, cands, want, **t)
        if len(chosen) >= want:
            return chosen
    return chosen  # best effort (fewer than `want`)


def _spec_req(p, eobt):
    """A /api/generate request body for flight plan `p` at departure `eobt`."""
    return {
        "source": "fpl", "adep": p["adep"], "ades": p["ades"], "route": p["route_str"],
        "callsign": p.get("callsign", "CAL"), "eobt": eobt.isoformat(), "rfl": p["rfl"], "actype": p["actype"],
        "sid": p["sid"] or None, "star": p["star"] or None, "approach": p["approach"] or None,
        "sid_runway": p["dep_rwy"] or None, "star_runway": p["arr_rwy"] or None,
    }


def _engine_traj(client, p, eobt):
    """Generate `p` through the real backend engine and return its points as
    ``[(epoch_s, lat, lon, alt_ft)]`` (empty on failure)."""
    r = client.post("/api/generate", json=_spec_req(p, eobt))
    if r.status_code != 200:
        return []
    out = []
    for x in r.json()["points"]:
        ts = datetime.fromisoformat(x["epoch_ts"].replace("Z", "+00:00")).timestamp()
        out.append((ts, x["lat"], x["lon"], x.get("altitude_ft")))
    return out


def _pass_at_fix(traj, fix_lat, fix_lon):
    """From a trajectory, return ``(seconds_from_start_to_fix, alt_ft_at_fix)`` —
    the point nearest the crossing fix. The trajectory shape is EOBT-invariant so
    this offset is stable; only the absolute clock shifts with EOBT."""
    if not traj:
        return None, None
    t0 = traj[0][0]
    best = (9e9, 0.0, None)
    for t, la, lo, al in traj:
        dlat = (la - fix_lat) * 60.0
        dlon = (lo - fix_lon) * 60.0 * math.cos(math.radians((la + fix_lat) / 2))
        d = math.hypot(dlat, dlon)
        if d < best[0]:
            best = (d, t - t0, al)
    return best[1], best[2]


# ---- In-trail overtake (a second, abundant, resolvable conflict type) ----
# The hub-and-spoke AIP network yields only a handful of different-destination
# cruise CROSSINGS. To fill out the scenario we add same-route OVERTAKES: a
# faster aircraft behind a slower one on an identical published route. It closes
# the gap and busts separation in cruise — cleanly resolvable by slowing (or
# stepping) the rear aircraft, which just re-sequences the pair. Same destination
# is fine here: the resolution INCREASES in-trail spacing, it doesn't re-merge.
SLOW_TYPE = "A320"   # ~M0.78 leader
FAST_TYPE = "B77W"   # ~M0.84 catcher


def _arc_profile(traj):
    """``[(t_from_start, arclen_nm, lat, lon, alt)]`` along a trajectory."""
    if not traj:
        return []
    t0, s = traj[0][0], 0.0
    out = [(0.0, 0.0, traj[0][1], traj[0][2], traj[0][3])]
    for k in range(1, len(traj)):
        _, la, lo, al = traj[k]
        pa, po = traj[k - 1][1], traj[k - 1][2]
        s += math.hypot((la - pa) * 60.0, (lo - po) * 60.0 * math.cos(math.radians((la + pa) / 2)))
        out.append((traj[k][0] - t0, s, la, lo, al))
    return out


def _at_arc(prof, L):
    """Interpolate ``(t_from_start, lat, lon, alt)`` at arclength L."""
    for k in range(1, len(prof)):
        if prof[k][1] >= L:
            (t0, s0, la0, lo0, a0), (t1, s1, la1, lo1, a1) = prof[k - 1], prof[k]
            f = (L - s0) / (s1 - s0) if s1 > s0 else 0.0
            return t0 + f * (t1 - t0), la0 + f * (la1 - la0), lo0 + f * (lo1 - lo0), a0 + f * (a1 - a0)
    t, _, la, lo, al = prof[-1]
    return t, la, lo, al


def _build_intrail(cands, client, origin, need, used_idx):
    """Up to `need` in-trail overtake pairs from UNUSED long-cruise routes. Each
    pair is (leader_dict, catcher_dict) already carrying the calibrated ``_delta``
    (seconds from departure to the mid-cruise meet point) so the shared timing
    model in ``main`` positions both aircraft at the meet together."""
    cruise_min = RFL * 100.0 - 500.0
    order = sorted((k for k in range(len(cands)) if k not in used_idx),
                   key=lambda k: -cands[k]["total_nm"])  # longest cruise first
    out = []
    used_ap = set()  # keep overtake pairs on distinct airports so their departure
    #                  corridors don't overlap and spawn incidental conflicts
    for k in order:
        if len(out) >= need:
            break
        cand = cands[k]
        if cand["adep"] in used_ap or cand["ades"] in used_ap:
            continue
        lead = dict(cand); lead["actype"] = SLOW_TYPE; lead["rfl"] = RFL
        rear = dict(cand); rear["actype"] = FAST_TYPE; rear["rfl"] = RFL
        pl = _arc_profile(_engine_traj(client, lead, origin))
        pr = _arc_profile(_engine_traj(client, rear, origin))
        if len(pl) < 3 or len(pr) < 3:
            continue
        # meet at the midpoint of the leader's cruise band
        band = [s for _, s, _, _, al in pl if al is not None and al >= cruise_min]
        if len(band) < 2:
            continue
        L = 0.5 * (band[0] + band[-1])
        t_lead, mlat, mlon, alt_l = _at_arc(pl, L)
        t_rear, _, _, _ = _at_arc(pr, L)
        dt = t_lead - t_rear  # >0 ⇒ catcher (faster) departs later, meets at L
        if not (25.0 <= dt <= 600.0) or alt_l < cruise_min:
            continue  # not enough speed differential to overtake in cruise
        for who, delta, alt in ((lead, t_lead, alt_l), (rear, t_rear, alt_l)):
            who["cross_fix"] = _nearest_fix(mlat, mlon)
            who["cross_angle"] = 0.0  # same-track overtake
            who["_delta"], who["_alt_at_fix"] = delta, alt
            who["dep_elev"] = _thr_elev(who["adep"], who["dep_rwy"])
            who["des_elev"] = _thr_elev(who["ades"], who["arr_rwy"])
            who["flight_s"] = route_seconds(who["route_pts"])
        out.append((lead, rear))
        used_idx.add(k)
        used_ap |= {cand["adep"], cand["ades"]}
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="Generate the AIP-only RNAV resolvable-conflict test file.")
    ap.add_argument("--n", type=int, default=10, help="number of flights (default 10 = 5 pairs)")
    ap.add_argument("--pairs", type=int, default=None, help="number of crossing pairs (default n//2)")
    ap.add_argument("--gap", type=float, default=180.0, help="seconds between successive pair crossings (default 180)")
    args = ap.parse_args()

    want = args.pairs if args.pairs is not None else args.n // 2

    cands = _candidates()
    for k, c in enumerate(cands):
        c["actype"] = ACTYPES[k % len(ACTYPES)]  # deterministic per route → calibration matches output
        c["rfl"] = RFL
    pairs = _crossings(cands)
    if not pairs:
        raise SystemExit("No resolvable crossing pairs found in the AIP RNAV network.")

    origin = datetime(2025, 12, 23, 0, 0, tzinfo=timezone.utc)

    # ---- Calibrate against the REAL engine ----
    # The trajectory shape is EOBT-invariant, so generate each route that appears
    # in a candidate crossing ONCE and measure, at its crossing fix, (a) the
    # seconds-from-departure and (b) the altitude. (a) lets us time a pair to meet
    # exactly; (b) lets us DROP crossings where either aircraft isn't level at
    # FL350 (e.g. NOBER sits in the Bangkok arrival descent) — so we keep only
    # genuine co-altitude conflicts instead of guessing cruise from route geometry.
    from fastapi.testclient import TestClient  # local import: engine only needed here
    from server import app  # noqa: E402
    client = TestClient(app)

    pool = pairs[: min(len(pairs), max(400, want * 80))]
    involved = {x["i"] for x in pool} | {x["j"] for x in pool}
    print(f"calibrating {len(involved)} routes across {len(pool)} candidate crossings ...")
    traj_cache = {k: _engine_traj(client, cands[k], origin) for k in involved}

    CRUISE_MIN = RFL * 100.0 - 500.0  # ≥ FL345 at the crossing ⇒ level, co-altitude
    good = []
    for x in pool:
        di, ai = _pass_at_fix(traj_cache[x["i"]], x["lat"], x["lon"])
        dj, aj = _pass_at_fix(traj_cache[x["j"]], x["lat"], x["lon"])
        if ai is None or aj is None or ai < CRUISE_MIN or aj < CRUISE_MIN:
            continue  # one aircraft not level at the crossing → not a clean conflict
        x["_di"], x["_ai"], x["_dj"], x["_aj"] = di, ai, dj, aj
        good.append(x)
    if not good:
        raise SystemExit("No co-altitude cruise crossings after calibration.")
    _rset = {x["i"] for x in good} | {x["j"] for x in good}
    print(f"co-altitude crossings: {len(good)} across {len(_rset)} distinct routes "
          f"({len({(cands[x['i']]['ades'], cands[x['j']]['ades']) for x in good})} distinct dest-pairs)")

    chosen = _select_best(good, cands, want)

    # Each pair is (flightA, flightB); crossings first, then in-trail overtakes to
    # top up to `want` pairs when the network runs out of cruise crossings.
    flightpairs = []
    used_idx = set()
    for x in chosen:
        used_idx |= {x["i"], x["j"]}
        pa = dict(cands[x["i"]]); pb = dict(cands[x["j"]])
        for p, dlt, alt in ((pa, x["_di"], x["_ai"]), (pb, x["_dj"], x["_aj"])):
            p["cross_fix"] = _nearest_fix(x["lat"], x["lon"])
            p["cross_angle"] = x["ang"]
            p["dep_elev"] = _thr_elev(p["adep"], p["dep_rwy"])
            p["des_elev"] = _thr_elev(p["ades"], p["arr_rwy"])
            p["flight_s"] = route_seconds(p["route_pts"])
            p["_delta"], p["_alt_at_fix"], p["kind"] = dlt, alt, "cross"
        flightpairs.append((pa, pb))

    if len(flightpairs) < want:
        need = want - len(flightpairs)
        print(f"only {len(flightpairs)} cruise crossings; adding up to {need} in-trail overtakes ...")
        for lead, rear in _build_intrail(cands, client, origin, need, used_idx):
            lead["kind"] = rear["kind"] = "overtake"
            flightpairs.append((lead, rear))
    if not flightpairs:
        raise SystemExit("No resolvable conflicts could be built from the AIP RNAV network.")
    if len(flightpairs) < want:
        print(f"NOTE: only {len(flightpairs)} resolvable pairs available (wanted {want}).")

    # Flatten to the per-flight list with pair numbers and callsigns.
    picks = []
    for pi, (pa, pb) in enumerate(flightpairs):
        for p in (pa, pb):
            p["pair"] = pi + 1
            picks.append(p)
    for idx, p in enumerate(picks):
        p["callsign"] = f"{AIRLINES[idx % len(AIRLINES)]}{100 + idx}"

    base_cross = max(p["_delta"] for p in picks) + 600.0  # keep all EOBTs positive
    for p in picks:
        cross_t = base_cross + (p["pair"] - 1) * args.gap
        p["eobt"] = origin + timedelta(seconds=cross_t - p["_delta"])
        p["samples"] = sample_points(
            p["route_pts"], p["eobt"], RFL * 100.0, p["dep_elev"], p["des_elev"]
        )

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    total = len(picks)

    # ---- importable CSV (one "FLIGHT n of N" block per flight) ----
    blocks = []
    for i, p in enumerate(picks, start=1):
        key = f"{p['callsign']}_{p['adep']}_{p['ades']}_{p['eobt'].strftime('%Y-%m-%d %H:%M')}"
        banner = "=" * 64 + f"\nFLIGHT {i} of {total}  -  {key}\n" + "=" * 64 + "\n\n"
        blocks.append(
            banner
            + csv_block(
                p["callsign"], p["actype"], p["adep"], p["ades"],
                p["rfl"], p["route_str"], p["eobt"], p["samples"],
                sid=p["sid"], star=p["star"], approach=p["approach"],
                dep_rwy=p["dep_rwy"], arr_rwy=p["arr_rwy"],
            )
        )
    csv_path = OUT_DIR / "conflict_test_10_flights.csv"
    csv_path.write_text("\n\n\n".join(blocks) + "\n", encoding="utf-8")

    # ---- GeoJSON (route line + sampled points) ----
    features = []
    for p in picks:
        key = f"{p['callsign']}_{p['adep']}_{p['ades']}"
        features.append({
            "type": "Feature",
            "properties": {
                "feature_type": "route", "flight_key": key, "route": p["route_str"],
                "callsign": p["callsign"], "aircraft_type": p["actype"],
                "adep": p["adep"], "ades": p["ades"], "rfl": p["rfl"],
                "sid": p["sid"], "star": p["star"], "approach": p["approach"],
                "dep_rwy": p["dep_rwy"], "arr_rwy": p["arr_rwy"],
                "eobt": p["eobt"].isoformat(),
                "idents": [pt[0] for pt in p["route_pts"]],
            },
            "geometry": {"type": "LineString", "coordinates": [[pt[2], pt[1]] for pt in p["route_pts"]]},
        })
        for s in p["samples"]:
            features.append({
                "type": "Feature",
                "properties": {
                    "flight_key": key, "callsign": p["callsign"], "aircraft_type": p["actype"],
                    "adep": p["adep"], "ades": p["ades"],
                    "epoch_ts": s["ts"].strftime("%Y-%m-%d %H:%M:%S+00:00"),
                    "altitude_ft": round(s["alt_ft"], 1), "tas_kt": None,
                    "gs_kt": float(s["gs"]), "track_deg": s["trk"], "phase": s["phase"],
                },
                "geometry": {"type": "Point", "coordinates": [round(s["lon"], 6), round(s["lat"], 6), round(s["alt_ft"] * 0.3048, 1)]},
            })
    geojson_path = OUT_DIR / "conflict_test_10_flights.geojson"
    geojson_path.write_text(json.dumps({"type": "FeatureCollection", "features": features}), encoding="utf-8")

    # ---- self-check: regenerate with the FINAL EOBTs and measure separation ----
    import bisect

    def _min_sep(A, B):
        tb = [x[0] for x in B]
        best = (9e9, None)
        for t, la, lo, al in A:
            if not tb or t < tb[0] or t > tb[-1]:
                continue
            k = min(bisect.bisect_left(tb, t), len(B) - 1)
            _, lb, lo2, al2 = B[k]
            if al is None or al2 is None:
                continue
            dlat = (la - lb) * 60.0
            dlon = (lo - lo2) * 60.0 * math.cos(math.radians((la + lb) / 2))
            dh = math.hypot(dlat, dlon)
            if dh < best[0]:
                best = (dh, abs(al - al2))
        return best

    final_traj = {p["callsign"]: _engine_traj(client, p, p["eobt"]) for p in picks}

    npairs = len(flightpairs)
    print(f"Wrote {total} RNAV flights in {npairs} RESOLVABLE pairs at FL{RFL} (AIP only, all SID+STAR+APP)")
    ok = 0
    for pi in range(npairs):
        a, b = [p for p in picks if p["pair"] == pi + 1]
        dh, dv = _min_sep(final_traj[a["callsign"]], final_traj[b["callsign"]])
        conflict = dh < 5.0 and dv is not None and dv < 1000.0
        ok += conflict
        tag = "CONFLICT" if conflict else ("near" if dh < 8 else "CLEAR")
        kind = "overtake" if a["kind"] == "overtake" else f"cross {a['cross_angle']:.0f}deg"
        print(f"  Pair {pi+1} [{kind}]: {a['callsign']} {a['adep']}->{a['ades']}  X  {b['callsign']} {b['adep']}->{b['ades']}"
              f"   @ {a['cross_fix']}   minH={dh:.1f}NM dV={0 if dv is None else dv:.0f}ft [{tag}]")
        print(f"        {a['callsign']} {a['actype']}: {a['sid']}/{a['star']}/{a['approach']}  altAtFix~FL{a['_alt_at_fix']/100:.0f}  {a['route_str'][:38]}")
        print(f"        {b['callsign']} {b['actype']}: {b['sid']}/{b['star']}/{b['approach']}  altAtFix~FL{b['_alt_at_fix']/100:.0f}  {b['route_str'][:38]}")
    print(f"Self-check: {ok}/{npairs} pairs produce a real 3D conflict (<5NM & <1000ft)")
    print(f"CSV:     {csv_path}")
    print(f"GeoJSON: {geojson_path}")


if __name__ == "__main__":
    main()
