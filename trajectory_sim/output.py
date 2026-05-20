"""Write trajectory data to GeoPackage and CSV.

Stitches per-leg interpolations from geodesy.interpolate_great_circle
into a single GeoDataFrame matching the sim_output.gpkg schema, then
writes to disk.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import geopandas as gpd
import pandas as pd
from shapely.geometry import Point

from trajectory_sim.geodesy import compute_bearing, interpolate_great_circle
from trajectory_sim.performance import VerticalProfile, field_elevation_ft


def build_trajectory_gdf(
    waypoint_sequence: list[tuple[float, float]],
    eobt: datetime,
    callsign: str,
    aircraft_type: str,
    adep: str,
    ades: str,
    ground_speed_kt: float = 450.0,
    rfl: int | None = None,
    flight_key_suffix: str = "",
) -> gpd.GeoDataFrame:
    """Build a trajectory GeoDataFrame from a sequence of waypoints.

    Calls interpolate_great_circle on each consecutive pair and stitches
    the results, dropping the duplicate boundary point at each leg join.

    Args:
        waypoint_sequence: Ordered (latitude_deg, longitude_deg) tuples
            in WGS-84. Must contain at least 2 points.
        eobt: Estimated Off-Block Time, timezone-aware UTC. Used as t=0
            for the trajectory timestamps.
        callsign: ATC callsign.
        aircraft_type: ICAO aircraft type designator.
        adep, ades: ICAO departure and destination airports.
        ground_speed_kt: Constant ground speed in knots (Phase 1).
        rfl: Requested Flight Level in hundreds of feet (e.g. 330 →
            FL330). When given, a Phase 2 vertical profile is applied:
            altitude_ft is populated, phase is climb/cruise/descent, and
            the geometry becomes POINT Z. When None, Phase 1 behaviour is
            kept (altitude_ft None, phase "cruise", 2-D POINT).
        flight_key_suffix: Optional suffix appended to the generated
            flight_key (e.g. ``"R1"`` for "route 1 of N"). Lets the
            caller fly the same (callsign, EOBT) along several distinct
            routes without filename or PK collision, while keeping the
            ``callsign`` column itself unchanged.

    Returns:
        GeoDataFrame, EPSG:4326, with columns: flight_key, callsign,
        aircraft_type, adep, ades, epoch_ts (UTC), altitude_ft, tas_kt
        (None until Phase 3), gs_kt, track_deg, phase, geometry.

    Raises:
        ValueError: if waypoint_sequence has fewer than 2 points or
            eobt is not UTC-aware.
    """
    if eobt.tzinfo is None or eobt.utcoffset() != timedelta(0):
        raise ValueError("eobt must be timezone-aware UTC")
    if len(waypoint_sequence) < 2:
        raise ValueError("waypoint_sequence must contain at least 2 points")

    flight_key = f"{callsign}_{eobt.strftime('%Y%m%dT%H%MZ')}"
    if flight_key_suffix:
        flight_key = f"{flight_key}_{flight_key_suffix}"

    raw: list[dict[str, object]] = []
    cumulative_t_s = 0.0
    for i in range(len(waypoint_sequence) - 1):
        lat1, lon1 = waypoint_sequence[i]
        lat2, lon2 = waypoint_sequence[i + 1]
        leg_points = interpolate_great_circle(
            lat1, lon1, lat2, lon2, ground_speed_kt=ground_speed_kt
        )
        track_deg = compute_bearing(lat1, lon1, lat2, lon2)

        for j, p in enumerate(leg_points):
            # Skip the leg's start point on legs after the first to avoid
            # duplicating the boundary waypoint.
            if i > 0 and j == 0:
                continue
            raw.append({
                "elapsed_s": cumulative_t_s + p["elapsed_s"],
                "lat": p["lat"],
                "lon": p["lon"],
                "track_deg": track_deg,
            })
        cumulative_t_s += leg_points[-1]["elapsed_s"]

    total_time_s = raw[-1]["elapsed_s"] if raw else 0.0

    # The vertical profile needs the total flight time, which is only
    # known once the horizontal path above is complete.
    profile: VerticalProfile | None = None
    if rfl is not None:
        profile = VerticalProfile.build(
            total_time_s=total_time_s,
            rfl_ft=rfl * 100.0,
            aircraft_type=aircraft_type,
            dep_elev_ft=field_elevation_ft(adep),
            des_elev_ft=field_elevation_ft(ades),
        )

    records: list[dict[str, object]] = []
    for r in raw:
        elapsed_s = float(r["elapsed_s"])
        if profile is not None:
            altitude_ft, phase = profile.at(elapsed_s)
            # POINT Z carries altitude (metres) in the geometry too.
            geom = Point(r["lon"], r["lat"], altitude_ft * 0.3048)
        else:
            altitude_ft, phase = None, "cruise"
            geom = Point(r["lon"], r["lat"])
        records.append({
            "flight_key": flight_key,
            "callsign": callsign,
            "aircraft_type": aircraft_type,
            "adep": adep,
            "ades": ades,
            "epoch_ts": eobt + timedelta(seconds=elapsed_s),
            "altitude_ft": altitude_ft,
            "tas_kt": None,
            "gs_kt": ground_speed_kt,
            "track_deg": r["track_deg"],
            "phase": phase,
            "geometry": geom,
        })

    return gpd.GeoDataFrame(records, crs="EPSG:4326", geometry="geometry")


def write_geopackage(
    gdf: gpd.GeoDataFrame,
    path: str | Path,
    layer: str = "trajectory",
) -> None:
    """Write a trajectory GeoDataFrame to a GeoPackage layer.

    Overwrites the layer if it already exists. After writing, two
    indices are added on the trajectory layer to match the brief's
    output schema (§6.2):

      * UNIQUE INDEX on (flight_key, epoch_ts) — the brief specifies
        ``PRIMARY KEY (flight_key, epoch_ts)`` but SQLite cannot add a
        PRIMARY KEY to an existing table after ``geopandas.to_file``
        has created it; a UNIQUE index enforces the same constraint.
      * Plain INDEX on epoch_ts — for time-range scans (the brief's
        ``trajectory_ts_idx``).

    The R-tree spatial index on the geometry column is already created
    automatically by the GPKG driver.

    Args:
        gdf: GeoDataFrame as built by build_trajectory_gdf.
        path: Output .gpkg filesystem path.
        layer: Layer name within the GeoPackage (default "trajectory").
    """
    gpkg_path = Path(path)
    gdf.to_file(gpkg_path, layer=layer, driver="GPKG")

    # GeoPackage is a SQLite file — open it and add the brief-required
    # indices on the just-written layer. `IF NOT EXISTS` keeps repeat
    # writes (overwrite-same-layer) idempotent. The `with` block on a
    # sqlite3 connection only commits/rollbacks on exit; on Windows the
    # OS file lock survives a non-closed handle and blocks the next
    # request's `unlink()` — so close explicitly in a finally.
    conn = sqlite3.connect(gpkg_path)
    try:
        conn.execute(
            f'CREATE UNIQUE INDEX IF NOT EXISTS "{layer}_pk_idx" '
            f'ON "{layer}" (flight_key, epoch_ts)'
        )
        conn.execute(
            f'CREATE INDEX IF NOT EXISTS "{layer}_ts_idx" '
            f'ON "{layer}" (epoch_ts)'
        )
        conn.commit()
    finally:
        conn.close()


def write_csv(
    gdf: gpd.GeoDataFrame,
    path: str | Path,
    *,
    route_str: str = "",
    rfl: int | None = None,
) -> None:
    """Write a trajectory GeoDataFrame to the ATC-style trajectory CSV.

    Layout::

        ROUTE: <route_str>
        DEST: <ades>
        ACTYPE: <aircraft_type>
        FL: F<rfl>
        ATD: YYYY-MM-DD HH:MM:SS

        ---

        Timestamp,UTC,Callsign,Lat,Lon,Altitude,Speed,Direction
        <epoch_s>,<iso_utc_Z>,<callsign>,<lat>,<lon>,<alt_ft>,<gs_kt>,<track_deg>
        ...

    The column header has 8 names that line up 1-to-1 with the 8 fields
    of each data row, so Excel/pandas open the CSV with every value
    under the right header.

    Args:
        gdf: GeoDataFrame as built by build_trajectory_gdf.
        path: Output .csv filesystem path.
        route_str: Raw Item-15 route string written into the ROUTE
            header (e.g. ``"BKK Y8 PUT"``). Optional; empty by default.
        rfl: Requested Flight Level (hundreds of feet) written into the
            FL header as ``"F<rfl>"``. Optional; the FL line is omitted
            when None.
    """
    out_path = Path(path)

    # Metadata pulled from the gdf's constant columns. These are the
    # same for every row (the gdf is one flight).
    ades = str(gdf["ades"].iloc[0])
    actype = str(gdf["aircraft_type"].iloc[0])
    callsign = str(gdf["callsign"].iloc[0])
    eobt_raw = gdf["epoch_ts"].iloc[0]
    eobt = (
        eobt_raw.to_pydatetime()
        if hasattr(eobt_raw, "to_pydatetime")
        else eobt_raw
    )
    if eobt.tzinfo is None:
        eobt = eobt.replace(tzinfo=timezone.utc)

    with out_path.open("w", encoding="utf-8", newline="") as f:
        f.write(f"ROUTE: {route_str}\n")
        f.write(f"DEST: {ades}\n")
        f.write(f"ACTYPE: {actype}\n")
        if rfl is not None:
            f.write(f"FL: F{rfl}\n")
        f.write(f"ATD: {eobt.strftime('%Y-%m-%d %H:%M:%S')}\n")
        # Plain-ASCII separator — em-dashes mojibake in Excel/Notepad
        # when the file is opened under cp1252/cp874 (Thai Windows
        # default), making "———" render as 'â€"â€"â€"'.
        f.write("\n---\n\n")
        f.write("Timestamp,UTC,Callsign,Lat,Lon,Altitude,Speed,Direction\n")

        for geom, ts, alt, gs, trk in zip(
            gdf.geometry,
            gdf["epoch_ts"],
            gdf["altitude_ft"],
            gdf["gs_kt"],
            gdf["track_deg"],
            strict=True,
        ):
            ts_dt = ts.to_pydatetime() if hasattr(ts, "to_pydatetime") else ts
            if ts_dt.tzinfo is None:
                ts_dt = ts_dt.replace(tzinfo=timezone.utc)
            epoch = int(ts_dt.timestamp())
            utc_iso = ts_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
            alt_val = 0 if alt is None or pd.isna(alt) else int(round(float(alt)))
            gs_val = 0 if gs is None or pd.isna(gs) else int(round(float(gs)))
            trk_val = int(round(float(trk))) % 360
            f.write(
                f"{epoch},{utc_iso},{callsign},"
                f"{geom.y:.6f},{geom.x:.6f},"
                f"{alt_val},{gs_val},{trk_val}\n"
            )
