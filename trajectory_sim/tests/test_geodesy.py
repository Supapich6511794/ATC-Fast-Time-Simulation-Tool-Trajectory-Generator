"""Tests for geodesy.py."""

from __future__ import annotations

import pytest

from trajectory_sim.geodesy import (
    compute_bearing,
    haversine_distance,
    interpolate_great_circle,
)

# Validation city pair from the brief
VTBS_LAT, VTBS_LON = 13.6811, 100.7470
VTSP_LAT, VTSP_LON = 8.1132, 98.3170


# --- haversine_distance ----------------------------------------------------

def test_haversine_distance_vtbs_to_vtsp_matches_reference() -> None:
    # Bangkok (VTBS) to Phuket (VTSP) is ~362 NM by WGS-84 geodesic.
    # (The brief quotes 309 NM — that figure does not match the
    # given lat/lon. Standard references put BKK→HKT at ~670 km = 362 NM.)
    distance_nm = haversine_distance(VTBS_LAT, VTBS_LON, VTSP_LAT, VTSP_LON)
    assert distance_nm == pytest.approx(362.0, abs=5.0)


def test_haversine_distance_zero_for_same_point() -> None:
    assert haversine_distance(13.0, 100.0, 13.0, 100.0) == pytest.approx(
        0.0, abs=1e-6
    )


def test_haversine_distance_symmetric() -> None:
    d_ab = haversine_distance(VTBS_LAT, VTBS_LON, VTSP_LAT, VTSP_LON)
    d_ba = haversine_distance(VTSP_LAT, VTSP_LON, VTBS_LAT, VTBS_LON)
    assert d_ab == pytest.approx(d_ba)


# --- compute_bearing -------------------------------------------------------

def test_compute_bearing_vtbs_to_vtsp_southwest() -> None:
    bearing = compute_bearing(VTBS_LAT, VTBS_LON, VTSP_LAT, VTSP_LON)
    assert 200.0 <= bearing <= 220.0


def test_compute_bearing_due_north() -> None:
    bearing = compute_bearing(13.0, 100.0, 14.0, 100.0)
    assert bearing == pytest.approx(0.0, abs=0.1)


def test_compute_bearing_due_west_in_zero_to_360_range() -> None:
    # At lat=13°, an initial geodesic heading toward a point 1° west is
    # slightly north of 270° because the geodesic bows toward the
    # equator — it doesn't follow the parallel. ±0.5° tolerance covers
    # this for short legs at mid-latitudes.
    bearing = compute_bearing(13.0, 100.0, 13.0, 99.0)
    assert 0.0 <= bearing < 360.0
    assert bearing == pytest.approx(270.0, abs=0.5)


# --- interpolate_great_circle ----------------------------------------------

def test_interpolate_first_point_at_start() -> None:
    points = interpolate_great_circle(VTBS_LAT, VTBS_LON, VTSP_LAT, VTSP_LON)
    assert points[0]["lat"] == pytest.approx(VTBS_LAT, abs=0.01)
    assert points[0]["lon"] == pytest.approx(VTBS_LON, abs=0.01)
    assert points[0]["elapsed_s"] == pytest.approx(0.0, abs=1e-6)


def test_interpolate_last_point_at_end() -> None:
    points = interpolate_great_circle(VTBS_LAT, VTBS_LON, VTSP_LAT, VTSP_LON)
    assert points[-1]["lat"] == pytest.approx(VTSP_LAT, abs=0.01)
    assert points[-1]["lon"] == pytest.approx(VTSP_LON, abs=0.01)


def test_interpolate_elapsed_matches_distance_over_speed() -> None:
    points = interpolate_great_circle(
        VTBS_LAT, VTBS_LON, VTSP_LAT, VTSP_LON, ground_speed_kt=450.0
    )
    distance_nm = haversine_distance(VTBS_LAT, VTBS_LON, VTSP_LAT, VTSP_LON)
    expected_time_s = (distance_nm / 450.0) * 3600.0
    assert points[-1]["elapsed_s"] == pytest.approx(expected_time_s, abs=5.0)


def test_interpolate_emits_on_4s_grid_except_endpoint() -> None:
    points = interpolate_great_circle(
        VTBS_LAT, VTBS_LON, VTSP_LAT, VTSP_LON,
        ground_speed_kt=450.0,
        output_every_s=4.0,
    )
    # Drop the (potentially off-grid) endpoint
    grid_points = points[:-1]
    assert len(grid_points) > 0
    for p in grid_points:
        assert p["elapsed_s"] % 4.0 == pytest.approx(0.0, abs=1e-6)


def test_interpolate_zero_distance_leg_returns_single_point() -> None:
    points = interpolate_great_circle(13.0, 100.0, 13.0, 100.0)
    assert len(points) == 1
    assert points[0]["elapsed_s"] == pytest.approx(0.0, abs=1e-6)


def test_interpolate_endpoint_within_1ms_of_grid_replaces_not_appends() -> None:
    """A leg whose duration sits just above a 4-s grid point must not
    emit both the grid point and the endpoint — GeoPackage stores
    timestamps at ms precision, so a ~µs-apart pair collides on the
    (flight_key, epoch_ts) primary key. Engineer a leg whose duration
    is 16.0 + 0.0001 s by picking the distance directly from ground
    speed: at 450 kt → 1 step of 4 s ≈ 0.926 km."""
    gs_ms = 450.0 * 1852.0 / 3600.0  # ~231.5 m/s
    # Target leg duration: 16.0001 s → bias the grid-vs-endpoint case.
    target_t = 16.0 + 1e-4
    distance_m = gs_ms * target_t
    # Walk that distance due east from (0, 0) using a flat
    # approximation — exact distance doesn't need to match target_t to
    # the µs, only land within the (4 s, 4 s + 1 ms) window.
    lon2 = distance_m / 111_320.0
    points = interpolate_great_circle(
        0.0, 0.0, 0.0, lon2,
        ground_speed_kt=450.0,
        output_every_s=4.0,
    )
    # No two consecutive points should fall within the GPKG ms-precision
    # window — otherwise the trajectory writer's unique index breaks.
    for a, b in zip(points, points[1:]):
        assert b["elapsed_s"] - a["elapsed_s"] >= 1e-3, (
            f"near-duplicate emission at {a} / {b} (Δ = "
            f"{b['elapsed_s'] - a['elapsed_s']:.6f}s)"
        )
