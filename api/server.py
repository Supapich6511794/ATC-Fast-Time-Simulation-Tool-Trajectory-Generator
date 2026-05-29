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

import io
import json
import os
import re
import tempfile
import threading
import zipfile
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path

import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from trajectory_sim.fpl import FlightPlan, parse_eobt, parse_route
from trajectory_sim.geodesy import route_distance_nm
from trajectory_sim.output import (
    build_trajectory_gdf,
    write_csv,
    write_geopackage,
)
from trajectory_sim.performance import (
    PERFORMANCE_SOURCE,
    aircraft_speeds,
    crossover_altitude_ft,
    get_speed_restriction,
    register_field_elevations,
    set_speed_restriction,
    set_speed_schedule,
    tune_speed_schedule,
)
from trajectory_sim.trajectory import build_flight_timeline
from trajectory_sim.validation import CAT62Reference

# Project root = parent of this `api/` package.
_ROOT = Path(__file__).resolve().parent.parent
_DATA = _ROOT / "web" / "public" / "data"
# Thai navdata now comes from the CAAT eAIP, parsed once per AIRAC cycle
# into this JSON cache by scripts/ingest_aip.py (waypoints + airways).
# Replaces the hand-curated VTPStoVTBS.csv / airway_waypoint.geojson.
_AIP_PATH = _DATA / "aip_VT.json"
_OUT_DIR = _ROOT / "api" / "_outputs"
_OUT_DIR.mkdir(parents=True, exist_ok=True)

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

    # --- Optional speed-schedule overrides (Phase 3 tuning) -----------
    # Any field left None keeps the airframe's default. Applied per
    # request and restored afterwards, so one user's tuning never leaks
    # into another's generation.
    climb_cas_kt: float | None = None
    climb_mach: float | None = None
    cruise_mach: float | None = None
    descent_mach: float | None = None
    descent_cas_kt: float | None = None
    # Below-FL100 CAS cap (default 250 kt). Pass a large value to lift it.
    restrict_cas_kt: float | None = None


# Per-airframe speed tuning mutates module-level state in
# trajectory_sim.performance; serialise generation so concurrent
# requests (FastAPI runs sync endpoints in a threadpool) can't see each
# other's overrides mid-build. Generation is fast, so a lock is cheap.
_GEN_LOCK = threading.Lock()

# CAT62 reference times, loaded once. Falls back to an empty table if the
# bundled file is somehow missing, so the endpoint never hard-fails.
try:
    _CAT62_REF = CAT62Reference.load()
except Exception:  # noqa: BLE001
    _CAT62_REF = CAT62Reference({})

# The only airframe the sim flies; speed-tuning snapshots target it.
_ACTYPE = "B738"


