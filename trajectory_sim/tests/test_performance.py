"""Tests for performance.py (Phase 2 vertical profile)."""

from __future__ import annotations

from datetime import datetime, timezone

from trajectory_sim.output import build_trajectory_gdf
from trajectory_sim.performance import (
    VerticalProfile,
    aircraft_roc_rod,
    field_elevation_ft,
)

_WAYPOINTS = [
    (13.6811, 100.7470),  # near VTBS
    (11.0, 100.0),
    (8.1132, 98.3170),    # near VTSP
]
_EOBT = datetime(2026, 1, 3, 8, 15, tzinfo=timezone.utc)


def test_roc_rod_within_brief_envelope() -> None:
    roc, rod = aircraft_roc_rod("B738")
    assert 1500.0 <= roc <= 2500.0
    assert 1500.0 <= rod <= 2500.0


def test_field_elevation_known_and_default() -> None:
    assert field_elevation_ft("VTBS") == 5.0
    assert field_elevation_ft("vtsp") == 25.0  # case-insensitive
    assert field_elevation_ft("ZZZZ") == 0.0


def test_profile_phases_and_continuity() -> None:
    p = VerticalProfile.build(
        total_time_s=3600.0,
        rfl_ft=33000.0,
        aircraft_type="B738",
        dep_elev_ft=5.0,
        des_elev_ft=25.0,
    )
    # Start on the ground climbing, level at cruise, back down at the end.
    alt0, ph0 = p.at(0.0)
    altc, phc = p.at(p.total_time_s / 2)
    altn, phn = p.at(p.total_time_s)
    assert ph0 == "climb" and alt0 < 1000
    assert phc == "cruise" and abs(altc - 33000.0) < 1.0
    assert phn == "descent" and altn < 1000
    assert 0 < p.toc_time_s < p.tod_time_s < p.total_time_s


def test_short_flight_does_not_reach_rfl() -> None:
    # 5-minute hop can't climb to FL330 then descend.
    p = VerticalProfile.build(
        total_time_s=300.0,
        rfl_ft=33000.0,
        aircraft_type="B738",
        dep_elev_ft=0.0,
        des_elev_ft=0.0,
    )
    assert p.cruise_alt_ft < 33000.0
    # Peak altitude is reached but never exceeds the (reduced) cruise alt.
    assert p.at(p.toc_time_s)[0] <= p.cruise_alt_ft + 1.0


def test_build_with_rfl_populates_altitude_and_phases() -> None:
    gdf = build_trajectory_gdf(
        waypoint_sequence=_WAYPOINTS,
        eobt=_EOBT,
        callsign="THA204",
        aircraft_type="B738",
        adep="VTBS",
        ades="VTSP",
        rfl=330,
    )
    assert gdf["altitude_ft"].notna().all()
    assert gdf["altitude_ft"].max() <= 33000.0 + 1.0
    phases = set(gdf["phase"].unique())
    assert phases == {"climb", "cruise", "descent"}
    # POINT Z geometry when a vertical profile is applied.
    assert gdf.geometry.iloc[0].has_z
