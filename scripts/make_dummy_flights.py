"""Generate a 100-flight dummy file in the website's own export format.

Every flight's FPL route is a **published AIP filed route** drawn from
web/public/data/aip_routes_VT.json (ENR 1.10), so the Item-15 strings are
exactly what the AIP prescribes for each city pair and resolve when the web
app calls /api/generate. There are far more than 100 filed routes, so all
100 flights come from the AIP and no manual/synthetic routes are needed
(the script falls back to manual only if the AIP ever had < N routes).

Outputs (round-trip through web/lib/flightFile.ts):
  * dummy_data/dummy_100_flights.csv      — stacked "FLIGHT n of N" ATC
    trajectory blocks (importer splits on ^ROUTE:).
  * dummy_data/dummy_100_flights.geojson  — one FeatureCollection; per flight
    a "route" LineString + POINT Z samples tagged by flight_key.

The sampled trajectory walks the route's airway-expanded waypoint polyline
with a trapezoidal altitude profile — cosmetic only, since the app
regenerates the real 4D path on import. RFL respects the AIP rule that
Non-RNAV routes file FL250 or below.

Run:  python scripts/make_dummy_flights.py
      python scripts/make_dummy_flights.py --count 50
"""

from __future__ import annotations

import argparse
import json
import math
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

N_FLIGHTS = 100
SAMPLES_PER_ROUTE = 16  # points written per route table (cosmetic)

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
from trajectory_sim.validation import cab_cruising_level_capped  # noqa: E402

OUT_DIR = _ROOT / "dummy_data"
AIP_PATH = _ROOT / "web" / "public" / "data" / "aip_VT.json"
ROUTES_PATH = _ROOT / "web" / "public" / "data" / "aip_routes_VT.json"


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

_SID_LINE = _ROOT / "web" / "public" / "data" / "sid" / "sid_line_thai.geojson"
_STAR_LINE = _ROOT / "web" / "public" / "data" / "star" / "star_line.geojson"


SIDS, SID_RWY = load_proc_runways(_SID_LINE)
STARS, STAR_RWY = load_proc_runways(_STAR_LINE)

# Share the engine's elevation tables (runway-threshold, AIP field fallback)
# and expand ARINC "both parallels" STAR runways (RWxxB) to a concrete side.
THR_ELEV = load_thr_elevs()
register_runway_elevations(THR_ELEV)
register_field_elevations({icao: elev for icao, (_la, _lo, elev) in AIRPORTS.items()})
_expand_runway = make_expand_runway(THR_ELEV)


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
              sid="", star="", dep_rwy="", arr_rwy=""):
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
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=N_FLIGHTS)
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

    n = min(args.count, len(usable))
    step = max(1, len(usable) // n)
    picks = usable[::step][:n]
    if len(picks) < n:  # top up if striding fell short
        chosen = {id(p) for p in picks}
        picks += [u for u in usable if id(u) not in chosen][: n - len(picks)]

    manual_used = max(0, args.count - len(usable))  # AIP shortfall (→ 0 here)
    base_eobt = datetime(2026, 6, 11, 0, 0, tzinfo=timezone.utc)

    # Group usable routes by pair so one flight can carry several routes.
    by_pair: dict[tuple[str, str], list[tuple[dict, list]]] = {}
    for r, coords in usable:
        by_pair.setdefault((r["adep"], r["ades"]), []).append((r, coords))

    flights = []
    for i, (r, coords) in enumerate(picks):
        adep, ades = r["adep"], r["ades"]
        callsign = f"{AIRLINES[i % len(AIRLINES)]}{100 + i:03d}"
        actype = ACTYPES[i % len(ACTYPES)]
        eobt = base_eobt + timedelta(minutes=i * 3)
        stamp = eobt.strftime("%Y%m%dT%H%MZ")
        # SID/STAR for the whole flight, from the picked route's terminal fixes.
        first0, last0 = _route_fixes(r["route"])
        sid = _pick_proc(SIDS.get(adep, []), first0)
        star = _pick_proc(STARS.get(ades, []), last0)
        la1, lo1, _e1 = AIRPORTS[adep]
        la2, lo2, _e2 = AIRPORTS[ades]
        # Concrete runway from the chosen SID/STAR (expand RWxxB -> a side),
        # and the runway-threshold elevations for the cosmetic profile.
        dep_rwy = _expand_runway(adep, SID_RWY.get((adep, sid), "")) if sid else ""
        arr_rwy = _expand_runway(ades, STAR_RWY.get((ades, star), "")) if star else ""
        dep_elev = runway_threshold_elevation_ft(adep, dep_rwy)
        des_elev = runway_threshold_elevation_ft(ades, arr_rwy)
        # Multi-route: the picked route + the pair's other published routes
        # (up to 3 total, deduped) so the flight has more than one route.
        group = [(r, coords)] + [
            g for g in by_pair.get((adep, ades), []) if g[0]["route"] != r["route"]
        ]
        seen_rt: set[str] = set()
        routes_out = []
        for rr, cc in group:
            if rr["route"] in seen_rt:
                continue
            seen_rt.add(rr["route"])
            ri = len(routes_out) + 1
            # Cap the filed level to what this airframe can reach under the
            # Thai APM data (e.g. B738 tops at FL380) so cruise == RFL.
            rfl = cab_cruising_level_capped(
                bearing(la1, lo1, la2, lo2),
                _RFL_RNAV[i % len(_RFL_RNAV)] if rr.get("rnav") else _RFL_NON[i % len(_RFL_NON)],
                int(reachable_ceiling_ft(actype) // 100),
            )
            route_pts = (
                [(adep, la1, lo1)]
                + [(f, la, lo) for (f, la, lo) in cc]
                + [(ades, la2, lo2)]
            )
            routes_out.append({
                "flight_key": f"{callsign}_{stamp}_R{ri}",
                "route_str": rr["route"],
                "rfl": rfl,
                "route_pts": route_pts,
                "samples": sample_points(route_pts, eobt, rfl * 100.0, dep_elev, des_elev),
            })
            if len(routes_out) >= 3:
                break
        flights.append({
            "callsign": callsign, "actype": actype, "adep": adep, "ades": ades,
            "eobt": eobt, "sid": sid, "star": star,
            "dep_rwy": dep_rwy, "arr_rwy": arr_rwy, "routes": routes_out,
        })

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # ---- combined CSV (one block per route; multi-route flights repeat
    # the callsign across their R1/R2/R3 blocks, which the importer folds). --
    all_routes = [(fl, rt) for fl in flights for rt in fl["routes"]]
    total = len(all_routes)
    blocks = []
    for i, (fl, rt) in enumerate(all_routes, start=1):
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
                sid=fl["sid"], star=fl["star"],
                dep_rwy=fl["dep_rwy"], arr_rwy=fl["arr_rwy"],
            )
        )
    csv_path = OUT_DIR / "dummy_100_flights.csv"
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
    geojson_path = OUT_DIR / "dummy_100_flights.geojson"
    geojson_path.write_text(
        json.dumps({"type": "FeatureCollection", "features": features}),
        encoding="utf-8",
    )

    multi = sum(1 for fl in flights if len(fl["routes"]) > 1)
    proc = sum(1 for fl in flights if fl["sid"] or fl["star"])
    print(f"Flights: {len(flights)} | routes: {total} | "
          f"multi-route: {multi} | with SID/STAR: {proc}")
    print(f"CSV:     {csv_path}")
    print(f"GeoJSON: {geojson_path}")


if __name__ == "__main__":
    main()