@lru_cache(maxsize=1)
def _aip() -> dict[str, object]:
    """Load the CAAT eAIP navdata cache (built by scripts/ingest_aip.py).

    Cached for the process lifetime — the file only changes per AIRAC
    cycle, which means a redeploy/restart anyway.
    """
    if not _AIP_PATH.is_file():
        raise RuntimeError(
            f"AIP navdata cache missing at {_AIP_PATH}. "
            "Run: python scripts/ingest_aip.py --airac <YYYY-MM-DD>"
        )
    return json.loads(_AIP_PATH.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def _airway_waypoint_index() -> dict[str, tuple[float, float]]:
    """ident -> (lat, lon) from the AIP significant points + airway fixes."""
    waypoints = _aip()["waypoints"]
    return {
        ident: (float(w["lat"]), float(w["lon"]))
        for ident, w in waypoints.items()  # type: ignore[union-attr]
    }


@lru_cache(maxsize=1)
def _airways() -> dict[str, list[str]]:
    """designator -> ordered ident sequence, straight from the AIP cache."""
    return {
        desig: list(seq)
        for desig, seq in _aip()["airways"].items()  # type: ignore[union-attr]
    }


@lru_cache(maxsize=1)
def _airports() -> dict[str, dict[str, object]]:
    """ICAO -> {lat, lon, elev_ft?, name?} from the AIP AD section."""
    return {
        icao: dict(info)  # type: ignore[arg-type]
        for icao, info in _aip().get("airports", {}).items()  # type: ignore[union-attr]
    }


def _airport_ll(icao: str) -> tuple[float, float] | None:
    """Aerodrome reference point (lat, lon) from the AIP, or None."""
    a = _airports().get(icao)
    if a and "lat" in a and "lon" in a:
        return (float(a["lat"]), float(a["lon"]))  # type: ignore[arg-type]
    return None


def _register_field_elevations() -> None:
    """Push AIP aerodrome elevations into the performance model so the
    climb/descent profile uses real field elevations for every Thai
    airport, not just the three hardcoded in performance.py."""
    elevs = {
        icao: float(a["elev_ft"])  # type: ignore[arg-type]
        for icao, a in _airports().items()
        if "elev_ft" in a
    }
    if elevs:
        register_field_elevations(elevs)


# Inject real AIP field elevations at startup. Guarded so a missing
# cache (fresh checkout before the first ingest) never blocks boot.
try:
    _register_field_elevations()
except Exception:  # noqa: BLE001 — fall back to the hardcoded set
    pass


def _airway_sequence(designator: str) -> list[str]:
    """Ordered fix sequence for an airway (e.g. 'Y8'), or [] if unknown."""
    return _airways().get(designator, [])


def _airway_route_points(
    designator: str, reverse: bool
) -> list[tuple[str, float, float]]:
    """Resolve an airway to (ident, lat, lon) points, optionally reversed.

    Used by CSV-mode generation: the published Y8 sequence is BKK→PUT, so
    ``reverse=True`` (VTSP→VTBS) flips it.
    """
    index = _airway_waypoint_index()
    pts = [
        (ident, *index[ident])
        for ident in _airway_sequence(designator)
        if ident in index
    ]
    return list(reversed(pts)) if reverse else pts


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
    airways = _airways()
    tokens = route_str.split()
    out: list[str] = []
    i = 0
    while i < len(tokens):
        out.append(tokens[i])
        # Pattern: <fix> <airway> <fix>
        if (
            i + 2 < len(tokens)
            and _FIX_TOKEN_RE.match(tokens[i])
            and tokens[i + 1] in airways
            and _FIX_TOKEN_RE.match(tokens[i + 2])
        ):
            seq = airways[tokens[i + 1]]
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
    info: dict[str, object] = {"ok": True, "aip_present": _AIP_PATH.is_file()}
    if _AIP_PATH.is_file():
        try:
            aip = _aip()
            info["airac"] = aip.get("airac")
            info["waypoint_count"] = aip.get("waypoint_count")
            info["airway_count"] = aip.get("airway_count")
        except Exception:  # noqa: BLE001 — health must never 500
            info["ok"] = False
    return info


@app.get("/api/cat62_reference")
def cat62_reference() -> dict[str, object]:
    """Flight-time reference table + acceptance threshold for the web.

    Lets the route picker pre-screen candidate routes (PASS/FAIL within
    the threshold) without round-tripping each one through /api/generate.
    """
    return {
        "threshold_min": _CAT62_REF.threshold_min,
        "routes": _CAT62_REF.table(),
    }


def _generate_one(req: GenerateRequest) -> dict[str, object]:
    """Build one trajectory + its payload. Shared by the single-flight
    /api/generate endpoint and the bulk /api/generate_batch loop."""
    warnings: list[str] = []

    # --- Validate the city pair (any Thai aerodrome pair is allowed) ---
    adep = req.adep.strip().upper()
    ades = req.ades.strip().upper()
    if not adep or not ades:
        raise HTTPException(400, "ADEP and ADES are required.")
    if adep == ades:
        raise HTTPException(
            400, f"ADEP and ADES must differ (both {adep})."
        )

    if req.source == "csv":
        # Legacy shortcut: "follow the full published Y8 airway" from the
        # AIP cache. Only meaningful for the VTBS<->VTSP corridor; any
        # other pair should use FPL mode (type the route explicitly).
        if {adep, ades} != {"VTBS", "VTSP"}:
            raise HTTPException(
                400,
                "CSV (full-Y8) mode only covers VTBS <-> VTSP. "
                "Use route mode to type an Item-15 route for other pairs.",
            )
        route_pts = _airway_route_points("Y8", reverse=adep == "VTSP")
    elif req.source == "fpl":
        # Expand `<fix> <airway> <fix>` spans before parsing so the
        # trajectory follows the airway. Works for ALL 134 AIP airways.
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
                f"Not found in AIP navdata (skipped): {', '.join(missing)}"
            )
        # Orient the route by ADEP so the file/animation follow the city
        # pair: the path must start at the fix nearest ADEP. Only possible
        # when the departure aerodrome's coordinates are in the AIP; if
        # not (unknown/foreign field), keep the route as typed.
        adep_ll = _airport_ll(adep)
        if adep_ll is not None and len(route_pts) >= 2:
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

    # Construct the canonical FlightPlan dataclass — Phase 2 spec says
    # RFL must be read from FlightPlan, not threaded as a bare int. The
    # ``route`` field captures the raw Item-15 string (or a synthetic one
    # in CSV mode) so the FPL is round-trippable.
    if req.source == "csv":
        fpl_route_str = "DCT " + " ".join(p[0] for p in route_pts) + " DCT"
    else:
        fpl_route_str = req.route
    try:
        fpl = FlightPlan(
            callsign=req.callsign or "FLT",
            aircraft_type="B738",
            adep=adep,
            ades=ades,
            eobt=eobt,
            rfl=int(req.rfl),
            route=fpl_route_str,
        )
    except ValueError as e:
        raise HTTPException(400, f"Invalid flight plan: {e}") from None

    waypoint_sequence = [(lat, lon) for _, lat, lon in route_pts]
    # Multi-route requests share (callsign, EOBT) — disambiguate the
    # flight_key/filename with an R-prefixed suffix instead of mangling
    # the callsign so the CSV's Callsign column stays the user's value.
    flight_key_suffix = (
        f"R{req.flight_index + 1}" if req.flight_index is not None else ""
    )
    # Any speed-schedule override present?
    _has_sched_override = any(
        v is not None
        for v in (
            req.climb_cas_kt,
            req.climb_mach,
            req.cruise_mach,
            req.descent_mach,
            req.descent_cas_kt,
        )
    )
    _has_override = _has_sched_override or req.restrict_cas_kt is not None

    # Serialise generation: the tuning setters mutate module globals in
    # trajectory_sim.performance, so we snapshot → apply → build →
    # restore under a lock to keep requests isolated.
    with _GEN_LOCK:
        orig_sched = aircraft_speeds(_ACTYPE)
        orig_restrict = get_speed_restriction()
        try:
            if _has_sched_override:
                tune_speed_schedule(
                    _ACTYPE,
                    climb_cas_kt=req.climb_cas_kt,
                    climb_mach=req.climb_mach,
                    cruise_mach=req.cruise_mach,
                    descent_mach=req.descent_mach,
                    descent_cas_kt=req.descent_cas_kt,
                )
            if req.restrict_cas_kt is not None:
                set_speed_restriction(cas_kt=req.restrict_cas_kt)

            gdf = build_trajectory_gdf(
                waypoint_sequence=waypoint_sequence,
                eobt=fpl.eobt,
                callsign=fpl.callsign,
                aircraft_type=fpl.aircraft_type,
                adep=fpl.adep,
                ades=fpl.ades,
                ground_speed_kt=req.gs_kt,
                # Phase 2 acceptance: cruise FL must be an exact match to
                # the FPL-requested level — read it from the dataclass,
                # not from the raw int the browser sent.
                rfl=fpl.rfl,
                flight_key_suffix=flight_key_suffix,
            )
            # Snapshot the schedule actually flown *before* restore, so the
            # reported speed_schedule reflects this flight's overrides (not
            # the baseline the globals get reset to in `finally`).
            applied_sched = aircraft_speeds(_ACTYPE)
            applied_crossover_ft = crossover_altitude_ft(_ACTYPE)
            applied_restrict_kt = get_speed_restriction()[0]
        except ValueError as e:
            raise HTTPException(400, str(e)) from None
        finally:
            # Always restore the baseline schedule + restriction.
            set_speed_schedule(_ACTYPE, orig_sched)
            set_speed_restriction(
                cas_kt=orig_restrict[0], below_alt_ft=orig_restrict[1]
            )

    flight_key = str(gdf["flight_key"].iloc[0])

    # Build the JSON payload first (it's all the web needs to render the
    # map); the heavier file exports follow.
    # Phase 3: include `tas_kt` per point. `pd.isna` guards the legacy
    # constant-speed path where the column is None for every row.
    points = [
        {
            "lat": float(geom.y),
            "lon": float(geom.x),
            "epoch_ts": ts.isoformat(),
            "altitude_ft": None if alt is None else float(alt),
            "gs_kt": float(gs),
            "tas_kt": None if tas is None or pd.isna(tas) else float(tas),
            "track_deg": float(trk),
            "phase": str(ph),
        }
        for geom, ts, alt, gs, tas, trk, ph in zip(
            gdf.geometry,
            gdf["epoch_ts"],
            gdf["altitude_ft"],
            gdf["gs_kt"],
            gdf["tas_kt"],
            gdf["track_deg"],
            gdf["phase"],
            strict=True,
        )
    ]
    distance_nm = route_distance_nm(waypoint_sequence)
    elapsed_min = (
        gdf["epoch_ts"].iloc[-1] - gdf["epoch_ts"].iloc[0]
    ).total_seconds() / 60.0

    # Flight-time validation — real CAT62 sample where we have one, else a
    # distance-based estimate so every routable pair reports a delta.
    _val = _CAT62_REF.validate(adep, ades, elapsed_min, distance_nm=distance_nm)
    validation = _val.to_dict() if _val is not None else None

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

    # Phase-3 summary: time-weighted average GS per phase + the planned
    # speed schedule the airframe is flying. Computed straight off the
    # gdf rather than re-running build_flight_timeline (one pass, all
    # the data already on hand).
    def _avg(col: str, phase: str) -> float | None:
        rows = gdf[gdf["phase"] == phase][col].dropna()
        if rows.empty:
            return None
        return float(rows.mean())

    def _phase_minutes(phase: str) -> float | None:
        rows = gdf[gdf["phase"] == phase]["epoch_ts"]
        if rows.empty:
            return None
        return float(
            (rows.iloc[-1] - rows.iloc[0]).total_seconds() / 60.0
        )

    speed_schedule = {
        "climb_cas_kt": applied_sched.climb_cas_kt,
        "climb_mach": applied_sched.climb_mach,
        "cruise_mach": applied_sched.cruise_mach,
        "descent_mach": applied_sched.descent_mach,
        "descent_cas_kt": applied_sched.descent_cas_kt,
        "crossover_ft": applied_crossover_ft,
        "below_fl100_restriction_kt": applied_restrict_kt,
    }
    phase_breakdown = {
        "climb": {
            "avg_tas_kt": _avg("tas_kt", "climb"),
            "avg_gs_kt": _avg("gs_kt", "climb"),
            "time_min": _phase_minutes("climb"),
        },
        "cruise": {
            "avg_tas_kt": _avg("tas_kt", "cruise"),
            "avg_gs_kt": _avg("gs_kt", "cruise"),
            "time_min": _phase_minutes("cruise"),
        },
        "descent": {
            "avg_tas_kt": _avg("tas_kt", "descent"),
            "avg_gs_kt": _avg("gs_kt", "descent"),
            "time_min": _phase_minutes("descent"),
        },
    }

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
        seq = _airway_sequence("Y8")
        route_for_header = (
            f"{seq[-1]} Y8 {seq[0]}" if adep == "VTSP" else f"{seq[0]} Y8 {seq[-1]}"
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
            "engine": (
                "Python trajectory_sim · pyproj.Geod (WGS-84) · "
                f"{PERFORMANCE_SOURCE}"
            ),
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
            "speed_schedule": speed_schedule,
            "phase_breakdown": phase_breakdown,
        },
        "validation": validation,
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


