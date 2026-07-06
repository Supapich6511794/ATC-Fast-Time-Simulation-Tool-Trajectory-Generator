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
    cas_to_tas_kt,
    field_elevation_ft,
    mach_to_tas_kt,
    aircraft_speeds,
    target_tas_kt,
)

_GEOD = pyproj.Geod(ellps="WGS84")
_M_PER_NM = 1852.0

#: How far before a descent fix (NM) a procedure speed limit starts slowing the
#: aircraft, so it crosses the fix already at/under the limit.
_SPD_LEAD_NM = 40.0


@dataclass(frozen=True)
class RouteConstraint:
    """A SID/STAR crossing restriction, mapped to its along-track distance.

    Built by the server from the spliced procedure legs (see
    ``_route_constraints``). ``phase`` is "climb" for a SID fix, "descent" for
    a STAR fix — it sets which side of the fix the altitude/speed limit shapes.
    """

    distance_nm: float
    phase: Phase  # "climb" | "descent"
    # Altitude bounds in feet (None = unbounded that side).
    alt_floor_ft: float | None = None
    alt_ceil_ft: float | None = None
    # Procedure speed limit (CAS kt; AT / AT-or-below only — an upper cap).
    spd_max_kt: float | None = None


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
    constraints: "Optional[list[RouteConstraint]]" = None,
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
    # The corrected (longer) total time can lift the length-capped cruise
    # altitude, so refresh it from the rebuilt profile — the constraint envelope
    # below (TOD anchor, gradients) must match the altitude ``profile.at()``
    # actually flies, or the descent would step down at top-of-descent.
    cruise_alt = profile.cruise_alt_ft

    # --- Procedure crossing restrictions (Phase 4) -----------------------
    # Shape the BADA altitude/speed profile to the SID/STAR constraints. When
    # there are none this is a no-op, so the engine's default output is
    # unchanged. Altitude is clamped into a per-distance [floor, ceiling]
    # envelope; a descent ceiling rises backward along the descent gradient so
    # the aircraft starts down early enough (i.e. TOD is pulled in), a climb
    # ceiling holds the climb until the fix is passed. Conflicts resolve in
    # favour of the ceiling (don't bust an at-or-below). Speed caps the TAS to
    # the procedure CAS limit (+ the existing 250/FL100 already in the BADA
    # speed). See `RouteConstraint`.
    cons = constraints or []
    g_climb = cruise_alt / max(climb_distance_nm, 1.0)
    g_desc = cruise_alt / max(descent_distance_nm, 1.0)

    # Top of Descent for a STAR is anchored per descent crossing restriction,
    # following the planning rule applied to each one:
    #     anchor = constraint_distance − (cruise_alt − constraint_alt)
    #               ÷ descent_gradient
    # Each restriction holds cruise until its own anchor, then its ceiling falls
    # backward along the descent gradient — so every backward line starts at
    # exactly cruise altitude at its anchor (no step). The lowest/earliest one
    # binds, so the descent begins at the first fix that requires it and still
    # meets every later, lower fix via the clamp below. See ``_alt_bounds``.

    def _bada_alt_at_dist(d: float) -> float:
        """Unconstrained BADA altitude (ft) at along-track distance ``d`` (NM)."""
        if d <= climb_distance_nm:
            t = d * 3600.0 / climb_gs
        elif d <= climb_distance_nm + cruise_distance_nm:
            t = climb_time_s + (d - climb_distance_nm) * 3600.0 / cruise_gs
        else:
            t = (
                climb_time_s
                + cruise_time_s
                + (d - climb_distance_nm - cruise_distance_nm) * 3600.0 / descent_gs
            )
        return profile.at(t)[0]

    # Local BADA vertical gradient (ft/NM) at each crossing fix. When a
    # restriction releases, the climb/descent resumes *from the held altitude*
    # at this real (steep, near-fix) rate and so catches up to and rejoins the
    # BADA curve — instead of snapping straight up/down to it (a vertical step).
    # Floored at the phase average so a fix sitting in a level segment still
    # releases on a sane slope.
    _grad_at_fix: dict[RouteConstraint, float] = {}
    for _c in cons:
        _near = _bada_alt_at_dist(min(total_distance_nm, _c.distance_nm + 1.0))
        _far = _bada_alt_at_dist(max(0.0, _c.distance_nm - 1.0))
        _g = abs(_near - _far) / 2.0
        _grad_at_fix[_c] = max(_g, g_climb if _c.phase == "climb" else g_desc)

    def _alt_bounds(d: float) -> tuple[float, float]:
        floor = 0.0
        ceil = float("inf")
        for c in cons:
            if c.alt_ceil_ft is not None:
                if c.phase == "descent":
                    # Hold cruise until this restriction's own TOD anchor, then
                    # let its ceiling fall backward along the descent gradient
                    # (the line meets cruise exactly at the anchor → no step).
                    anchor = c.distance_nm - (cruise_alt - c.alt_ceil_ft) / g_desc
                    if d < anchor:
                        v = float("inf")  # before this fix's TOD: hold cruise
                    elif d <= c.distance_nm:
                        v = c.alt_ceil_ft + g_desc * (c.distance_nm - d)
                    else:
                        v = c.alt_ceil_ft
                else:  # climb: hold ≤ ceiling to the fix, then climb on from it
                    # Past the fix the cap rises at the fix's real BADA rate, so
                    # the aircraft resumes climbing *from* the held altitude and
                    # rejoins the BADA curve (no vertical step on release).
                    v = (
                        c.alt_ceil_ft
                        if d <= c.distance_nm
                        else c.alt_ceil_ft + _grad_at_fix[c] * (d - c.distance_nm)
                    )
                ceil = min(ceil, v)
            if c.alt_floor_ft is not None:
                if c.phase == "climb":
                    # Straight line from field level at departure (d=0 → 0) up to
                    # the floor at the fix, so the floor lifts the climb AT the
                    # fix but NEVER pins the START above field elevation. Any
                    # fixed backward gradient (the shallow g_climb, or even the
                    # steep near-fix rate) can stay positive all the way back to
                    # d=0 for a high or near-departure "at or above" fix and pin
                    # the start at thousands of feet. Anchoring the ramp at the
                    # departure guarantees it reaches 0 there. Past the fix the
                    # floor RELEASES at the fix's real climb rate — holding it
                    # flat would keep the minimum in force through cruise and
                    # descent and stop the aircraft descending below it (a
                    # flight that "landed" at FL130 because a SID said ≥13000).
                    if c.distance_nm <= 0.0:
                        v = 0.0  # a floor AT the departure fix can't pin the ground
                    elif d <= c.distance_nm:
                        v = c.alt_floor_ft * (d / c.distance_nm)
                    else:
                        v = max(
                            0.0,
                            c.alt_floor_ft - _grad_at_fix[c] * (d - c.distance_nm),
                        )
                else:  # descent: stay ≥ floor from this fix's TOD anchor to the
                    # fix, then descend on from it. WITHOUT the anchor the floor
                    # would apply backward across the whole climb + cruise and,
                    # where a SID's low ceiling near departure conflicts, pin the
                    # start at that ceiling (a flight that began at 6000 ft, not
                    # its field elevation). Mirrors the descent-ceiling anchor
                    # above: the floor rises backward along the descent gradient
                    # and meets cruise exactly at the anchor (no step), and does
                    # not bind before it (climb/cruise stay free).
                    anchor = c.distance_nm - (cruise_alt - c.alt_floor_ft) / g_desc
                    if d < anchor:
                        v = 0.0  # before this fix's TOD: no floor
                    elif d <= c.distance_nm:
                        v = c.alt_floor_ft + g_desc * (c.distance_nm - d)
                    else:
                        v = max(0.0, c.alt_floor_ft - _grad_at_fix[c] * (d - c.distance_nm))
                floor = max(floor, v)
        return floor, ceil

    def _spd_cap(d: float) -> float:
        cap = float("inf")
        for c in cons:
            if c.spd_max_kt is None:
                continue
            if c.phase == "descent" and d >= c.distance_nm - _SPD_LEAD_NM:
                cap = min(cap, c.spd_max_kt)
            elif c.phase == "climb" and d <= c.distance_nm:
                cap = min(cap, c.spd_max_kt)
        return cap

    def _shape(alt: float, tas: float, dist_nm: float) -> tuple[float, float]:
        """Clamp one sample's altitude + TAS to the constraints (no-op when
        there are none). Ceiling wins over floor on conflict."""
        if cons:
            floor, ceil = _alt_bounds(dist_nm)
            alt = min(ceil, max(floor, alt))
            cap_cas = _spd_cap(dist_nm)
            if cap_cas != float("inf"):
                tas = min(tas, cas_to_tas_kt(cap_cas, alt))
        return alt, tas

    def _phase_for(alt: float, prev_alt: float | None, default: Phase) -> Phase:
        """Re-derive phase from the (possibly clamped) altitude trend: a
        constraint that makes the path rise/fall against BADA is reflected,
        but a level-off keeps the BADA phase — so a climb/descent restriction
        that briefly levels the aircraft is NOT mislabelled cruise (which would
        corrupt the top-of-climb / top-of-descent detection)."""
        if not cons or prev_alt is None:
            return default
        if alt > prev_alt + 1.0:
            return "climb"
        if alt < prev_alt - 1.0:
            return "descent"
        return default

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
        alt, tas = _shape(alt, tas, dist_nm)
        phase = _phase_for(
            alt, samples[-1].altitude_ft if samples else None, phase
        )
        gs = max(60.0, tas - wind)

        samples.append(TimelineSample(
            elapsed_s=t,
            epoch_ts=eobt + timedelta(seconds=t),
            lat=lat,
            lon=lon,
            altitude_ft=round(alt, 1),
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
        alt, tas = _shape(alt, tas, total_distance_nm)
        phase = _phase_for(
            alt, samples[-1].altitude_ft if samples else None, phase
        )
        gs = max(60.0, tas - wind)
        samples.append(TimelineSample(
            elapsed_s=total_time_s,
            epoch_ts=eobt + timedelta(seconds=total_time_s),
            lat=lat,
            lon=lon,
            altitude_ft=round(alt, 1),
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
