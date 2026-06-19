"""Generate a *SID/STAR-expanded* dummy file in the website's own export format.

Same export format as scripts/make_dummy_flights.py, expanded to model
realistic FPL variation:

  * **1 FPL = 1 route** — each generated block carries exactly one route.
  * Every filed AIP route is expanded into **one flight per SID×STAR
    combination** available at its ADEP/ADES. e.g. VTBD→VTCC "OLVUK Y26 MARNI"
    has 4 OLVU* SIDs × 2 MARN* STARs = 8 variants (plus the pair's other
    filed route → ~10 FPL / 10 routes for the city pair).
  * This is done for **all RNAV and Non-RNAV** filed routes.

Identity model (the point of this file):
  * **ACID = the real callsign** (e.g. THA100), shared by all SID/STAR
    variants of one filed route — they are the same real flight flown
    different ways. Written as `ACID:` in the CSV header, the `Callsign`
    data column, and the `callsign`/`acid` GeoJSON properties (so the
    importer round-trips the real callsign).
  * **A separate unique simulation ID per variant** — the `flight_key`
    (`<ACID>_<EOBT stamp>_<SID>_<STAR>`), also surfaced as `SIMID:` in the
    CSV header and `sim_id` in GeoJSON.
  * **Each variant gets a distinct EOBT (UTC).** This is what keeps the
    variants from collapsing: the importer folds blocks that share
    (callsign, EOBT, ADEP, ADES, ACTYPE, RFL) into a single multi-route
    flight, so identical EOBTs would merge the 8 variants into one (and
    crash the multi-route generate). A unique EOBT per variant keeps each
    an independent 1-FPL/1-route flight.

The sampled trajectory walks the route's airway-expanded waypoint polyline
with a trapezoidal altitude profile — cosmetic only, since the app
regenerates the real 4D path on import. RFL respects the AIP rule that
Non-RNAV routes file FL250 or below.

Run:  python scripts/make_dummySIDSTAR_flights.py
"""

from __future__ import annotations

import json
import math
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

SAMPLES_PER_ROUTE = 16   # points written per route table (cosmetic)
EOBT_GAP_MIN = 1         # minutes between consecutive variants (unique EOBTs)

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

_SID_LINE = _ROOT / "web" / "public" / "data" / "sid" / "sid_line_thai.geojson"
_STAR_LINE = _ROOT / "web" / "public" / "data" / "star" / "star_line.geojson"


def _load_procs(path: Path) -> dict[str, list[str]]:
    """airport ICAO -> sorted procedure names (SID or STAR)."""
    out: dict[str, set[str]] = {}
    try:
        gj = json.loads(path.read_text(encoding="utf-8"))
    except OSError:
        return {}
    for f in gj.get("features", []):
        p = f.get("properties") or {}
        a, pr = p.get("airport_identifier"), p.get("procedure_identifier")
        if a and pr:
            out.setdefault(a, set()).add(pr)
    return {k: sorted(v) for k, v in out.items()}


SIDS = _load_procs(_SID_LINE)
STARS = _load_procs(_STAR_LINE)


def _all_procs(opts: list[str], fix: str | None) -> list[str]:
    """ALL procedures whose alphabetic prefix matches the connecting fix
    (Thai naming: OLVUK → OLVU1B, OLVU1D, OLVU3A, OLVU3C). Empty list if the
    fix is unknown or nothing connects (→ a single no-procedure variant)."""
    if not fix:
        return []
    hits = []
    for n in opts:
        m = re.match(r"^[A-Z]+", n)
        if m and fix.startswith(m.group(0)):
            hits.append(n)
    return hits


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


def csv_block(acid, sim_id, actype, adep, ades, rfl, route_str, eobt, samples,
              sid="", star=""):
    lines = [
        f"ROUTE: {route_str}",
        f"DEP: {adep}",
        f"DEST: {ades}",
        f"ACTYPE: {actype}",
        f"FL: F{rfl}",
        f"ATD: {eobt.strftime('%Y-%m-%d %H:%M:%S')}",
        f"ACID: {acid}",
        f"SIMID: {sim_id}",
    ]
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
            f"{epoch},{iso},{acid},{s['lat']:.6f},{s['lon']:.6f},"
            f"{int(round(s['alt_ft']))},{s['gs']},{s['trk']}"
        )
    return "\n".join(lines)


