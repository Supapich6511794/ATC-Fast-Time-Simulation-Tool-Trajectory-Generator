"""Tests for the SID departure ground track (:func:`expand_sid_departure`).

The Thai DFD data codes a SID's initial climb as a fixless course-to-altitude
leg ("209° to 1 500 ft, MAX IAS 200 KT") and starts its fixes at the runway
END, so an unexpanded SID has the aircraft turning for the first en-route fix
the moment it lifts — cutting diagonally back across the runway it just left.
These pin the expansion that restores the published geometry: roll from the
threshold, hold runway heading until the altitude is made, only then turn.

Modelled on VTBD OLVU3C from RW21L (AIP: track 209°, 1 500 ft, MAX IAS 200 KT,
then direct INTOS).
"""

from __future__ import annotations

import pytest

from trajectory_sim.geodesy import compute_bearing, haversine_distance
from trajectory_sim.navdata import (
    AltitudeConstraint,
    AltitudeConstraintType,
    Procedure,
    ProcedureLeg,
    ProcedureType,
    RunwayEnd,
    SpeedConstraint,
    SpeedConstraintType,
    expand_sid_departure,
)

# VTBD RW21L, from the ARINC runway table.
_RW21L = RunwayEnd(
    icao="VTBD",
    ident="RW21L",
    lat=13.92455833,
    lon=100.61554444,
    magnetic_bearing=208.7,
    true_bearing=208.568,
)
# Departure end of RW21L (the SID's first coded fix) and the first en-route fix.
_DE21L = (13.89956944, 100.60152778)
_INTOS = (13.97182, 100.32976)

_CLIMB_TO_1500_NM = 4.8  # what the B738 climb model gives from a sea-level field


def _climb_distance_nm(alt_ft: float) -> float:
    """Stub of ``performance.climb_distance_nm`` bound to a B738 at VTBD."""
    return _CLIMB_TO_1500_NM * alt_ft / 1500.0


def _leg(
    seqno: int,
    path_terminator: str,
    ident: str | None = None,
    lat: float | None = None,
    lon: float | None = None,
    *,
    course: float | None = None,
    alt_ft: float | None = None,
    speed_kt: float | None = None,
) -> ProcedureLeg:
    return ProcedureLeg(
        seqno=seqno,
        path_terminator=path_terminator,
        ident=ident,
        lat=lat,
        lon=lon,
        altitude=(
            AltitudeConstraint(AltitudeConstraintType.AT_OR_ABOVE, alt_ft)
            if alt_ft is not None
            else AltitudeConstraint()
        ),
        speed=(
            SpeedConstraint(SpeedConstraintType.AT_OR_BELOW, speed_kt)
            if speed_kt is not None
            else SpeedConstraint()
        ),
        transition="RW21L",
        magnetic_course=course,
    )


def _olvu3c() -> Procedure:
    """VTBD OLVU3C off RW21L: runway end, climb to 1 500 ft, then direct INTOS."""
    return Procedure(
        airport="VTBD",
        name="OLVU3C",
        proc_type=ProcedureType.SID,
        runway="RW21L",
        transition=None,
        legs=(
            _leg(10, "DF", "DE21L", *_DE21L),
            _leg(20, "CA", course=209.0, alt_ft=1500, speed_kt=200),
            _leg(30, "DF", "INTOS", *_INTOS),
        ),
    )


def _expanded() -> Procedure:
    return expand_sid_departure(_olvu3c(), _RW21L, _climb_distance_nm)


def test_departure_starts_on_the_runway_threshold() -> None:
    """The take-off roll begins at the threshold, not at the runway end."""
    first = _expanded().waypoints()[0]
    assert first.ident == "RW21L"
    assert (first.lat, first.lon) == pytest.approx((_RW21L.lat, _RW21L.lon))


def test_course_to_altitude_leg_becomes_a_fix_on_the_runway_track() -> None:
    """The fixless CA leg is placed on the runway heading, so the aircraft flies
    the centreline out instead of turning at the runway end."""
    wpts = _expanded().waypoints()
    assert [w.ident for w in wpts] == ["RW21L", "DE21L", "(1500)", "INTOS"]

    ca = wpts[2]
    # Published course is magnetic; the runway's own bearings give the variation.
    bearing = compute_bearing(_DE21L[0], _DE21L[1], ca.lat, ca.lon)
    assert bearing == pytest.approx(209.0 + _RW21L.magnetic_variation, abs=0.1)
    # It lies on the runway track, beyond the runway end — not back across it.
    assert compute_bearing(
        _RW21L.lat, _RW21L.lon, ca.lat, ca.lon
    ) == pytest.approx(_RW21L.true_bearing, abs=0.5)


def test_course_to_altitude_fix_sits_where_the_climb_makes_the_altitude() -> None:
    """Placed at the climb model's distance-to-1 500 ft *from the threshold*, so
    the aircraft genuinely crosses it at 1 500 ft and the vertical profile has
    no restriction to bend (it neither lifts early nor sinks back after)."""
    ca = _expanded().waypoints()[2]
    from_thr_nm = haversine_distance(_RW21L.lat, _RW21L.lon, ca.lat, ca.lon)
    assert from_thr_nm == pytest.approx(_CLIMB_TO_1500_NM, abs=0.05)


def test_course_to_altitude_leg_keeps_its_restrictions() -> None:
    """The leg's "at or above 1 500 ft" / "MAX IAS 200 KT" now reach the profile
    — before, they were discarded along with the fixless leg."""
    ca = next(lg for lg in _expanded().legs if lg.ident == "(1500)")
    assert ca.has_fix
    assert ca.altitude.alt1_ft == 1500
    assert ca.speed.speed_kt == 200


def test_altitude_leg_never_collapses_onto_the_previous_fix() -> None:
    """A climb that has already made the altitude by the runway end still flies a
    minimum straight-out leg — the turn must not happen over the runway."""
    proc = expand_sid_departure(_olvu3c(), _RW21L, lambda _alt_ft: 0.1)
    wpts = proc.waypoints()
    assert haversine_distance(
        _DE21L[0], _DE21L[1], wpts[2].lat, wpts[2].lon
    ) == pytest.approx(0.5, abs=0.01)


def test_unknown_runway_leaves_the_procedure_untouched() -> None:
    """An ARINC "both" group (RW21B) names no single threshold — the SID is
    flown as published rather than anchored to a guessed runway."""
    proc = _olvu3c()
    assert expand_sid_departure(proc, None, _climb_distance_nm) is proc


def test_a_star_is_not_a_departure() -> None:
    arrival = Procedure(
        airport="VTBD",
        name="MARN2B",
        proc_type=ProcedureType.STAR,
        runway="RW21L",
        transition=None,
        legs=(_leg(10, "TF", "INTOS", *_INTOS),),
    )
    assert expand_sid_departure(arrival, _RW21L, _climb_distance_nm) is arrival
