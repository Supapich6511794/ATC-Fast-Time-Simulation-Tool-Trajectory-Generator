"""Tests for output.py."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import geopandas as gpd
import pandas as pd
import pytest

from trajectory_sim.output import (
    build_trajectory_gdf,
    write_csv,
    write_geopackage,
)

_WAYPOINTS = [
    (13.6811, 100.7470),  # near VTBS
    (11.0, 100.0),         # mid
    (8.1132, 98.3170),     # near VTSP
]
_EOBT = datetime(2026, 1, 3, 8, 15, tzinfo=timezone.utc)

_EXPECTED_COLS = {
    "flight_key", "callsign", "aircraft_type", "adep", "ades",
    "epoch_ts", "altitude_ft", "tas_kt", "gs_kt", "track_deg",
    "phase", "geometry",
}


def _build_default_gdf() -> gpd.GeoDataFrame:
    return build_trajectory_gdf(
        waypoint_sequence=_WAYPOINTS,
        eobt=_EOBT,
        callsign="THA204",
        aircraft_type="B738",
        adep="VTBS",
        ades="VTSP",
    )


# --- build_trajectory_gdf --------------------------------------------------

def test_gdf_has_required_columns() -> None:
    gdf = _build_default_gdf()
    assert _EXPECTED_COLS.issubset(set(gdf.columns))


def test_gdf_has_rows() -> None:
    gdf = _build_default_gdf()
    assert len(gdf) > 0


def test_gdf_crs_is_4326() -> None:
    gdf = _build_default_gdf()
    assert gdf.crs is not None
    assert gdf.crs.to_epsg() == 4326


def test_gdf_flight_key_format() -> None:
    gdf = _build_default_gdf()
    assert gdf["flight_key"].iloc[0] == "THA204_20260103T0815Z"
    assert (gdf["flight_key"] == "THA204_20260103T0815Z").all()


def test_gdf_first_timestamp_equals_eobt() -> None:
    gdf = _build_default_gdf()
    first_ts = gdf["epoch_ts"].iloc[0]
    # pandas may convert to Timestamp; compare via to_pydatetime where possible
    if hasattr(first_ts, "to_pydatetime"):
        first_ts = first_ts.to_pydatetime()
    assert first_ts == _EOBT


def test_gdf_timestamps_are_monotonic() -> None:
    gdf = _build_default_gdf()
    assert gdf["epoch_ts"].is_monotonic_increasing


def test_gdf_phase_is_cruise_for_phase1() -> None:
    gdf = _build_default_gdf()
    assert (gdf["phase"] == "cruise").all()


def test_gdf_altitude_and_tas_are_none_for_phase1() -> None:
    gdf = _build_default_gdf()
    assert gdf["altitude_ft"].isna().all()
    assert gdf["tas_kt"].isna().all()


def test_gdf_gs_kt_constant() -> None:
    gdf = _build_default_gdf()
    assert (gdf["gs_kt"] == 450.0).all()


def test_gdf_rejects_naive_eobt() -> None:
    with pytest.raises(ValueError, match="UTC"):
        build_trajectory_gdf(
            waypoint_sequence=_WAYPOINTS,
            eobt=datetime(2026, 1, 3, 8, 15),
            callsign="THA204",
            aircraft_type="B738",
            adep="VTBS",
            ades="VTSP",
        )


def test_gdf_rejects_single_waypoint() -> None:
    with pytest.raises(ValueError, match="at least 2"):
        build_trajectory_gdf(
            waypoint_sequence=[(13.0, 100.0)],
            eobt=_EOBT,
            callsign="THA204",
            aircraft_type="B738",
            adep="VTBS",
            ades="VTSP",
        )


# --- write_geopackage ------------------------------------------------------

def test_write_geopackage_roundtrip(tmp_path: Path) -> None:
    gdf = _build_default_gdf()
    out = tmp_path / "test_output.gpkg"
    write_geopackage(gdf, out)
    assert out.exists()

    read_back = gpd.read_file(out, layer="trajectory")
    assert len(read_back) == len(gdf)
    assert read_back.crs.to_epsg() == 4326


# --- write_csv -------------------------------------------------------------

def test_write_csv_has_lat_lon_columns(tmp_path: Path) -> None:
    gdf = _build_default_gdf()
    out = tmp_path / "test_output.csv"
    write_csv(gdf, out)
    assert out.exists()

    df = pd.read_csv(out)
    assert "lat" in df.columns
    assert "lon" in df.columns
    assert "geometry" not in df.columns
    assert len(df) == len(gdf)


def test_write_csv_lat_lon_values_match_geometry(tmp_path: Path) -> None:
    gdf = _build_default_gdf()
    out = tmp_path / "test_output.csv"
    write_csv(gdf, out)

    df = pd.read_csv(out)
    assert df["lat"].iloc[0] == pytest.approx(gdf.geometry.y.iloc[0])
    assert df["lon"].iloc[0] == pytest.approx(gdf.geometry.x.iloc[0])