def main() -> None:
    all_routes = json.loads(ROUTES_PATH.read_text(encoding="utf-8"))["routes"]

    base_eobt = datetime(2026, 6, 11, 0, 0, tzinfo=timezone.utc)
    flights = []   # one entry per SID/STAR variant (1 FPL = 1 route)
    variant_i = 0  # global counter → unique, staggered EOBT per variant

    for ri, r in enumerate(all_routes):
        adep, ades = r["adep"], r["ades"]
        if adep not in AIRPORTS or ades not in AIRPORTS:
            continue
        if "CTRI" in r["route"].split():  # AIP "CTR I" typo — no coords
            continue
        coords = resolve_route_coords(r["route"])
        if len(coords) < 1:
            continue

        # ACID: one real callsign per filed route, shared by its variants.
        acid = f"{AIRLINES[ri % len(AIRLINES)]}{100 + ri:03d}"
        actype = ACTYPES[ri % len(ACTYPES)]
        la1, lo1, e1 = AIRPORTS[adep]
        la2, lo2, e2 = AIRPORTS[ades]
        rfl = _RFL_RNAV[ri % len(_RFL_RNAV)] if r.get("rnav") else _RFL_NON[ri % len(_RFL_NON)]
        route_pts = (
            [(adep, la1, lo1)]
            + [(f, la, lo) for (f, la, lo) in coords]
            + [(ades, la2, lo2)]
        )

        # SID×STAR product from the route's terminal fixes ([""] = none).
        first0, last0 = _route_fixes(r["route"])
        sid_opts = _all_procs(SIDS.get(adep, []), first0) or [""]
        star_opts = _all_procs(STARS.get(ades, []), last0) or [""]

        for sid in sid_opts:
            for star in star_opts:
                eobt = base_eobt + timedelta(minutes=variant_i * EOBT_GAP_MIN)
                variant_i += 1
                stamp = eobt.strftime("%Y%m%dT%H%MZ")
                sim_id = f"{acid}_{stamp}_{sid or 'NOSID'}_{star or 'NOSTAR'}"
                flights.append({
                    "acid": acid, "sim_id": sim_id, "actype": actype,
                    "adep": adep, "ades": ades, "eobt": eobt,
                    "sid": sid, "star": star, "rfl": rfl,
                    "route_str": r["route"], "route_pts": route_pts,
                    "samples": sample_points(route_pts, eobt, rfl * 100.0, e1, e2),
                })

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # ---- combined CSV (one block per variant) ----
    total = len(flights)
    blocks = []
    for i, fl in enumerate(flights, start=1):
        banner = (
            "=" * 64
            + f"\nFLIGHT {i} of {total}  -  {fl['sim_id']}\n"
            + "=" * 64
            + "\n\n"
        )
        blocks.append(
            banner
            + csv_block(
                fl["acid"], fl["sim_id"], fl["actype"], fl["adep"], fl["ades"],
                fl["rfl"], fl["route_str"], fl["eobt"], fl["samples"],
                sid=fl["sid"], star=fl["star"],
            )
        )
    csv_path = OUT_DIR / "dummySIDSTAR_flights.csv"
    csv_path.write_text("\n\n\n".join(blocks) + "\n", encoding="utf-8")

    # ---- combined GeoJSON ----
    features = []
    for fl in flights:
        features.append({
            "type": "Feature",
            "properties": {
                "feature_type": "route",
                "flight_key": fl["sim_id"],
                "sim_id": fl["sim_id"],
                "route": fl["route_str"],
                "callsign": fl["acid"],
                "acid": fl["acid"],
                "aircraft_type": fl["actype"],
                "adep": fl["adep"],
                "ades": fl["ades"],
                "rfl": fl["rfl"],
                "sid": fl["sid"],
                "star": fl["star"],
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
                    "flight_key": fl["sim_id"],
                    "sim_id": fl["sim_id"],
                    "callsign": fl["acid"],
                    "acid": fl["acid"],
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
    geojson_path = OUT_DIR / "dummySIDSTAR_flights.geojson"
    geojson_path.write_text(
        json.dumps({"type": "FeatureCollection", "features": features}),
        encoding="utf-8",
    )

    fpls = len({fl["acid"] for fl in flights})
    with_proc = sum(1 for fl in flights if fl["sid"] or fl["star"])
    print(f"Filed routes (ACIDs): {fpls} | SID/STAR variants: {total} "
          f"(1 FPL = 1 route) | with SID and/or STAR: {with_proc}")
    print(f"EOBT span: {flights[0]['eobt']:%Y-%m-%d %H:%M} .. "
          f"{flights[-1]['eobt']:%Y-%m-%d %H:%M} UTC (unique per variant)")
    print(f"CSV:     {csv_path}")
    print(f"GeoJSON: {geojson_path}")


if __name__ == "__main__":
    main()