@app.post("/api/generate")
def generate(req: GenerateRequest) -> dict[str, object]:
    return _generate_one(req)


class BatchRequest(BaseModel):
    """POST body for /api/generate_batch — a list of flight specs."""

    flights: list[GenerateRequest] = Field(default_factory=list)


@app.post("/api/generate_batch")
def generate_batch(req: BatchRequest) -> dict[str, object]:
    """Generate many trajectories in one request.

    Each flight is built with :func:`_generate_one`. A failing flight is
    recorded in ``errors`` rather than aborting the whole batch, so a few
    bad rows in a 2000-row import don't sink the run. Every flight is
    given a distinct ``flight_index`` so flight_keys never collide even
    when two rows share callsign + EOBT.
    """
    if not req.flights:
        raise HTTPException(400, "No flights provided.")

    results: list[dict[str, object]] = []
    errors: list[dict[str, object]] = []
    for i, f in enumerate(req.flights):
        spec = f.model_copy(update={"flight_index": i})
        try:
            results.append(_generate_one(spec))
        except HTTPException as e:
            errors.append(
                {
                    "index": i,
                    "callsign": f.callsign,
                    "adep": f.adep,
                    "ades": f.ades,
                    "detail": str(e.detail),
                }
            )
    return {"results": results, "errors": errors, "count": len(results)}


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


