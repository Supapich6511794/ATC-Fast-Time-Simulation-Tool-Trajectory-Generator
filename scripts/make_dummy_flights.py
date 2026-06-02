"""Generate dummy CSV + GeoJSON in the website's own export format.

Produces 100 flights, each carrying 2-3 alternate routes (R1/R2/R3), so the
files round-trip through the web importer (web/lib/flightFile.ts):

  * dummy_data/dummy_100_flights.csv      — the combined ATC trajectory CSV
    (stacked "FLIGHT n of N" blocks; importer splits on ^ROUTE: and folds
    same-flight blocks into one multi-route plan).
  * dummy_data/dummy_100_flights.geojson  — one FeatureCollection; per route a
    "route" LineString feature + POINT Z sample features tagged by flight_key.

Routes are built from the **real CAAT eAIP navdata** (web/public/data/aip_VT.json):
each leg runs `<entry fix> <AIRWAY> <exit fix>` along a published ATS route, so
the Item-15 strings actually resolve when the web app calls /api/generate. The
sampled trajectory follows that airway polyline with a trapezoidal altitude
profile — cosmetic only, since the app regenerates the 4D path on import.

Run:  python scripts/make_dummy_flights.py
"""

from __future__ import annotations

import json
import math
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path

SEED = 20260602
N_FLIGHTS = 100
SAMPLES_PER_ROUTE = 16  # points written per route table

OUT_DIR = Path(__file__).resolve().parent.parent / "dummy_data"

# Real CAAT eAIP navdata (significant points + ATS airways + aerodromes),
# produced per AIRAC by scripts/ingest_aip.py. Routes are drawn from this so
# the Item-15 strings resolve when the web app calls /api/generate.
AIP_PATH = (
    Path(__file__).resolve().parent.parent / "web" / "public" / "data" / "aip_VT.json"
)


def _load_aip() -> tuple[dict, dict, dict]:
    data = json.loads(AIP_PATH.read_text(encoding="utf-8"))
    waypoints = {
        ident: (float(w["lat"]), float(w["lon"]))
        for ident, w in data["waypoints"].items()
    }
    airways = {desig: list(seq) for desig, seq in data["airways"].items()}
    airports = data.get("airports", {})
    return waypoints, airways, airports


WAYPOINTS, AIRWAYS, AIP_AIRPORTS = _load_aip()

# Curated Thai aerodromes with scheduled service; coordinates and field
# elevations are pulled straight from the AIP so they match the resolver.
AIRPORT_CODES = [
    "VTBS", "VTBD",          # Bangkok Suvarnabhumi / Don Mueang
    "VTCC", "VTCT",          # Chiang Mai / Chiang Rai
    "VTUU", "VTUD", "VTUK",  # Ubon / Udon Thani / Khon Kaen
    "VTSP", "VTSM", "VTSG",  # Phuket / Surat Thani / Krabi
    "VTSS", "VTSB", "VTSF",  # Hat Yai / Sukhothai-south / Nakhon Si Thammarat
    "VTSC", "VTPP",          # Narathiwat / Phitsanulok
]
AIRPORTS: dict[str, tuple[float, float, int]] = {}
for _icao in AIRPORT_CODES:
    _a = AIP_AIRPORTS.get(_icao)
    if _a and "lat" in _a and "lon" in _a:
        AIRPORTS[_icao] = (
            float(_a["lat"]), float(_a["lon"]),
            int(round(float(_a.get("elev_ft", 0)))),
        )
if len(AIRPORTS) < 2:
    raise SystemExit(
        f"Need >=2 Thai aerodromes from {AIP_PATH.name}; got {sorted(AIRPORTS)}"
    )

ACTYPES = ["B738", "A320", "A321", "A333", "A359", "B77W", "B789", "B763"]
AIRLINES = ["THA", "AIQ", "TGW", "BKP", "DMK", "SEH", "NOK", "THD", "TVJ", "PGY"]


def _dist2(a, b):
    """Squared lat/lon distance (deg^2) — fine for ranking inside one FIR."""
    return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2


