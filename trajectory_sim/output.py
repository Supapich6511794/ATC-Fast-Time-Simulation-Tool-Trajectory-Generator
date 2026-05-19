"""Write trajectory data to GeoPackage and CSV.

Stitches per-leg interpolations from geodesy.interpolate_great_circle
into a single GeoDataFrame matching the sim_output.gpkg schema, then
writes to disk.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path

import geopandas as gpd
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

    Overwrites the layer if it already exists.

    Args:
        gdf: GeoDataFrame as built by build_trajectory_gdf.
        path: Output .gpkg filesystem path.
        layer: Layer name within the GeoPackage (default "trajectory").
    """
    gdf.to_file(Path(path), layer=layer, driver="GPKG")


def write_csv(gdf: gpd.GeoDataFrame, path: str | Path) -> None:
    """Write a trajectory GeoDataFrame to CSV.

    The geometry column is dropped and replaced with separate `lat`
    (degrees) and `lon` (degrees) columns.

    Args:
        gdf: GeoDataFrame as built by build_trajectory_gdf.
        path: Output .csv filesystem path.
    """
    df = gdf.drop(columns="geometry").copy()
    df["lat"] = gdf.geometry.y.to_numpy()
    df["lon"] = gdf.geometry.x.to_numpy()
    df.to_csv(Path(path), index=False)