class _ZipFileSpec(BaseModel):
    """One file to include in a download bundle."""

    flight_key: str
    ext: str  # "gpkg" | "csv" | "geojson"


class ZipRequest(BaseModel):
    """POST body for ``/api/download_zip``.

    Each entry pairs a server-generated flight_key with one of the
    supported extensions; the response is a single ``.zip`` archive
    containing every matching file laid out as ``<flight_key>.<ext>``.
    """

    files: list[_ZipFileSpec] = Field(default_factory=list)


@app.post("/api/download_zip")
def download_zip(req: ZipRequest) -> StreamingResponse:
    if not req.files:
        raise HTTPException(400, "No files requested.")

    # Build the archive in memory so we can stream it back without ever
    # writing it to disk — the output files are already on disk, this
    # endpoint only repackages them.
    buf = io.BytesIO()
    added = 0
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for spec in req.files:
            ext = spec.ext.lower()
            flight_key = spec.flight_key
            # Reject the same path-traversal patterns the single-file
            # endpoint rejects.
            if ext not in _MEDIA:
                continue
            if "/" in flight_key or "\\" in flight_key or ".." in flight_key:
                continue
            path = _OUT_DIR / f"{flight_key}.{ext}"
            if path.is_file():
                zf.write(path, arcname=f"{flight_key}.{ext}")
                added += 1

    if added == 0:
        raise HTTPException(404, "None of the requested files were found.")

    buf.seek(0)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    archive_name = f"trajectories_{stamp}.zip"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{archive_name}"'
        },
    )


