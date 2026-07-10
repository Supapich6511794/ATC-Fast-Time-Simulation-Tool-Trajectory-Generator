"""Tests for PBN instrument-approach (IAP) loading, assembly and splicing.

The approach data is the real Thai AIP PBN export
(``web/public/data/pbn/pbn_waypoint.geojson``) — the same ARINC-424 "DFD" leg
schema as SID/STAR. An approach flies its chosen IAF transition into the common
final segment and, for a landing trajectory, stops at the Missed Approach Point
(the missed-approach hold is dropped). VTSP RWY09 has two variants (RNP Y =
``R09-Y``, RNP Z = ``R09-Z``) that fly different tracks to the threshold.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from trajectory_sim.navdata import (
    NavData,
    ProcedureType,
    RouteWaypoint,
    splice_procedures,
)

_PBN = (
    Path(__file__).resolve().parents[2]
    / "web" / "public" / "data" / "pbn" / "pbn_waypoint.geojson"
)

pytestmark = pytest.mark.skipif(
    not _PBN.is_file(), reason="PBN approach source not present"
)


@pytest.fixture(scope="module")
def nav() -> NavData:
    return NavData(approach_source=_PBN)


def test_approach_types_listed(nav: NavData) -> None:
    aps = nav.list_procedures("VTSP", ProcedureType.APPROACH)
    assert set(aps) >= {"R09-Y", "R09-Z", "R27-Y", "R27-Z"}
    # Approaches must NOT leak into the SID/STAR lists.
    assert "R09-Z" not in nav.list_procedures("VTSP", ProcedureType.STAR)


def test_r09z_assembles_and_truncates_at_mapt(nav: NavData) -> None:
    # RNP Z RWY09 via KALIM: IAF -> IF(LAZAM) -> FAF(HKTWF) -> MAPt(MR09).
    p = nav.lookup_procedure(
        "VTSP", "R09-Z", proc_type=ProcedureType.APPROACH, transition="KALIM"
    )
    idents = [w.ident for w in p.waypoints()]
    assert idents == ["KALIM", "LAZAM", "HKTWF", "MR09"]
    # The missed-approach hold (GENOA) after the MAPt is dropped.
    assert "GENOA" not in idents


def test_r09y_assembles_and_truncates_at_mapt(nav: NavData) -> None:
    # RNP Y RWY09 via KALIM flies a different track: KALIM -> HK450 -> SAMON
    # -> RW09 (the MAPt). The two variants share a runway but not a path.
    p = nav.lookup_procedure(
        "VTSP", "R09-Y", proc_type=ProcedureType.APPROACH, transition="KALIM"
    )
    idents = [w.ident for w in p.waypoints()]
    assert idents == ["KALIM", "HK450", "SAMON", "RW09"]
    assert "GENOA" not in idents


def test_approach_transition_selectable(nav: NavData) -> None:
    # Each IAF is its own entry into the same common final segment.
    for iaf in ("LAZIO", "ROMAA"):
        p = nav.lookup_procedure(
            "VTSP", "R09-Z", proc_type=ProcedureType.APPROACH, transition=iaf
        )
        idents = [w.ident for w in p.waypoints()]
        assert idents[0] == iaf
        assert idents[-1] == "MR09"  # all converge on the MAPt


def test_approach_runway_is_in_the_name(nav: NavData) -> None:
    # The landing runway is encoded in the procedure name, not a runway group —
    # so no runway needs to be specified to resolve it.
    p = nav.lookup_procedure(
        "VTSP", "R09-Z", proc_type=ProcedureType.APPROACH, transition="KALIM"
    )
    assert p.runway is None  # nothing to disambiguate
    assert p.transition == "KALIM"


def test_splice_star_end_collapses_into_approach_iaf(nav: NavData) -> None:
    # The approach IAF (KALIM) coincides with the STAR's terminal fix, so the
    # boundary collapses to a single point when spliced.
    ap = nav.lookup_procedure(
        "VTSP", "R09-Z", proc_type=ProcedureType.APPROACH, transition="KALIM"
    )
    enroute = [
        RouteWaypoint("VANKO", 13.0, 100.0),
        RouteWaypoint("KALIM", 8.9, 98.5),  # STAR terminal fix == approach IAF
    ]
    out = [w.ident for w in splice_procedures(enroute, approach=ap)]
    assert out == ["VANKO", "KALIM", "LAZAM", "HKTWF", "MR09"]
    assert out.count("KALIM") == 1  # boundary fix not duplicated
