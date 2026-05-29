"""Tests for the CAT62 flight-time validation module + speed tuning."""

from __future__ import annotations

from trajectory_sim.performance import (
    aircraft_speeds,
    get_speed_restriction,
    set_speed_restriction,
    tune_speed_schedule,
)
from trajectory_sim.validation import (
    CAT62Reference,
    FlightTimeValidation,
    validate_flight_time,
)


def test_delta_and_pass_within_threshold() -> None:
    v = validate_flight_time("VTBS-WMKK", cat62_min=128, simulated_min=131)
    assert v.delta_min == 3
    assert v.status == "PASS"
    assert v.passed is True


def test_fail_at_or_beyond_threshold() -> None:
    # Exactly 5 minutes is a FAIL (acceptance is strictly < 5).
    v = validate_flight_time("A-B", cat62_min=100, simulated_min=105)
    assert v.delta_min == 5
    assert v.status == "FAIL"
    # 5+ also fails, and a negative (too fast) delta fails symmetrically.
    assert validate_flight_time("A-B", 100, 94).status == "FAIL"
    assert validate_flight_time("A-B", 100, 96).status == "PASS"


def test_report_matches_spec_example() -> None:
    v = validate_flight_time("VTBS-WMKK", 128, 131)
    assert v.report() == (
        "Route: VTBS-WMKK\n"
        "CAT62 Time: 128 min\n"
        "Simulated Time: 131 min\n"
        "Delta: +3 min\n"
        "Status: PASS"
    )


def test_report_negative_delta_sign() -> None:
    v = validate_flight_time("VTBS-VTSP", cat62_min=70, simulated_min=66)
    assert "Delta: -4 min" in v.report()
    assert v.passed is True


def test_reference_lookup_is_direction_agnostic() -> None:
    ref = CAT62Reference({"VTBS-WMKK": 128})
    assert ref.lookup("VTBS", "WMKK") == 128
    assert ref.lookup("WMKK", "VTBS") == 128  # reverse matches
    assert ref.lookup("VTBS", "VTCC") is None


def test_reference_validate_returns_none_for_unknown_pair() -> None:
    ref = CAT62Reference({"VTBS-VTSP": 70})
    assert ref.validate("VTCC", "VTUU", 90.0) is None


def test_reference_loads_bundled_file() -> None:
    ref = CAT62Reference.load()
    # The seed file ships the spec's example pair.
    assert ref.lookup("VTBS", "WMKK") == 128
    v = ref.validate("VTBS", "WMKK", 131.0)
    assert isinstance(v, FlightTimeValidation)
    assert v.status == "PASS"


def test_tune_speed_schedule_partial_override() -> None:
    try:
        base = aircraft_speeds("B738")
        tuned = tune_speed_schedule("B738", cruise_mach=0.74)
        assert tuned.cruise_mach == 0.74
        # Untouched fields are preserved.
        assert tuned.climb_cas_kt == base.climb_cas_kt
        # The override is now what aircraft_speeds returns.
        assert aircraft_speeds("B738").cruise_mach == 0.74
    finally:
        # Restore so other tests see the baseline schedule.
        tune_speed_schedule(
            "B738",
            climb_cas_kt=290.0,
            climb_mach=0.78,
            cruise_mach=0.785,
            descent_mach=0.78,
            descent_cas_kt=290.0,
        )


def test_set_speed_restriction_roundtrip() -> None:
    orig_cas, orig_alt = get_speed_restriction()
    try:
        set_speed_restriction(cas_kt=280.0, below_alt_ft=8000.0)
        assert get_speed_restriction() == (280.0, 8000.0)
    finally:
        set_speed_restriction(cas_kt=orig_cas, below_alt_ft=orig_alt)
