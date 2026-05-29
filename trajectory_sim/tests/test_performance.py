"""Tests for performance.py (Phase 2 vertical profile)."""

from __future__ import annotations

from datetime import datetime, timezone

from trajectory_sim.output import build_trajectory_gdf
from trajectory_sim.performance import (
    SpeedSchedule,
    VerticalProfile,
    aircraft_roc_rod,
    aircraft_speeds,
    field_elevation_ft,
    service_ceiling_ft,
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


def test_bada_climb_slower_at_altitude() -> None:
    # BADA-style schedule: ROC at FL350 must be lower than ROC at 5000 ft.
    p = VerticalProfile.build(
        total_time_s=4 * 3600.0,  # plenty of cruise so the slope is real
        rfl_ft=35000.0,
        aircraft_type="B738",
        dep_elev_ft=0.0,
        des_elev_ft=0.0,
    )
    # Compare 60-second altitude gains in two climb bands.
    early_lo, _ = p.at(60.0)
    early_hi, _ = p.at(120.0)
    early_roc = (early_hi - early_lo) * 60.0 / 60.0  # ft/min

    # Time at which the climb has just crossed FL300 (last weak band).
    # Build a long-cruise profile so the TOC is well-defined.
    near_top_t = p.toc_time_s - 30.0
    if near_top_t > 60:
        late_lo, _ = p.at(near_top_t)
        late_hi, _ = p.at(near_top_t + 60.0)
        late_roc = (late_hi - late_lo) * 60.0 / 60.0
        assert late_roc < early_roc, (
            f"expected climb to slow with altitude; "
            f"early={early_roc} fpm late={late_roc} fpm"
        )


def test_bada_known_aircraft_types_supported() -> None:
    # The performance table covers all forward-compat slots in the UI.
    for ac in ("B738", "A320", "B77W"):
        roc, rod = aircraft_roc_rod(ac)
        assert 1500.0 <= roc <= 2500.0
        assert 1500.0 <= rod <= 2500.0


def test_merged_3d_profile_continuous_and_monotonic() -> None:
    # Spec (Phase 2): "Verify monotonic climb to TOC and monotonic descent
    # after TOD with no discontinuities at segment joins" — walk every
    # sample of a generated 3D trajectory and assert each property.
    gdf = build_trajectory_gdf(
        waypoint_sequence=_WAYPOINTS,
        eobt=_EOBT,
        callsign="THA204",
        aircraft_type="B738",
        adep="VTBS",
        ades="VTSP",
        rfl=350,
    )

    # 1. Every great-circle point carries an altitude (interpolation,
    #    not just the named waypoints).
    assert gdf["altitude_ft"].notna().all()

    # 2. Geometry is POINT Z — i.e. 3D points (lat, lon, alt).
    assert all(geom.has_z for geom in gdf.geometry)

    altitudes = gdf["altitude_ft"].tolist()
    phases = gdf["phase"].tolist()

    # 3. Phase boundaries: find the first cruise sample (TOC) and the
    #    last cruise sample (TOD). Everything before is climb, every
    #    sample after is descent.
    toc_i = phases.index("cruise")
    tod_i = len(phases) - 1 - list(reversed(phases)).index("cruise")
    assert all(p == "climb" for p in phases[:toc_i])
    assert all(p == "cruise" for p in phases[toc_i : tod_i + 1])
    assert all(p == "descent" for p in phases[tod_i + 1 :])

    # 4. Monotonic non-decreasing climb up to TOC.
    for i in range(1, toc_i + 1):
        assert altitudes[i] + 1e-6 >= altitudes[i - 1], (
            f"climb not monotonic at sample {i}: "
            f"{altitudes[i - 1]} -> {altitudes[i]}"
        )

    # 5. Monotonic non-increasing descent after TOD.
    for i in range(tod_i + 1, len(altitudes)):
        assert altitudes[i] <= altitudes[i - 1] + 1e-6, (
            f"descent not monotonic at sample {i}: "
            f"{altitudes[i - 1]} -> {altitudes[i]}"
        )

    # 6. Continuity at the joins: a single 4-second sample step is bounded
    #    by the airframe's peak BADA rate. Descent dominates — the B738
    #    (ISA+20) peaks near ~3240 fpm, so ~216 ft per 4 s sample is a
    #    legitimate single step (not a discontinuity). The check still
    #    catches any multi-sample vertical JUMP.
    max_step_ft = 3240.0 * 4.0 / 60.0  # one 4 s sample at peak ROCD ≈ 216 ft
    cruise_alt = altitudes[toc_i]
    assert abs(cruise_alt - 35000.0) < 1.0  # exact RFL was reachable
    assert cruise_alt - altitudes[toc_i - 1] <= max_step_ft + 1e-6

    # 7. Continuity at the cruise→descent join: the first descent sample
    #    is no more than one sample's drop below cruise.
    assert altitudes[tod_i] - altitudes[tod_i + 1] <= max_step_ft + 1e-6

    # 8. Endpoints are sane (close to field elevation).
    assert altitudes[0] <= 10.0 + 1e-6        # near VTBS (5 ft)
    assert altitudes[-1] <= 30.0 + 1e-6       # near VTSP (25 ft)


def test_aircraft_speeds_known_and_fallback() -> None:
    b738 = aircraft_speeds("B738")
    assert isinstance(b738, SpeedSchedule)
    assert 250.0 <= b738.climb_cas_kt <= 320.0
    assert 0.70 <= b738.cruise_mach <= 0.90
    assert b738.descent_cas_kt >= 250.0
    # B77W cruises faster than B738.
    b77w = aircraft_speeds("b77w")
    assert b77w.cruise_mach >= b738.cruise_mach
    # Unknown aircraft falls back to B738 schedule, not raises.
    assert aircraft_speeds("XXXX") == b738


def test_service_ceiling_known_and_fallback() -> None:
    assert service_ceiling_ft("B738") == 41000.0
    assert service_ceiling_ft("a320") == 41000.0  # case-insensitive
    assert service_ceiling_ft("B77W") > 41000.0
    # Unknown falls back to B738.
    assert service_ceiling_ft("XXXX") == 41000.0


def test_rfl_clamped_to_service_ceiling() -> None:
    # An RFL above the B738 ceiling (FL410) is clipped to the ceiling
    # instead of producing a fantasy cruise altitude.
    p = VerticalProfile.build(
        total_time_s=4 * 3600.0,
        rfl_ft=45000.0,
        aircraft_type="B738",
        dep_elev_ft=0.0,
        des_elev_ft=0.0,
    )
    assert p.cruise_alt_ft == service_ceiling_ft("B738")


def test_altitude_at_distance_matches_time_indexed() -> None:
    # `at_distance` is a pure remapping of `at(elapsed_s)` for callers
    # that want altitude vs along-track distance (Phase 2 spec wording).
    p = VerticalProfile.build(
        total_time_s=3600.0,
        rfl_ft=35000.0,
        aircraft_type="B738",
        dep_elev_ft=0.0,
        des_elev_ft=0.0,
    )
    total_nm = 450.0  # constant gs ~= 450 kt × 1 h
    # Midpoint distance ≡ midpoint time → cruise alt.
    alt_mid, phase_mid = p.at_distance(total_nm / 2, total_nm)
    assert phase_mid == "cruise"
    assert abs(alt_mid - 35000.0) < 1.0
    # 0 NM → start of climb at ground level.
    alt0, ph0 = p.at_distance(0.0, total_nm)
    assert ph0 == "climb" and alt0 < 200.0
    # Beyond total → descent at end altitude.
    altn, phn = p.at_distance(total_nm + 50, total_nm)
    assert phn == "descent" and altn < 200.0


def test_cruise_fl_exactly_matches_fpl_request() -> None:
    # Phase 2 acceptance criterion: cruise FL == FPL-requested level
    # (when reachable for the airframe and the leg duration).
    from trajectory_sim.fpl import FlightPlan
    from datetime import datetime, timezone

    fpl = FlightPlan(
        callsign="THA204",
        aircraft_type="B738",
        adep="VTBS",
        ades="VTSP",
        eobt=datetime(2026, 1, 3, 8, 15, tzinfo=timezone.utc),
        rfl=350,  # FL350 is well below the B738 ceiling
        route="DCT VANKO DCT",
    )
    gdf = build_trajectory_gdf(
        waypoint_sequence=_WAYPOINTS,
        eobt=fpl.eobt,
        callsign=fpl.callsign,
        aircraft_type=fpl.aircraft_type,
        adep=fpl.adep,
        ades=fpl.ades,
        rfl=fpl.rfl,  # read from the dataclass, not a loose int
    )
    cruise_max = float(gdf["altitude_ft"].max())
    assert cruise_max == fpl.rfl * 100.0


def test_unknown_aircraft_falls_back_to_b738() -> None:
    # An unknown ICAO type still produces a sane profile (B738 table).
    p_unknown = VerticalProfile.build(
        total_time_s=3600.0,
        rfl_ft=33000.0,
        aircraft_type="XXXX",
        dep_elev_ft=0.0,
        des_elev_ft=0.0,
    )
    p_b738 = VerticalProfile.build(
        total_time_s=3600.0,
        rfl_ft=33000.0,
        aircraft_type="B738",
        dep_elev_ft=0.0,
        des_elev_ft=0.0,
    )
    assert abs(p_unknown.toc_time_s - p_b738.toc_time_s) < 1e-6
    assert abs(p_unknown.tod_time_s - p_b738.tod_time_s) < 1e-6
