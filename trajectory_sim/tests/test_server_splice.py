"""Integration tests for the SID/STAR splice wiring in api.server.

These exercise the API boundary (`GenerateRequest` -> `_splice_terminal_
procedures`), not the pure splice itself — that lives in
``test_route_splice``. The procedures NavData is monkeypatched onto the same
in-memory DFD fixtures the navdata tests use, so no real GeoPackage/GeoJSON
is read.
"""

from __future__ import annotations

import pandas as pd
import pytest

import api.server as server
from trajectory_sim.navdata import NavData

from trajectory_sim.tests.test_navdata_procedures import (
    _SID_ROWS,
    _STAR_ROWS,
    _proc_df,
    _waypoints_gdf,
)


@pytest.fixture
def patched_navdata(monkeypatch: pytest.MonkeyPatch) -> None:
    """Point ``server._navdata`` at the in-memory SID/STAR fixtures.

    SID BIDA2A and STAR SARI1A are both published at VTBS; we reuse VTBS as
    ADEP and ADES here only so the one fixture covers both ends.
    """
    import trajectory_sim.navdata as navdata_mod

    sids = _proc_df(_SID_ROWS, "VTBS", "BIDA2A")
    stars = _proc_df(_STAR_ROWS, "VTBS", "SARI1A")

    def fake_read_file(path: object, layer: str) -> pd.DataFrame:
        if layer == "waypoints":
            return _waypoints_gdf()
        if layer == "sids":
            return sids.copy()
        if layer == "stars":
            return stars.copy()
        raise ValueError(f"no layer {layer}")

    monkeypatch.setattr(navdata_mod.gpd, "read_file", fake_read_file)
    monkeypatch.setattr(server, "_navdata", lambda: NavData("ignored.gpkg"))


def _req(**kw: object) -> server.GenerateRequest:
    base = dict(
        source="fpl",
        adep="VTBS",
        ades="VTBS",
        route="DCT DAGAB DCT LADAR DCT",
        callsign="TEST",
        eobt="2026-01-03T08:15:00",
        rfl=330,
    )
    base.update(kw)
    return server.GenerateRequest(**base)  # type: ignore[arg-type]


def _idents(pts: list[tuple[str, float, float]]) -> list[str]:
    return [p[0] for p in pts]


def test_splice_inserts_sid_and_star(patched_navdata: None) -> None:
    warnings: list[str] = []
    enroute = [("DAGAB", 15.0, 101.8), ("LADAR", 15.5, 101.0)]
    out, _cons, _term = server._splice_terminal_procedures(
        _req(sid="BIDA2A", star="SARI1A"), "VTBS", "VTBS", enroute, warnings
    )
    assert _idents(out) == [
        "SAVUS", "BIDAK", "DOGAR", "BIDA", "DAGAB",  # SID (DAGAB joined)
        "LADAR", "RECID", "FINAL",  # STAR (LADAR joined)
    ]


def test_proc_runway_derivation() -> None:
    """The export runway falls back to the RW* leg transition when the DFD
    encodes it there (route_type 5) and ``proc.runway`` is None."""

    class _Leg:
        def __init__(self, tr: str | None) -> None:
            self.transition = tr

    class _Proc:  # proc.runway None → derive from legs
        runway = None
        legs = (_Leg(None), _Leg("RW03L"), _Leg("RW03L"))

    class _ProcWithRunway:  # explicit proc.runway wins
        runway = "RW21R"
        legs = (_Leg("RW09"),)

    class _ProcNoRunway:  # nothing to derive
        runway = None
        legs = (_Leg(None),)

    assert server._proc_runway(_Proc()) == "RW03L"
    assert server._proc_runway(_ProcWithRunway()) == "RW21R"
    assert server._proc_runway(_ProcNoRunway()) is None
    assert server._proc_runway(None) is None


def test_no_procedures_passthrough(patched_navdata: None) -> None:
    warnings: list[str] = []
    enroute = [("DAGAB", 15.0, 101.8), ("LADAR", 15.5, 101.0)]
    out, _cons, _term = server._splice_terminal_procedures(
        _req(), "VTBS", "VTBS", enroute, warnings
    )
    assert out == enroute
    assert warnings == []


def test_unknown_procedure_warns_and_keeps_route(patched_navdata: None) -> None:
    warnings: list[str] = []
    enroute = [("DAGAB", 15.0, 101.8), ("LADAR", 15.5, 101.0)]
    out, _cons, _term = server._splice_terminal_procedures(
        _req(sid="NOPE9Z"), "VTBS", "VTBS", enroute, warnings
    )
    assert out == enroute  # unchanged
    assert any("NOPE9Z" in w and "skipped" in w for w in warnings)


def test_ambiguous_runway_auto_resolves_with_warning(
    patched_navdata: None,
) -> None:
    """BIDA2A has two runways; with none specified the server picks one and
    records the assumption rather than failing."""
    warnings: list[str] = []
    enroute = [("DAGAB", 15.0, 101.8)]
    out, _cons, _term = server._splice_terminal_procedures(
        _req(sid="BIDA2A"), "VTBS", "VTBS", enroute, warnings
    )
    # A SID was spliced in (route grew past the single enroute fix)...
    assert len(out) > 1
    # ...and the auto-pick was reported.
    assert any("assumed" in w for w in warnings)
    # ...and the resolved runway is captured for the export, even though the
    # request left it on "Auto".
    assert _term["sid"] == "BIDA2A"
    assert _term["dep_rwy"]  # a concrete runway, not None/empty