def bearing(lat1, lon1, lat2, lon2):
    """Initial great-circle bearing (deg, 0-359)."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return int(round(math.degrees(math.atan2(x, y)))) % 360


def alt_speed(f, rfl_ft, dep_elev, des_elev):
    """Trapezoidal altitude + a phase-dependent ground speed for fraction f."""
    if f < 0.2:  # climb
        return dep_elev + (rfl_ft - dep_elev) * (f / 0.2), 280, "climb"
    if f > 0.8:  # descent
        return des_elev + (rfl_ft - des_elev) * ((1 - f) / 0.2), 270, "descent"
    return rfl_ft, 460, "cruise"  # cruise


def nearest_fix(ll):
    """Ident of the AIP waypoint closest to a lat/lon — used to anchor the
    route to the terminal fix off each aerodrome (e.g. PUT off VTSP)."""
    return min(WAYPOINTS, key=lambda k: _dist2(WAYPOINTS[k], ll))


def airway_options(dep_ll, arr_ll, top_k):
    """Rank AIP airways by how well an (entry, exit) fix pair brackets the
    terminal fixes off ADEP/ADES. Returns up to top_k (desig, entry, exit)
    tuples, best first.

    For each airway we take the on-airway fix nearest the departure terminal
    fix as the entry and the nearest (distinct) fix to the arrival terminal
    fix as the exit, then score by the summed distance so the leg heads from
    origin toward destination.
    """
    scored = []
    for desig, seq in AIRWAYS.items():
        fixes = [f for f in seq if f in WAYPOINTS]
        if len(fixes) < 2:
            continue
        entry = min(fixes, key=lambda f: _dist2(WAYPOINTS[f], dep_ll))
        exit_ = min(
            (f for f in fixes if f != entry),
            key=lambda f: _dist2(WAYPOINTS[f], arr_ll),
        )
        score = _dist2(WAYPOINTS[entry], dep_ll) + _dist2(WAYPOINTS[exit_], arr_ll)
        scored.append((score, desig, entry, exit_))
    scored.sort(key=lambda t: t[0])
    return [(d, e, x) for _, d, e, x in scored[:top_k]]


def build_airway_route(adep, ades, dep_fix, arr_fix, desig, entry, exit_):
    """(route_str, route_pts) for one airway leg, anchored to terminal fixes.

    The route runs `dep_fix [DCT entry] <AIRWAY> exit [DCT arr_fix]`, where
    dep_fix/arr_fix are the AIP fixes nearest ADEP/ADES. Anchoring the END
    at arr_fix keeps the route's last fix within ~30 NM of the destination,
    so the server no longer warns that the route "does not reach" ADES and
    appends a long direct leg. route_pts is the full drawn polyline (ADEP ->
    terminal/airway fixes -> ADES) for the map line and cosmetic samples.
    """
    fixes = [f for f in AIRWAYS[desig] if f in WAYPOINTS]
    ia, ib = fixes.index(entry), fixes.index(exit_)
    leg = fixes[ia:ib + 1] if ia <= ib else list(reversed(fixes[ib:ia + 1]))

    # Item-15 tokens: only emit a DCT anchor when the terminal fix isn't
    # already the airway endpoint (avoids zero-length DCT hops). The
    # `entry <AIRWAY> exit` triple is what the server's airway expander
    # splices the intermediate fixes into.
    tokens: list[str] = []
    if dep_fix != entry:
        tokens += [dep_fix, "DCT"]
    tokens += [entry, desig, exit_]
    if arr_fix != exit_:
        tokens += ["DCT", arr_fix]
    route_str = " ".join(tokens)

    # Drawn polyline: ADEP -> dep_fix -> airway leg -> arr_fix -> ADES, with
    # consecutive duplicate idents collapsed.
    chain: list[str] = []
    for f in [dep_fix, *leg, arr_fix]:
        if not chain or chain[-1] != f:
            chain.append(f)
    la1, lo1, _ = AIRPORTS[adep]
    la2, lo2, _ = AIRPORTS[ades]
    route_pts = (
        [(adep, la1, lo1)]
        + [(f, WAYPOINTS[f][0], WAYPOINTS[f][1]) for f in chain]
        + [(ades, la2, lo2)]
    )
    return route_str, route_pts


def _point_at(coords, seglen, target):
    """Linear-interpolate a point + a small look-ahead (for bearing) at
    arc-length ``target`` along the polyline ``coords``."""
    acc = 0.0
    for i in range(len(coords) - 1):
        if seglen[i] <= 0:
            continue
        if acc + seglen[i] >= target or i == len(coords) - 2:
            t = min(1.0, max(0.0, (target - acc) / seglen[i]))
            (a_lat, a_lon), (b_lat, b_lon) = coords[i], coords[i + 1]
            t2 = min(1.0, t + 0.01)
            return (
                a_lat + (b_lat - a_lat) * t, a_lon + (b_lon - a_lon) * t,
                a_lat + (b_lat - a_lat) * t2, a_lon + (b_lon - a_lon) * t2,
            )
        acc += seglen[i]
    lat, lon = coords[-1]
    return lat, lon, lat, lon


def sample_points(route_pts, eobt, rfl_ft, dep_elev, des_elev):
    """Sampled trajectory points walking the route's waypoint polyline."""
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
            "ts": eobt + timedelta(seconds=k * 360.0),  # ~6 min; cosmetic
        })
    return out


