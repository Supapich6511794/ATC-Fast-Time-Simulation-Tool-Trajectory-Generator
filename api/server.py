"""FastAPI server: run the real trajectory_sim Phase 1 pipeline for the web.

Endpoints
---------
GET  /api/health
POST /api/generate                  -> stats + route + points + download URLs
GET  /api/download/{flight_key}.{ext}  (ext = gpkg | csv | geojson)

Run (from the project root, with the venv active):
    uvicorn api.server:app --reload --port 8000

Everything numeric comes from `trajectory_sim` (pyproj.Geod / WGS-84) — no
geodesy is re-implemented here. GeoPackage export is the genuine one written
by `trajectory_sim.output.write_geopackage`.
"""

from __future__ import annotations

import os
import re
from functools import lru_cache
from pathlib import Path

import geopandas as gpd
import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from trajectory_sim.fpl import parse_eobt, parse_route
from trajectory_sim.geodesy import route_distance_nm
from trajectory_sim.navdata import load_route_csv
from trajectory_sim.output import (
    build_trajectory_gdf,
    write_csv,
    write_geopackage,
)

# Project root = parent of this `api/` package.
_ROOT = Path(__file__).resolve().parent.parent
_DATA = _ROOT / "web" / "public" / "data"
_CSV_PATH = _DATA / "VTPStoVTBS.csv"
_AIRWAY_GEOJSON = _DATA / "airway_waypoint.geojson"
_OUT_DIR = _ROOT / "api" / "_outputs"
_OUT_DIR.mkdir(parents=True, exist_ok=True)

# Approx airport reference coords (lat, lon), used only to orient an
# fpl/picked route to the requested ADEP (so swapping ADEP/ADES really
# reverses the written file and the animation).
_AIRPORT_LL = {"VTBS": (13.6811, 100.7475), "VTSP": (8.1132, 98.3169)}


def _sq_dist(a: tuple[float, float], b: tuple[float, float]) -> float:
    return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2

app = FastAPI(title="Flight Trajectory Generator API", version="1.0")

# Allowed browser origins:
#   - any localhost port  (dev server falls back to :3001/:3002… if busy)
#   - any *.vercel.app    (the deployed Next.js front-end)
#   - an explicit origin from $WEB_ORIGIN  (custom domain, if set)
# $WEB_ORIGIN lets a custom production domain be whitelisted without a
# code change on the API host.
_extra_origin = os.environ.get("WEB_ORIGIN", "").strip()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[_extra_origin] if _extra_origin else [],
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+|https://[\w-]+\.vercel\.app",
    allow_methods=["*"],
    allow_headers=["*"],
)


class GenerateRequest(BaseModel):
    """Inputs from the web GeneratorPanel."""

    source: str = Field("csv", description='"csv" or "fpl"')
    # CSV mode: True => VTSP->VTBS (reverse of the file's seqno order).
    vtsp_to_vtbs: bool = True
    # Departure / destination ICAO. These now actually drive direction
    # and the written meta (previously hardcoded for fpl mode).
    adep: str = "VTBS"
    ades: str = "VTSP"
    # FPL mode: raw Item-15 route string.
    route: str = "DCT MOTNA DCT SABIS DCT VANKO DCT"
    callsign: str = "SIM738"
    # ISO 8601; naive values are treated as UTC (project-wide rule).
    eobt: str = "2026-01-03T08:15:00"
    gs_kt: float = 450.0
    # Requested Flight Level in hundreds of feet (FL330 -> 330). Drives
    # the Phase 2 vertical profile (altitude + climb/cruise/descent).
    rfl: int = 330
    # 0-based index when several routes are flown under the same
    # (callsign, EOBT). Used to suffix the flight_key (e.g. "_R2") so
    # each file/PK is unique; the Callsign column itself stays the
    # user-typed value. Omit for a single-route request.
    flight_index: int | None = None