class CombineRequest(BaseModel):
    """POST body for ``/api/download_combined``.

    Unlike ``/api/download_zip`` (which bundles each route as its own
    file), this MERGES the listed routes into a single combined file
    per requested format — e.g. one GeoPackage holding every flight's
    points in one ``trajectory`` layer, distinguishable by ``flight_key``.
    Useful for loading a whole traffic scenario as one dataset.
    """

    flight_keys: list[str] = Field(default_factory=list)
    formats: list[str] = Field(default_factory=list)


def _safe_key(flight_key: str) -> bool:
    return not (
        "/" in flight_key or "\\" in flight_key or ".." in flight_key
    )


def _load_combined_gdf(flight_keys: list[str]) -> "gpd.GeoDataFrame":
    """Read every route's GeoPackage and concat into one GeoDataFrame.

    The per-route ``.gpkg`` is the richest saved artefact (typed columns
    + POINT Z), so it's the canonical source for the merge.
    """
    import geopandas as gpd  # already loaded via trajectory_sim.output

    frames = []
    for fk in flight_keys:
        if not _safe_key(fk):
            continue
        path = _OUT_DIR / f"{fk}.gpkg"
        if path.is_file():
            frames.append(gpd.read_file(path))
    if not frames:
        return None  # type: ignore[return-value]
    combined = pd.concat(frames, ignore_index=True)
    combined = gpd.GeoDataFrame(
        combined, crs=frames[0].crs, geometry="geometry"
    )
    if "flight_key" in combined and "epoch_ts" in combined:
        combined = combined.sort_values(
            ["flight_key", "epoch_ts"]
        ).reset_index(drop=True)
    return combined


