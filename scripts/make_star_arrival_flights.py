"""Generate a dummy flight file: 10 RNAV flights that ALL land at VTBS, timed to
converge — an arrival-rush / STAR-merge test case (the "Open STAR" scenario).

Unlike ``conflict_test_10_flights`` (deliberately RESOLVABLE enroute crossings +
overtakes), THIS file is the arrival-merge case on purpose:

  * All 10 flights are real AIP RNAV routes into ONE hub (VTBS) from different
    origins, each with a full SID + STAR + PBN approach.
  * The AIP STARs naturally FUNNEL the traffic through shared merge fixes
    (e.g. the northern arrivals join at BLAFF → NORTA via NORT1C; the southern
    ones at LEBIM via LEBI1C) and every flight lands the SAME runway.
  * Departure times are CALIBRATED against the real engine so every flight
    reaches VTBS inside a tight arrival window — the streams merge and sequence
    too close, so separation is lost at the merge fixes and on final.

This exercises Conflict Detection when many aircraft land VTBS at once. These
arrival-merge conflicts are typically NOT clearable by a simple vector/level/
speed (both aircraft must reach the same runway) — that is the point of the test
(compare with the resolvable conflict_test file).

Run:  PYTHONPATH=api python scripts/make_star_arrival_flights.py [--hub VTBS] [--n 10]
"""

from __future__ import annotations

import argparse
import importlib
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))
sys.path.insert(0, str(_ROOT / "scripts"))

# Reuse the conflict-file generator's AIP resolver, procedure picker, engine
# calibration and writers so the output is byte-compatible with the importer.
mcf = importlib.import_module("make_conflict_flights")
resolve_route_coords = mcf.resolve_route_coords
route_seconds = mcf.route_seconds
sample_points = mcf.sample_points
csv_block = mcf.csv_block
WAYPOINTS = mcf.WAYPOINTS
AIRPORTS = mcf.AIRPORTS
_procs = mcf._procs
_thr_elev = mcf._thr_elev
_engine_traj = mcf._engine_traj
RFL = mcf.RFL
ACTYPES = mcf.ACTYPES
AIRLINES = mcf.AIRLINES
ROUTES_PATH = mcf.ROUTES_PATH
OUT_DIR = mcf.OUT_DIR


def _pick_arrivals(hub: str, n: int):
    """N real AIP RNAV routes arriving `hub` from DISTINCT origins, each with a
    full SID + STAR + approach. Interleaved across STAR groups so BOTH merge
    streams (e.g. NORTA and LEBIM) get traffic."""
    routes = json.loads(ROUTES_PATH.read_text(encoding="utf-8"))["routes"]
    by_star: dict[str, list] = {}
    seen_adep: set[str] = set()
    for r in routes:
        if not r.get("rnav"):
            continue  # RNAV only
        adep, ades = r.get("adep"), r.get("ades")
        if ades != hub or adep not in AIRPORTS or hub not in AIRPORTS or adep == hub:
            continue
        if adep in seen_adep:
            continue
        coords = resolve_route_coords(r["route"])
        if len(coords) < 1:
            continue
        sid, star, dep_rwy, arr_rwy, approach = _procs(adep, hub, r["route"])
        if not (sid and star and approach):
            continue  # must carry SID + STAR + approach
        seen_adep.add(adep)
        la1, lo1, _ = AIRPORTS[adep]
        la2, lo2, _ = AIRPORTS[hub]
        by_star.setdefault(star, []).append({
            "adep": adep, "ades": hub, "route_str": r["route"],
            "sid": sid, "star": star, "dep_rwy": dep_rwy,
            "arr_rwy": arr_rwy, "approach": approach,
            "route_pts": [(adep, la1, lo1)]
            + [(f, la, lo) for f, la, lo in coords]
            + [(hub, la2, lo2)],
        })
    # Round-robin across STAR groups so each merge stream is exercised.
    groups = [g for g in by_star.values()]
    picked: list[dict] = []
    while len(picked) < n and any(groups):
        for g in groups:
            if g:
                picked.append(g.pop(0))
                if len(picked) >= n:
                    break
    return picked