@lru_cache(maxsize=1)
def _airway_waypoint_index() -> dict[str, tuple[float, float]]:
    """ident -> (lat, lon) built from the real airway GeoJSON's own coords."""
    gdf = gpd.read_file(_AIRWAY_GEOJSON)
    index: dict[str, tuple[float, float]] = {}
    for _, r in gdf.iterrows():
        for id_col, la_col, lo_col in (
            ("waypoint_identifier", "waypoint_latitude", "waypoint_longitude"),
            ("waypoint_identifier_2", "waypoint_latitude_2", "waypoint_longitude_2"),
        ):
            ident = str(r[id_col])
            if ident and ident not in index:
                index[ident] = (float(r[la_col]), float(r[lo_col]))
    return index


@lru_cache(maxsize=1)
def _y8_sequence() -> list[str]:
    """Ordered Y8 fix sequence (BKK -> PUT) from the airway CSV.

    Used to expand `<fix> Y8 <fix>` spans in an Item-15 route string into
    the full set of intermediate Y8 fixes, so the generated trajectory
    actually follows the airway instead of cutting a direct great-circle
    between the two named endpoints.
    """
    df = pd.read_csv(_CSV_PATH).sort_values("seqno").reset_index(drop=True)
    seq: list[str] = []
    seen: set[str] = set()
    for row in df.itertuples(index=False):
        for ident in (row.waypoint_identifier, row.waypoint_identifier_2):
            ident = str(ident)
            if ident and ident not in seen:
                seen.add(ident)
                seq.append(ident)
    return seq


# Airway → ordered fix sequence. Only Y8 is supported in Phase 1 (the
# single VTBS↔VTSP corridor); add more entries here when the project
# grows to other airways.
_AIRWAY_SEQUENCES: dict[str, "callable[[], list[str]]"] = {"Y8": _y8_sequence}

_FIX_TOKEN_RE = re.compile(r"^[A-Z]{2,5}$")


def _expand_airways(route_str: str) -> str:
    """Inject intermediate airway fixes into an Item-15 route string.

    Walks the tokens left-to-right and, whenever it sees a
    `<fix> <airway> <fix>` triple where the airway is known and both
    endpoints sit on it, splices the intervening fixes in between. The
    airway designator itself is left in place — `parse_route` will drop
    it as before, so existing parsing is unchanged for non-airway
    routes.
    """
    tokens = route_str.split()
    out: list[str] = []
    i = 0
    while i < len(tokens):
        out.append(tokens[i])
        # Pattern: <fix> <airway> <fix>
        if (
            i + 2 < len(tokens)
            and _FIX_TOKEN_RE.match(tokens[i])
            and tokens[i + 1] in _AIRWAY_SEQUENCES
            and _FIX_TOKEN_RE.match(tokens[i + 2])
        ):
            seq = _AIRWAY_SEQUENCES[tokens[i + 1]]()
            a_ident, b_ident = tokens[i], tokens[i + 2]
            if a_ident in seq and b_ident in seq:
                a = seq.index(a_ident)
                b = seq.index(b_ident)
                step = 1 if a < b else -1
                for k in range(a + step, b, step):
                    out.append(seq[k])
        i += 1
    return " ".join(out)


@app.get("/api/health")
def health() -> dict[str, object]:
    return {
        "ok": True,
        "csv_present": _CSV_PATH.is_file(),
        "airway_present": _AIRWAY_GEOJSON.is_file(),
    }


