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
_STAR = (
    Path(__file__).resolve().parents[2]
    / "web" / "public" / "data" / "star" / "star_waypoint.geojson"
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


def test_splice_arrival_at_if_skips_iaf_transition_no_zigzag(nav: NavData) -> None:
    # VTCC R18: IAF transition MESUX->PILEX, then PILEX(IF)->CC181(FAF)->CC180
    # (MAPt). Many VTCC STARs end AT the IF (…MESUX, PILEX). Splicing the
    # approach must NOT re-fly the IAF transition (which flew the aircraft out
    # to MESUX and back: …MESUX, PILEX, MESUX, PILEX, CC181 — a real bug the
    # user hit); it joins at PILEX and continues straight down the final segment.
    ap = nav.lookup_procedure(
        "VTCC", "R18", proc_type=ProcedureType.APPROACH, transition="MESUX"
    )
    assert [w.ident for w in ap.waypoints()] == [
        "MESUX", "PILEX", "CC181", "CC180",
    ]
    arrival = [  # a STAR that ends at the IF via the MESUX IAF
        RouteWaypoint("SUSEG", 19.0, 99.2),
        RouteWaypoint("MESUX", 18.95, 99.1),
        RouteWaypoint("PILEX", 18.9, 98.98),
    ]
    out = [w.ident for w in splice_procedures(arrival, approach=ap)]
    assert out == ["SUSEG", "MESUX", "PILEX", "CC181", "CC180"]
    assert out.count("PILEX") == 1
    assert out.count("MESUX") == 1  # flown once, not out-and-back


def test_splice_arrival_via_other_iaf_still_no_backtrack(nav: NavData) -> None:
    # The STAR reaches the IF via the OTHER IAF (SANRA) while the approach was
    # resolved on the MESUX transition. Reaching the IF still drops the MESUX
    # transition — no fly-out to MESUX and back.
    ap = nav.lookup_procedure(
        "VTCC", "R18", proc_type=ProcedureType.APPROACH, transition="MESUX"
    )
    arrival = [
        RouteWaypoint("SANRA", 18.8, 98.6),
        RouteWaypoint("PILEX", 18.9, 98.98),
    ]
    out = [w.ident for w in splice_procedures(arrival, approach=ap)]
    assert out == ["SANRA", "PILEX", "CC181", "CC180"]
    assert "MESUX" not in out


def test_splice_direct_arrival_flies_full_iaf_transition(nav: NavData) -> None:
    # A direct arrival that ends SHORT of the approach flies the whole thing,
    # IAF transition included — nothing overlaps, so nothing is collapsed.
    ap = nav.lookup_procedure(
        "VTCC", "R18", proc_type=ProcedureType.APPROACH, transition="MESUX"
    )
    arrival = [RouteWaypoint("MARNI", 18.5, 99.5)]  # not a fix on the approach
    out = [w.ident for w in splice_procedures(arrival, approach=ap)]
    assert out == ["MARNI", "MESUX", "PILEX", "CC181", "CC180"]


def test_splice_star_overshooting_iaf_drops_overshoot_no_loop(
    nav: NavData,
) -> None:
    # VTSP RW27: the STAR ends a fix PAST the IAF the approach re-enters at —
    # …BARON, CI27 (CI27 a runway-centreline fix) — while the R27-Y approach
    # begins BARON, HK580, … Anchoring only on the STAR's last fix (CI27, absent
    # from the approach) appended the whole approach and re-flew BARON:
    # …BARON, CI27, BARON, HK580 — a visible loop on the map. The join must drop
    # the overshoot (CI27) AND the approach's re-entry BARON: …BARON, HK580.
    ap = nav.lookup_procedure(
        "VTSP", "R27-Y", proc_type=ProcedureType.APPROACH, transition="BARON"
    )
    assert [w.ident for w in ap.waypoints()][:2] == ["BARON", "HK580"]
    arrival = [  # STAR EMRI1D tail: reaches BARON, then overshoots to CI27
        RouteWaypoint("SP112", 8.2, 98.7),
        RouteWaypoint("BARON", 8.1, 98.65),
        RouteWaypoint("CI27", 8.05, 98.6),
    ]
    out = [w.ident for w in splice_procedures(arrival, approach=ap)]
    assert out[:3] == ["SP112", "BARON", "HK580"]
    assert "CI27" not in out  # overshoot dropped
    assert out.count("BARON") == 1  # no out-and-back loop


@pytest.mark.skipif(not _STAR.is_file(), reason="STAR source not present")
def test_splice_star_joins_approach_at_chosen_early_entry_fix() -> None:
    # The pilot may join the approach at an EARLIER entry fix the STAR passes,
    # not just its last shared one. VTSP SUSI1D flies STONE, CIDER, BARON, CI27;
    # R27-Y can be entered at STONE (STONE, MALIN, …). Joining at STONE must trim
    # the STAR back to STONE — dropping CIDER, BARON, CI27 — not fly the whole
    # STAR and loop back (STONE, CIDER, BARON, CI27, STONE, MALIN).
    nav = NavData(star_source=_STAR, approach_source=_PBN)
    star = nav.lookup_procedure("VTSP", "SUSI1D", proc_type=ProcedureType.STAR)
    assert [w.ident for w in star.waypoints()] == [
        "SUSID", "STONE", "CIDER", "BARON", "CI27",
    ]
    ap = nav.lookup_procedure(
        "VTSP", "R27-Y", proc_type=ProcedureType.APPROACH, transition="STONE"
    )
    assert [w.ident for w in ap.waypoints()][0] == "STONE"
    out = [
        w.ident
        for w in splice_procedures(
            [RouteWaypoint("SUSID", 8.9, 98.9)], star=star, approach=ap
        )
    ]
    assert out[:2] == ["SUSID", "STONE"]
    assert "CIDER" not in out and "BARON" not in out and "CI27" not in out
    assert out.count("STONE") == 1  # joined once, no loop back through the STAR
