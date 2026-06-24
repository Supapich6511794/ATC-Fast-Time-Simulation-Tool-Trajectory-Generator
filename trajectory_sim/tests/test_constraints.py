"""Phase 4 — SID/STAR crossing restrictions shaping the timeline.

Verifies that procedure altitude/speed constraints clamp the BADA profile,
that with no constraints the output is unchanged (backward-compatible), and
that the server maps each constrained leg to its along-track distance.
"""

from __future__ import annotations

from datetime import datetime, timezone

from trajectory_sim.geodesy import haversine_distance
from trajectory_sim.trajectory import RouteConstraint, build_flight_timeline

_EOBT = datetime(2026, 6, 20, tzinfo=timezone.utc)
# ~200 NM leg, north -> Bangkok, so the flight climbs, cruises and descends.
_ROUTE = [(18.0, 99.0), (15.0, 100.6)]
_TOTAL_NM = haversine_distance(_ROUTE[0][0], _ROUTE[0][1], _ROUTE[1][0], _ROUTE[1][1])


def _build(constraints=None):
    return build_flight_timeline(
        _ROUTE, "B738", "VTCC", "VTBD", 35000.0, _EOBT, constraints=constraints
    )


def _alt_at_nm(tl, target_nm: float) -> float:
    """Altitude of the sample nearest a given along-track distance."""
    best = None
    for s in tl.samples:
        d = _TOTAL_NM * (s.elapsed_s / tl.total_time_s)
        if best is None or abs(d - target_nm) < best[0]:
            best = (abs(d - target_nm), s.altitude_ft)
    return best[1]


def test_no_constraints_unchanged() -> None:
    """No constraints ⇒ identical samples to the default engine output."""
    a = _build(None)
    b = _build([])
    assert [s.altitude_ft for s in a.samples] == [s.altitude_ft for s in b.samples]
    assert [s.tas_kt for s in a.samples] == [s.tas_kt for s in b.samples]


def test_at_or_below_caps_descent() -> None:
    base = _alt_at_nm(_build(None), 150.0)
    capped = _alt_at_nm(
        _build([RouteConstraint(150.0, "descent", alt_ceil_ft=8000.0)]), 150.0
    )
    assert base > 8000.0  # the unconstrained profile is higher here
    assert capped <= 8000.0 + 1.0  # the constraint pulled it down to the cap


def test_at_or_above_floors_climb() -> None:
    # Force a high floor at 60 NM; the constrained climb must be at/above it.
    capped = _alt_at_nm(
        _build([RouteConstraint(60.0, "climb", alt_floor_ft=20000.0)]), 60.0
    )
    assert capped >= 20000.0 - 1.0


def test_speed_cap_applies() -> None:
    con = [RouteConstraint(150.0, "descent", alt_ceil_ft=9000.0, spd_max_kt=230.0)]
    tl = _build(con)
    # Around the fix the TAS must honour the 230 kt CAS cap (TAS ≥ CAS, but the
    # cap keeps it well under the unconstrained descent speed).
    near = [
        s.tas_kt
        for s in tl.samples
        if abs(_TOTAL_NM * (s.elapsed_s / tl.total_time_s) - 150.0) < 8.0
    ]
    assert near and max(near) < 300.0


# A long route so the flight reaches cruise and top-of-descent lands well inside
# it — that's where the descent-ceiling envelope used to step down.
_LONG_ROUTE = [(20.0, 99.0), (13.8, 100.6)]
_LONG_NM = haversine_distance(
    _LONG_ROUTE[0][0], _LONG_ROUTE[0][1], _LONG_ROUTE[1][0], _LONG_ROUTE[1][1]
)


def _max_step_ft(tl) -> float:
    """Largest altitude change between consecutive samples."""
    return max(
        (
            abs(tl.samples[i].altitude_ft - tl.samples[i - 1].altitude_ft)
            for i in range(1, len(tl.samples))
        ),
        default=0.0,
    )


def test_descent_ceiling_has_no_vertical_step() -> None:
    """A descent ceiling far below cruise must shape a *continuous* descent: the
    profile may not teleport down at top-of-descent. Regression for the stale
    ``cruise_alt`` (kept from the bootstrap profile) that anchored the TOD on the
    wrong cruise altitude and snapped the path down when the restriction engaged.
    """
    base_step = _max_step_ft(
        build_flight_timeline(
            _LONG_ROUTE, "B738", "VTCC", "VTSP", 35000.0, _EOBT,
            constraints=[], output_every_s=10.0,
        )
    )
    con = [RouteConstraint(_LONG_NM - 60.0, "descent", alt_ceil_ft=11000.0)]
    shaped = build_flight_timeline(
        _LONG_ROUTE, "B738", "VTCC", "VTSP", 35000.0, _EOBT,
        constraints=con, output_every_s=10.0,
    )
    # The constrained profile should be no more "steppy" than the unconstrained
    # one (allow a small margin for the steeper-but-smooth shaped descent).
    assert _max_step_ft(shaped) <= base_step + 400.0


def test_climb_ceiling_release_is_continuous() -> None:
    """After an at-or-below climb ceiling releases past its fix, the climb must
    resume *from* the held altitude (no upward teleport to the BADA curve)."""
    con = [RouteConstraint(20.0, "climb", alt_ceil_ft=6000.0)]
    shaped = build_flight_timeline(
        _LONG_ROUTE, "B738", "VTCC", "VTSP", 35000.0, _EOBT,
        constraints=con, output_every_s=10.0,
    )
    assert _max_step_ft(shaped) < 1500.0