def _combined_bytes(combined: "gpd.GeoDataFrame", ext: str) -> bytes:
    """Serialise the merged GeoDataFrame to one file of the given format."""
    if ext == "gpkg":
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "combined.gpkg"
            write_geopackage(combined, p)
            return p.read_bytes()

    if ext == "geojson":
        g = combined.copy()
        # GeoJSON driver wants plain strings for datetimes.
        if "epoch_ts" in g:
            g["epoch_ts"] = g["epoch_ts"].astype(str)
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "combined.geojson"
            g.to_file(p, driver="GeoJSON")
            return p.read_bytes()

    raise HTTPException(400, f"Unsupported format .{ext}")


def _combined_csv_from_files(flight_keys: list[str]) -> bytes:
    """Stack each route's own readable CSV block into one file.

    The CSV is the human-readable export (ROUTE / DEST / ACTYPE / FL /
    ATD header + the 8-column table). For a combined download we keep
    that exact per-route layout and concatenate the blocks with a clear
    divider between routes, rather than flattening into one machine
    table — so the file reads like several flight strips in sequence.
    """
    blocks: list[str] = []
    total = len(flight_keys)
    for n, fk in enumerate(flight_keys, start=1):
        if not _safe_key(fk):
            continue
        path = _OUT_DIR / f"{fk}.csv"
        if not path.is_file():
            continue
        # Plain-ASCII divider — em-dashes mojibake in Excel/Notepad under
        # the cp874 Thai-Windows default (same reason write_csv avoids them).
        header = (
            "=" * 64
            + f"\nFLIGHT {n} of {total}  -  {fk}\n"
            + "=" * 64
            + "\n\n"
        )
        blocks.append(header + path.read_text(encoding="utf-8").rstrip("\n"))
    if not blocks:
        raise HTTPException(404, "None of the requested routes were found.")
    return ("\n\n\n".join(blocks) + "\n").encode("utf-8")


@app.post("/api/download_combined")
def download_combined(req: CombineRequest) -> StreamingResponse:
    flight_keys = [fk for fk in req.flight_keys if _safe_key(fk)]
    formats = [f.lower() for f in req.formats if f.lower() in _MEDIA]
    if not flight_keys:
        raise HTTPException(400, "No routes requested.")
    if not formats:
        raise HTTPException(400, "No formats requested.")

    # The merged GeoDataFrame is only needed for the data formats
    # (GeoPackage / GeoJSON). The CSV stays human-readable by stacking
    # each route's own CSV block, so it doesn't go through the gdf.
    need_gdf = any(f in ("gpkg", "geojson") for f in formats)
    combined = _load_combined_gdf(flight_keys) if need_gdf else None
    if need_gdf and (combined is None or len(combined) == 0):
        raise HTTPException(404, "None of the requested routes were found.")

    def bytes_for(ext: str) -> bytes:
        if ext == "csv":
            return _combined_csv_from_files(flight_keys)
        return _combined_bytes(combined, ext)  # type: ignore[arg-type]

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")

    # Single format → return that combined file directly. Multiple
    # formats → zip the combined files together.
    if len(formats) == 1:
        ext = formats[0]
        return StreamingResponse(
            iter([bytes_for(ext)]),
            media_type=_MEDIA[ext],
            headers={
                "Content-Disposition": (
                    f'attachment; filename="combined_{stamp}.{ext}"'
                )
            },
        )

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for ext in formats:
            zf.writestr(f"combined_{stamp}.{ext}", bytes_for(ext))
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="application/zip",
        headers={
            "Content-Disposition": (
                f'attachment; filename="combined_{stamp}.zip"'
            )
        },
    )