def csv_block(flight_key, callsign, actype, adep, ades, rfl, route_str,
              eobt, samples):
    """One write_csv-style block for a single route."""
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
    rng = random.Random(SEED)
    base_eobt = datetime(2026, 6, 2, 0, 0, tzinfo=timezone.utc)
    airport_codes = list(AIRPORTS)

    flights = []  # each: dict with meta + list of route dicts
    for n in range(N_FLIGHTS):
        callsign = f"{rng.choice(AIRLINES)}{rng.randint(100, 999)}"
        actype = rng.choice(ACTYPES)
        adep, ades = rng.sample(airport_codes, 2)
        rfl = rng.choice([280, 300, 320, 340, 360, 380, 400])
        eobt = base_eobt + timedelta(minutes=rng.randint(0, 1439))
        stamp = eobt.strftime("%Y%m%dT%H%MZ")
        n_routes = rng.choice([2, 2, 3])  # 2+ alternate routes per flight
        # Anchor the route to the terminal fixes off each aerodrome so it
        # starts/ends near the airports (no "does not reach ADES" warning).
        dep_fix = nearest_fix(AIRPORTS[adep][:2])
        arr_fix = nearest_fix(AIRPORTS[ades][:2])
        # Pick distinct real airways near the pair so the alternates visibly
        # differ; fall back to reuse only if the AIP is tiny.
        options = airway_options(WAYPOINTS[dep_fix], WAYPOINTS[arr_fix], top_k=8)
        pool = options[: max(6, n_routes)] or options
        if len(pool) >= n_routes:
            sel = rng.sample(pool, n_routes)
        else:
            sel = [pool[i % len(pool)] for i in range(n_routes)]
        routes = []
        for r, (desig, entry, exit_) in enumerate(sel, start=1):
            route_str, route_pts = build_airway_route(
                adep, ades, dep_fix, arr_fix, desig, entry, exit_
            )
            samples = sample_points(
                route_pts, eobt, rfl * 100.0,
                AIRPORTS[adep][2], AIRPORTS[ades][2],
            )
            routes.append({
                "flight_key": f"{callsign}_{stamp}_R{r}",
                "route_str": route_str,
                "route_pts": route_pts,
                "samples": samples,
            })
        flights.append({
            "callsign": callsign, "actype": actype, "adep": adep,
            "ades": ades, "rfl": rfl, "eobt": eobt, "routes": routes,
        })

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # ---- combined CSV (stacked FLIGHT n of N blocks) ----
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
        body = csv_block(
            rt["flight_key"], fl["callsign"], fl["actype"], fl["adep"],
            fl["ades"], fl["rfl"], rt["route_str"], fl["eobt"], rt["samples"],
        )
        blocks.append(banner + body)
    csv_path = OUT_DIR / "dummy_100_flights.csv"
    csv_path.write_text("\n\n\n".join(blocks) + "\n", encoding="utf-8")

    # ---- combined GeoJSON (route LineString + POINT Z per route) ----
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
                    "rfl": fl["rfl"],
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

    print(f"Flights: {len(flights)}  routes: {total}  features: {len(features)}")
    print(f"CSV:     {csv_path}")
    print(f"GeoJSON: {geojson_path}")


if __name__ == "__main__":
    main()
