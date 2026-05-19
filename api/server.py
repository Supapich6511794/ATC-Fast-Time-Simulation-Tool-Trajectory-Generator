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
from functools import lru_cache
from pathlib import Path

import geopandas as gpd
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
        idents = parse_route(req.route)
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

    gpkg_path = _OUT_DIR / f"{flight_key}.gpkg"
    csv_path = _OUT_DIR / f"{flight_key}.csv"
    geojson_path = _OUT_DIR / f"{flight_key}.geojson"
    if gpkg_path.exists():
        gpkg_path.unlink()  # GPKG driver appends; ensure a clean layer
    write_geopackage(gdf, gpkg_path)
    write_csv(gdf, csv_path)
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
