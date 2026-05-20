"""Geodesic helpers for great-circle interpolation, bearing, and distance.

All calculations use the WGS-84 ellipsoid via pyproj.Geod. No flat-earth
approximations. Distances in nautical miles (NM); angles in degrees;
times in seconds.

Pure functions only — no I/O, no module-level state beyond the shared
pyproj.Geod instance.
"""

from __future__ import annotations

import pyproj

# 1 NM = 1852 m exactly; 1 kt = 1 NM/hr = 1852/3600 m/s
_M_PER_NM = 1852.0
_KT_TO_MS = _M_PER_NM / 3600.0

_GEOD = pyproj.Geod(ellps="WGS84")


def haversine_distance(
    lat1: float, lon1: float, lat2: float, lon2: float
) -> float:
    """Great-circle distance between two WGS-84 points.

    Despite the name, this is a true ellipsoidal geodesic via
    pyproj.Geod.inv — not the spherical haversine formula.

    Args:
        lat1, lon1: Start point in decimal degrees.
        lat2, lon2: End point in decimal degrees.

    Returns:
        Geodesic distance in nautical miles (NM).
    """
    _, _, distance_m = _GEOD.inv(lon1, lat1, lon2, lat2)
    return distance_m / _M_PER_NM


def route_distance_nm(
    waypoint_sequence: list[tuple[float, float]],
) -> float:
    """Total geodesic length of a (lat, lon) route, in nautical miles."""
    return sum(
        haversine_distance(
            waypoint_sequence[i][0], waypoint_sequence[i][1],
            waypoint_sequence[i + 1][0], waypoint_sequence[i + 1][1],
        )
        for i in range(len(waypoint_sequence) - 1)
    )


def compute_bearing(
    lat1: float, lon1: float, lat2: float, lon2: float
) -> float:
    """Initial true bearing from (lat1, lon1) to (lat2, lon2).

    Args:
        lat1, lon1: Start point in decimal degrees.
        lat2, lon2: End point in decimal degrees.

    Returns:
        Initial bearing in degrees true, normalized to [0, 360).
    """
    fwd_az, _, _ = _GEOD.inv(lon1, lat1, lon2, lat2)
    return fwd_az % 360.0


def interpolate_great_circle(
    lat1: float,
    lon1: float,
    lat2: float,
    lon2: float,
    ground_speed_kt: float = 450.0,
    time_step_s: float = 1.0,
    output_every_s: float = 4.0,
) -> list[dict[str, float]]:
    """Interpolate points along the WGS-84 geodesic between two points.

    The leg is conceptually stepped at `time_step_s` (1 s by default,
    matching the integration cadence Phase 3 will need for variable
    speeds). Points are emitted every `output_every_s` (4 s — CAT62
    cadence). The exact endpoint is always emitted, even if it doesn't
    fall on the output grid.

    Args:
        lat1, lon1: Leg start point in decimal degrees.
        lat2, lon2: Leg end point in decimal degrees.
        ground_speed_kt: Constant ground speed in knots (Phase 1
            placeholder of 450 kt).
        time_step_s: Internal integration step in seconds.
        output_every_s: Emit one point every N seconds of elapsed time.

    Returns:
        Ordered list of dicts: {"lat": deg, "lon": deg,
        "elapsed_s": seconds since leg start}. First entry is the start
        point at t=0; last entry is the exact endpoint.
    """
    fwd_az, _, total_distance_m = _GEOD.inv(lon1, lat1, lon2, lat2)
    gs_ms = ground_speed_kt * _KT_TO_MS
    total_time_s = total_distance_m / gs_ms if gs_ms > 0 else 0.0

    output_every_steps = max(1, round(output_every_s / time_step_s))
    points: list[dict[str, float]] = []

    step_idx = 0
    while True:
        t = step_idx * time_step_s
        if t >= total_time_s:
            break
        if step_idx % output_every_steps == 0:
            if step_idx == 0:
                lat, lon = lat1, lon1
            else:
                lon, lat, _ = _GEOD.fwd(lon1, lat1, fwd_az, t * gs_ms)
            points.append({"lat": lat, "lon": lon, "elapsed_s": t})
        step_idx += 1

    # Always end on the exact endpoint so the trajectory passes through
    # the named waypoint. If the endpoint is within 1 ms of the previous
    # grid point, *replace* that point instead of appending — GeoPackage
    # stores timestamps at millisecond precision, so two emissions inside
    # the same 1-ms slot would collide in the (flight_key, epoch_ts) PK
    # downstream.
    _DT_PRECISION_S = 1e-3
    if not points:
        points.append({"lat": lat2, "lon": lon2, "elapsed_s": total_time_s})
    elif points[-1]["elapsed_s"] < total_time_s - _DT_PRECISION_S:
        points.append({"lat": lat2, "lon": lon2, "elapsed_s": total_time_s})
    elif points[-1]["elapsed_s"] < total_time_s:
        points[-1] = {"lat": lat2, "lon": lon2, "elapsed_s": total_time_s}

    return points