@app.post("/api/generate")
def generate(req: GenerateRequest) -> dict[str, object]:
    warnings: list[str] = []

    # --- Validate the city pair (Phase 1 scope: VTBS <-> VTSP only) ---
    adep = req.adep.strip().upper()
    ades = req.ades.strip().upper()
    supported = {"VTBS", "VTSP"}
    if not adep or not ades:
        raise HTTPException(400, "ADEP and ADES are required.")
    if adep == ades:
        raise HTTPException(
            400, f"ADEP and ADES must differ (both {adep})."
        )
    unsupported = {adep, ades} - supported
    if unsupported:
        raise HTTPException(
            400,
            "Phase 1 supports only the VTBS <-> VTSP route. "
            f"Unsupported: {', '.join(sorted(unsupported))}.",
        )
    # Direction is implied by the departure aerodrome.
    vtsp_to_vtbs = adep == "VTSP"

    if req.source == "csv":
        route = load_route_csv(_CSV_PATH, reverse=vtsp_to_vtbs)
        route_pts = [(w.ident, w.lat, w.lon) for w in route]
    elif req.source == "fpl":
        # Expand `<fix> Y8 <fix>` spans before parsing so the trajectory
        # actually flies along the airway (matches the live preview and
        # the distance shown in the Best Routes ranker).
        idents = parse_route(_expand_airways(req.route))
        if not idents:
            raise HTTPException(400, "No waypoints parsed from route string.")
        index = _airway_waypoint_index()
        route_pts = []
        missing = []
        for ident in idents:
            if ident in index:
                lat, lon = index[ident]
                route_pts.append((ident, lat, lon))
            else:
                missing.append(ident)
        if missing:
            warnings.append(
                f"Not found in airway data (skipped): {', '.join(missing)}"
            )
        # Orient the route by ADEP so the file/animation actually follow
        # the city pair: the path must start at the fix nearest ADEP.
        if len(route_pts) >= 2:
            adep_ll = _AIRPORT_LL[adep]
            d0 = _sq_dist(route_pts[0][1:], adep_ll)
            dN = _sq_dist(route_pts[-1][1:], adep_ll)
            if dN < d0:
                route_pts.reverse()
    else:
        raise HTTPException(400, f"Unknown source {req.source!r}")

    if len(route_pts) < 2:
        raise HTTPException(400, "Route resolved to fewer than 2 waypoints.")

    try:
        eobt = parse_eobt(req.eobt)
    except ValueError as e:
        raise HTTPException(400, f"Invalid EOBT: {e}") from None

    waypoint_sequence = [(lat, lon) for _, lat, lon in route_pts]
    # Multi-route requests share (callsign, EOBT) — disambiguate the
    # flight_key/filename with an R-prefixed suffix instead of mangling
    # the callsign so the CSV's Callsign column stays the user's value.
    flight_key_suffix = (
        f"R{req.flight_index + 1}" if req.flight_index is not None else ""
    )
    try:
        gdf = build_trajectory_gdf(
            waypoint_sequence=waypoint_sequence,
            eobt=eobt,
            callsign=req.callsign,
            aircraft_type="B738",
            adep=adep,
            ades=ades,
            ground_speed_kt=req.gs_kt,
            rfl=req.rfl,
            flight_key_suffix=flight_key_suffix,
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from None

    flight_key = str(gdf["flight_key"].iloc[0])

    # Build the JSON payload first (it's all the web needs to render the
    # map); the heavier file exports follow.
    points = [
        {
            "lat": float(geom.y),
            "lon": float(geom.x),
            "epoch_ts": ts.isoformat(),
            "altitude_ft": None if alt is None else float(alt),
            "gs_kt": float(gs),
            "track_deg": float(trk),
            "phase": str(ph),
        }
        for geom, ts, alt, gs, trk, ph in zip(
            gdf.geometry,
            gdf["epoch_ts"],
            gdf["altitude_ft"],
            gdf["gs_kt"],
            gdf["track_deg"],
            gdf["phase"],
            strict=True,
        )
    ]
    distance_nm = route_distance_nm(waypoint_sequence)
    elapsed_min = (
        gdf["epoch_ts"].iloc[-1] - gdf["epoch_ts"].iloc[0]
    ).total_seconds() / 60.0

    # Top of Climb / Top of Descent — first cruise sample and the sample
    # *after* the last cruise sample respectively. The web uses these for
    # map markers and the altitude profile annotations; they're omitted
    # when a flight is too short to reach cruise (no "cruise" rows).
    phases = gdf["phase"].tolist()
    cruise_idx = [i for i, ph in enumerate(phases) if ph == "cruise"]
    toc = tod = None
    if cruise_idx:
        toc_i = cruise_idx[0]
        tod_i = cruise_idx[-1]
        toc = {
            "lat": float(gdf.geometry.iloc[toc_i].y),
            "lon": float(gdf.geometry.iloc[toc_i].x),
            "altitude_ft": float(gdf["altitude_ft"].iloc[toc_i]),
            "epoch_ts": gdf["epoch_ts"].iloc[toc_i].isoformat(),
        }
        tod = {
            "lat": float(gdf.geometry.iloc[tod_i].y),
            "lon": float(gdf.geometry.iloc[tod_i].x),
            "altitude_ft": float(gdf["altitude_ft"].iloc[tod_i]),
            "epoch_ts": gdf["epoch_ts"].iloc[tod_i].isoformat(),
        }
    cruise_alt_ft = (
        float(max(gdf["altitude_ft"].dropna()))
        if gdf["altitude_ft"].notna().any()
        else None
    )

    gpkg_path = _OUT_DIR / f"{flight_key}.gpkg"
    csv_path = _OUT_DIR / f"{flight_key}.csv"
    geojson_path = _OUT_DIR / f"{flight_key}.geojson"
    if gpkg_path.exists():
        gpkg_path.unlink()  # GPKG driver appends; ensure a clean layer
    write_geopackage(gdf, gpkg_path)
    # ROUTE header carries the raw Item-15 string for fpl/build mode; in
    # CSV mode the route is the full Y8, so render it as "BKK Y8 PUT"
    # (or its reverse) for consistency with the live preview.
    if req.source == "csv":
        seq = _y8_sequence()
        route_for_header = (
            f"{seq[-1]} Y8 {seq[0]}" if vtsp_to_vtbs else f"{seq[0]} Y8 {seq[-1]}"
        )
    else:
        route_for_header = req.route
    write_csv(gdf, csv_path, route_str=route_for_header, rfl=req.rfl)
    # gdf is no longer read after this — mutate in place instead of copying.
    gdf["epoch_ts"] = gdf["epoch_ts"].astype(str)
    gdf.to_file(geojson_path, driver="GeoJSON")

    return {
        "flight_key": flight_key,
        "meta": {
            "callsign": req.callsign,
            "aircraft_type": "B738",
            "adep": adep,
            "ades": ades,
            "eobt": eobt.isoformat(),
            "engine": "Python trajectory_sim · pyproj.Geod (WGS-84)",
        },
        "stats": {
            "waypoint_count": len(route_pts),
            "point_count": len(points),
            "distance_nm": round(distance_nm, 1),
            "time_minutes": round(elapsed_min, 1),
            "cruise_alt_ft": cruise_alt_ft,
            "rfl_ft": float(req.rfl) * 100.0,
        },
        "profile": {
            "toc": toc,
            "tod": tod,
        },
        "route": [
            {"ident": i, "lat": la, "lon": lo} for i, la, lo in route_pts
        ],
        "points": points,
        "warnings": warnings,
        "downloads": {
            "gpkg": f"/api/download/{flight_key}.gpkg",
            "csv": f"/api/download/{flight_key}.csv",
            "geojson": f"/api/download/{flight_key}.geojson",
        },
    }


_MEDIA = {
    "gpkg": "application/geopackage+sqlite3",
    "csv": "text/csv",
    "geojson": "application/geo+json",
}


@app.get("/api/download/{flight_key}.{ext}")
def download(flight_key: str, ext: str) -> FileResponse:
    if ext not in _MEDIA:
        raise HTTPException(400, f"Unsupported format .{ext}")
    # flight_key is generated server-side; reject any path trickery.
    if "/" in flight_key or "\\" in flight_key or ".." in flight_key:
        raise HTTPException(400, "Invalid flight key.")
    path = _OUT_DIR / f"{flight_key}.{ext}"
    if not path.is_file():
        raise HTTPException(404, "File not found — generate it first.")
    return FileResponse(
        path, media_type=_MEDIA[ext], filename=f"{flight_key}.{ext}"
    )
