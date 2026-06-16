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
from datetime import datetime, timedelta, timezone
from pathlib import Path

N_FLIGHTS = 100
SAMPLES_PER_ROUTE = 16  # points written per route table (cosmetic)

_ROOT = Path(__file__).resolve().parent.parent
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


def csv_block(callsign, actype, adep, ades, rfl, route_str, eobt, samples):
    lines = [
        f"ROUTE: {route_str}",
        f"DEP: {adep}",
        f"DEST: {ades}",
        f"ACTYPE: {actype}",
        f"FL: F{rfl}",
        f"ATD: {eobt.strftime('%Y-%m-%d %H:%M:%S')}",
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

    flights = []
    for i, (r, coords) in enumerate(picks):
        callsign = f"{AIRLINES[i % len(AIRLINES)]}{100 + i:03d}"
        actype = ACTYPES[i % len(ACTYPES)]
        rfl = _RFL_RNAV[i % len(_RFL_RNAV)] if r.get("rnav") else _RFL_NON[i % len(_RFL_NON)]
        eobt = base_eobt + timedelta(minutes=i * 3)
        adep, ades = r["adep"], r["ades"]
        la1, lo1, e1 = AIRPORTS[adep]
        la2, lo2, e2 = AIRPORTS[ades]
        route_pts = (
            [(adep, la1, lo1)]
            + [(f, la, lo) for (f, la, lo) in coords]
            + [(ades, la2, lo2)]
        )
        samples = sample_points(route_pts, eobt, rfl * 100.0, e1, e2)
        flights.append({
            "callsign": callsign, "actype": actype, "adep": adep, "ades": ades,
            "rfl": rfl, "eobt": eobt, "route_str": r["route"],
            "flight_key": f"{callsign}_{eobt.strftime('%Y%m%dT%H%MZ')}",
            "route_pts": route_pts, "samples": samples,
        })

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # ---- combined CSV (stacked FLIGHT n of N blocks) ----
    total = len(flights)
    blocks = []
    for i, fl in enumerate(flights, start=1):
        banner = (
            "=" * 64
            + f"\nFLIGHT {i} of {total}  -  {fl['flight_key']}\n"
            + "=" * 64
            + "\n\n"
        )
        blocks.append(
            banner
            + csv_block(
                fl["callsign"], fl["actype"], fl["adep"], fl["ades"],
                fl["rfl"], fl["route_str"], fl["eobt"], fl["samples"],
            )
        )
    csv_path = OUT_DIR / "dummy_100_flights.csv"
    csv_path.write_text("\n\n\n".join(blocks) + "\n", encoding="utf-8")

    # ---- combined GeoJSON ----
    features = []
    for fl in flights:
        features.append({
            "type": "Feature",
            "properties": {
                "feature_type": "route",
                "flight_key": fl["flight_key"],
                "route": fl["route_str"],
                "callsign": fl["callsign"],
                "aircraft_type": fl["actype"],
                "adep": fl["adep"],
                "ades": fl["ades"],
                "rfl": fl["rfl"],
                "eobt": fl["eobt"].isoformat(),
                "idents": [p[0] for p in fl["route_pts"]],
            },
            "geometry": {
                "type": "LineString",
                "coordinates": [[p[2], p[1]] for p in fl["route_pts"]],
            },
        })
        for s in fl["samples"]:
            features.append({
                "type": "Feature",
                "properties": {
                    "flight_key": fl["flight_key"],
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

    print(f"Flights: {total} (AIP: {total - manual_used}, manual: {manual_used})")
    print(f"  usable AIP routes available: {len(usable)}")
    print(f"CSV:     {csv_path}")
    print(f"GeoJSON: {geojson_path}")


if __name__ == "__main__":
    main()