def main() -> None:
    ap = argparse.ArgumentParser(description="Generate the VTBS arrival-rush (STAR merge) test file.")
    ap.add_argument("--hub", default="VTBS", help="arrival hub ICAO (default VTBS)")
    ap.add_argument("--n", type=int, default=10, help="number of flights (default 10)")
    ap.add_argument("--stagger", type=float, default=30.0, help="seconds between successive arrivals (default 30 — a tight rush)")
    args = ap.parse_args()

    picks = _pick_arrivals(args.hub, args.n)
    if len(picks) < 2:
        raise SystemExit(f"Only {len(picks)} usable RNAV arrivals into {args.hub}; need ≥2")

    for idx, p in enumerate(picks):
        p["callsign"] = f"{AIRLINES[idx % len(AIRLINES)]}{100 + idx}"
        p["actype"] = ACTYPES[idx % len(ACTYPES)]
        p["rfl"] = RFL
        p["dep_elev"] = _thr_elev(p["adep"], p["dep_rwy"])
        p["des_elev"] = _thr_elev(p["ades"], p["arr_rwy"])

    origin = datetime(2025, 12, 23, 0, 0, tzinfo=timezone.utc)

    # ---- Calibrate flight time against the REAL engine ----
    # Trajectory shape is EOBT-invariant, so each route's departure→touchdown
    # time is fixed; generate once to measure it, then set EOBTs so every flight
    # lands inside one tight arrival window (a converging rush).
    from fastapi.testclient import TestClient  # local import: engine only here
    from server import app  # noqa: E402
    client = TestClient(app)
    print(f"calibrating {len(picks)} arrivals into {args.hub} ...")
    for p in picks:
        traj = _engine_traj(client, p, origin)
        if not traj:
            raise SystemExit(f"engine failed for {p['callsign']} {p['adep']}->{p['ades']}")
        p["_flight_s"] = traj[-1][0] - traj[0][0]

    arrival_base = max(p["_flight_s"] for p in picks) + 600.0  # keep EOBTs positive
    for i, p in enumerate(picks):
        arrival = arrival_base + i * args.stagger  # tight, staggered arrivals
        p["eobt"] = origin + timedelta(seconds=arrival - p["_flight_s"])
        p["flight_s"] = route_seconds(p["route_pts"])
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
    csv_path = OUT_DIR / "star_arrival_10_flights.csv"
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
    geojson_path = OUT_DIR / "star_arrival_10_flights.geojson"
    geojson_path.write_text(json.dumps({"type": "FeatureCollection", "features": features}), encoding="utf-8")

    # ---- summary + self-check: how tight is the arrival rush? ----
    import bisect
    import math

    final = {p["callsign"]: _engine_traj(client, p, p["eobt"]) for p in picks}

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
            dh = math.hypot((la - lb) * 60.0, (lo - lo2) * 60.0 * math.cos(math.radians((la + lb) / 2)))
            if dh < best[0]:
                best = (dh, abs(al - al2))
        return best

    cs = list(final)
    losses = 0
    for a in range(len(cs)):
        for b in range(a + 1, len(cs)):
            dh, dv = _min_sep(final[cs[a]], final[cs[b]])
            if dh < 5.0 and dv is not None and dv < 1000.0:
                losses += 1

    stars: dict[str, list] = {}
    for p in picks:
        stars.setdefault(p["star"], []).append(p["callsign"])
    print(f"Wrote {total} RNAV arrivals into {args.hub} at FL{RFL} (AIP only, all SID+STAR+APP)")
    for p in picks:
        eta = (p["eobt"] + timedelta(seconds=p["_flight_s"])).strftime("%H:%M:%S")
        print(f"  {p['callsign']} {p['adep']}->{p['ades']} [{p['sid']}/{p['star']}/{p['approach']}] ETA {eta}  {p['route_str'][:40]}")
    print("STAR merge streams:")
    for star, names in stars.items():
        print(f"  STAR {star}: {', '.join(names)}")
    print(f"Arrival rush self-check: {losses} conflicting flight-pairs (<5NM & <1000ft)")
    print(f"CSV:     {csv_path}")
    print(f"GeoJSON: {geojson_path}")


if __name__ == "__main__":
    main()
