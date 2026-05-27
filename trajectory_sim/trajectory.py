"""Phase 3 — variable-speed flight timeline.

Stitches together the Phase 1 horizontal great-circle and the Phase 2
vertical profile into a per-second-accurate 4D timeline, replacing the
Phase 1 constant-ground-speed timing.

Three speed bands run end-to-end:

  * **Climb**   — time-weighted average TAS over the BADA climb
    schedule. Honours the 250 kt CAS restriction below FL100 and the
    CAS→Mach crossover above the crossover altitude.
  * **Cruise**  — constant cruise Mach (converted to TAS at the cruise
    altitude).
  * **Descent** — same logic as climb, in reverse.

Each emitted sample carries its own ``tas_kt`` and ``gs_kt``. With the
default zero-wind model, ``gs_kt == tas_kt``; a wind layer can be slotted
in later by feeding a ``WindModel`` into :func:`build_flight_timeline`.

UTC timestamps are assigned by adding the elapsed seconds-from-EOBT to
the supplied ``eobt`` (which must already be timezone-aware UTC).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Optional

import pyproj

from trajectory_sim.geodesy import haversine_distance
from trajectory_sim.performance import (
    Phase,
    VerticalProfile,
    average_phase_tas_kt,
    field_elevation_ft,
    mach_to_tas_kt,
    aircraft_speeds,
    target_tas_kt,
)

_GEOD = pyproj.Geod(ellps="WGS84")
_M_PER_NM = 1852.0


@dataclass(frozen=True)
class TimelineSample:
    """One emitted 4D point along the trajectory."""

    elapsed_s: float
    epoch_ts: datetime
    lat: float
    lon: float
    altitude_ft: float
    phase: Phase
    tas_kt: float
    gs_kt: float
    track_deg: float


@dataclass(frozen=True)
class FlightTimeline:
    """Full variable-speed timeline for one flight.

    The horizontal route is sliced into 3 logical phases each with a
    constant *average* ground speed; the vertical profile (built with
    the right total_time_s) supplies altitude + phase per sample.
    """

    waypoints: list[tuple[float, float]]
    profile: VerticalProfile
    total_distance_nm: float
    climb_distance_nm: float
    cruise_distance_nm: float
    descent_distance_nm: float
    climb_avg_tas_kt: float
    cruise_tas_kt: float
    descent_avg_tas_kt: float
    samples: list[TimelineSample]

    @property
    def total_time_s(self) -> float:
        return self.profile.total_time_s


def _leg_distances_nm(
    waypoints: list[tuple[float, float]],
) -> list[float]:
    return [
        haversine_distance(
            waypoints[i][0], waypoints[i][1],
            waypoints[i + 1][0], waypoints[i + 1][1],
        )
        for i in range(len(waypoints) - 1)
    ]


def _locate_along_route(
    waypoints: list[tuple[float, float]],
    leg_distances_nm: list[float],
    distance_nm: float,
) -> tuple[float, float, float]:
    """Find (lat, lon, track_deg) at a given along-track distance.

    Walks the leg list to find which great-circle segment the distance
    falls in, then asks pyproj to step that segment forward by the
    residual distance.
    """
    if distance_nm <= 0:
        lat0, lon0 = waypoints[0]
        lat1, lon1 = waypoints[1]
        fwd_az, _, _ = _GEOD.inv(lon0, lat0, lon1, lat1)
        return lat0, lon0, fwd_az % 360.0

    total = sum(leg_distances_nm)
    if distance_nm >= total:
        # Past the last waypoint — return the endpoint with the inbound
        # track of the final leg.
        lat_a, lon_a = waypoints[-2]
        lat_b, lon_b = waypoints[-1]
        fwd_az, _, _ = _GEOD.inv(lon_a, lat_a, lon_b, lat_b)
        return lat_b, lon_b, fwd_az % 360.0

    consumed = 0.0
    for i, leg_nm in enumerate(leg_distances_nm):
        if distance_nm <= consumed + leg_nm:
            residual_nm = distance_nm - consumed
            lat_a, lon_a = waypoints[i]
            lat_b, lon_b = waypoints[i + 1]
            fwd_az, _, _ = _GEOD.inv(lon_a, lat_a, lon_b, lat_b)
            lon, lat, _ = _GEOD.fwd(
                lon_a, lat_a, fwd_az, residual_nm * _M_PER_NM
            )
            return lat, lon, fwd_az % 360.0
        consumed += leg_nm

    # Safety net — should be unreachable given the early return above.
    lat_b, lon_b = waypoints[-1]
    return lat_b, lon_b, 0.0


def build_flight_timeline(
    waypoint_sequence: list[tuple[float, float]],
    aircraft_type: str,
    adep: str,
    ades: str,
    rfl_ft: float,
    eobt: datetime,
    output_every_s: float = 4.0,
    wind_kt: Optional[float] = None,
) -> FlightTimeline:
    """Construct a variable-speed flight timeline from EOBT.

    Args:
        waypoint_sequence: Ordered (lat, lon) waypoints, ADEP at index 0,
            ADES at index -1. Must have ≥ 2 points.
        aircraft_type: ICAO type designator (e.g. ``"B738"``).
        adep, ades: ICAO codes for ADEP / ADES; used to look up field
            elevations.
        rfl_ft: Requested flight level in feet (e.g. 35 000 for FL350).
        eobt: Estimated Off-Block Time, timezone-aware UTC.
        output_every_s: Sampling cadence in seconds (default 4 s — the
            CAT62 surveillance rate).
        wind_kt: Optional **head-wind** component along the route, in
            knots. None ⇒ zero-wind (GS = TAS).

    Returns:
        A :class:`FlightTimeline` whose ``samples`` list carries one
        :class:`TimelineSample` per emitted point.
    """
    if len(waypoint_sequence) < 2:
        raise ValueError("waypoint_sequence must contain at least 2 points")

    leg_distances = _leg_distances_nm(waypoint_sequence)
    total_distance_nm = sum(leg_distances)

    dep_elev = field_elevation_ft(adep)
    des_elev = field_elevation_ft(ades)

    # Use cruise TAS as the first guess for total_time_s — only used to
    # bootstrap VerticalProfile.build, which itself caps cruise_alt to
    # the airframe's ceiling and to a length-of-flight envelope.
    cruise_tas_at_rfl = mach_to_tas_kt(
        aircraft_speeds(aircraft_type).cruise_mach, rfl_ft
    )
    rough_total_s = total_distance_nm / max(cruise_tas_at_rfl, 1.0) * 3600.0

    profile = VerticalProfile.build(
        total_time_s=rough_total_s,
        rfl_ft=rfl_ft,
        aircraft_type=aircraft_type,
        dep_elev_ft=dep_elev,
        des_elev_ft=des_elev,
    )
    cruise_alt = profile.cruise_alt_ft
    climb_time_s = profile.toc_time_s
    descent_time_s = rough_total_s - profile.tod_time_s

    # Phase-average ground speeds. Wind (head-wind only, optional) is
    # applied uniformly to all phases — refining to per-altitude wind
    # would need a real wind grid.
    climb_avg_tas = average_phase_tas_kt(
        aircraft_type, dep_elev, cruise_alt, "climb"
    )
    cruise_tas = mach_to_tas_kt(
        aircraft_speeds(aircraft_type).cruise_mach, cruise_alt
    )
    descent_avg_tas = average_phase_tas_kt(
        aircraft_type, des_elev, cruise_alt, "descent"
    )

    wind = wind_kt or 0.0
    climb_gs = max(60.0, climb_avg_tas - wind)
    cruise_gs = max(60.0, cruise_tas - wind)
    descent_gs = max(60.0, descent_avg_tas - wind)

    climb_distance_nm = climb_gs * climb_time_s / 3600.0
    descent_distance_nm = descent_gs * descent_time_s / 3600.0
    cruise_distance_nm = max(
        0.0, total_distance_nm - climb_distance_nm - descent_distance_nm
    )
    cruise_time_s = (cruise_distance_nm / cruise_gs) * 3600.0
    total_time_s = climb_time_s + cruise_time_s + descent_time_s

    # Rebuild the vertical profile with the *corrected* total time so
    # ``profile.at()`` returns the right phase at every sample.
    profile = VerticalProfile.build(
        total_time_s=total_time_s,
        rfl_ft=rfl_ft,
        aircraft_type=aircraft_type,
        dep_elev_ft=dep_elev,
        des_elev_ft=des_elev,
    )

    # Sample every `output_every_s`. Always emit the exact endpoint so
    # the trajectory finishes at ADES regardless of step alignment.
    samples: list[TimelineSample] = []
    t = 0.0
    while t < total_time_s:
        alt, phase = profile.at(t)
        if t <= climb_time_s:
            dist_nm = climb_gs * t / 3600.0
        elif t <= climb_time_s + cruise_time_s:
            dist_nm = (
                climb_distance_nm
                + cruise_gs * (t - climb_time_s) / 3600.0
            )
        else:
            dist_nm = (
                climb_distance_nm
                + cruise_distance_nm
                + descent_gs
                * (t - climb_time_s - cruise_time_s)
                / 3600.0
            )

        lat, lon, track = _locate_along_route(
            waypoint_sequence, leg_distances, dist_nm
        )
        tas = target_tas_kt(aircraft_type, alt, phase)
        gs = max(60.0, tas - wind)

        samples.append(TimelineSample(
            elapsed_s=t,
            epoch_ts=eobt + timedelta(seconds=t),
            lat=lat,
            lon=lon,
            altitude_ft=alt,
            phase=phase,
            tas_kt=tas,
            gs_kt=gs,
            track_deg=track,
        ))
        t += output_every_s

    # Final exact endpoint — ADES at total_time_s.
    if not samples or samples[-1].elapsed_s < total_time_s - 1e-6:
        alt, phase = profile.at(total_time_s)
        lat, lon, track = _locate_along_route(
            waypoint_sequence, leg_distances, total_distance_nm
        )
        tas = target_tas_kt(aircraft_type, alt, phase)
        gs = max(60.0, tas - wind)
        samples.append(TimelineSample(
            elapsed_s=total_time_s,
            epoch_ts=eobt + timedelta(seconds=total_time_s),
            lat=lat,
            lon=lon,
            altitude_ft=alt,
            phase=phase,
            tas_kt=tas,
            gs_kt=gs,
            track_deg=track,
        ))

    return FlightTimeline(
        waypoints=list(waypoint_sequence),
        profile=profile,
        total_distance_nm=total_distance_nm,
        climb_distance_nm=climb_distance_nm,
        cruise_distance_nm=cruise_distance_nm,
        descent_distance_nm=descent_distance_nm,
        climb_avg_tas_kt=climb_avg_tas,
        cruise_tas_kt=cruise_tas,
        descent_avg_tas_kt=descent_avg_tas,
        samples=samples,
    )
