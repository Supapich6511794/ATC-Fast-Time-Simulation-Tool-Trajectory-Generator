"""Tests for joining a VOR-terminated enroute route to a STAR / PBN approach.

``api.server._connect_route_to_terminal`` trims a route that ends on the
destination's terminal VOR back to the fix that leads into the STAR/approach,
and locks that entry's transition — so the aircraft flies into the procedure
instead of out to the field VOR and back. The trim only fires when the route
actually ends on that field VOR (``_ends_at_field_vor``). Uses the real bundled
navdata (the reported cases: VTSR R02, VTSF R19, VTCL LPN, VTBD BKK).
"""

from __future__ import annotations

import api.server as server
from trajectory_sim.navdata import ProcedureType


def _resolve_route(route_str: str) -> list[tuple[str, float, float]]:
    from trajectory_sim.fpl import parse_route

    idx = server._airway_waypoint_index()
    return [
        (i, *idx[i])
        for i in parse_route(server._expand_airways(route_str))
        if i in idx
    ]


def _connect(ades, name, route_str, proc_type=None):
    from trajectory_sim.navdata import ProcedureType

    nav = server._navdata()
    route = _resolve_route(route_str)
    trimmed, trn = server._connect_route_to_terminal(
        nav, ades, name, proc_type or ProcedureType.APPROACH, None, route,
        warnings=[],
    )
    return [p[0] for p in trimmed], trn


def test_route_fix_that_is_an_iaf_becomes_the_join() -> None:
    """W34 passes through SAKUB (an R02 IAF) on the way to the RAN VOR. The
    route ends at SAKUB, dropping RAN, and enters on the SAKUB transition."""
    idents, trn = _connect("VTSR", "R02", "SABIS Y8 MENEX W34 RAN")
    assert idents[-1] == "SAKUB"
    assert "RAN" not in idents
    assert trn == "SAKUB"


def test_no_iaf_on_route_joins_the_nearest_entry() -> None:
    """The route ends on the NKS VOR and no fix is an R19 IAF. The nearest IAF
    to NKS is TAWIT, and the route fix nearest TAWIT is DOXAS — so it ends at
    DOXAS (dropping NKS) and enters on TAWIT."""
    idents, trn = _connect("VTSF", "R19", "KASNI M757 LOSDA Y94 NKS")
    assert idents[-1] == "DOXAS"
    assert "NKS" not in idents
    assert trn == "TAWIT"


def test_entry_on_the_far_side_of_the_field_is_not_chosen() -> None:
    """Same route and field, the OTHER runway. R01's entries include CHARY,
    which sits nearest the NKS VOR but 165° out — on the far side of the
    aerodrome from a route arriving on 060°. Picking it (the old rule: simply
    the entry nearest the VOR) flew the aircraft over the field, south to
    CHARY, then back north to land — the doubling-back this trim exists to
    remove. The join must stay on the arrival side: TAWIT, from DOXAS."""
    idents, trn = _connect("VTSF", "R01", "KASNI M757 LOSDA Y94 NKS")
    assert trn == "TAWIT"
    assert trn != "CHARY"  # far side of the field — would double back
    assert idents[-1] == "DOXAS"
    assert "NKS" not in idents


def test_both_runways_join_on_the_arrival_side() -> None:
    """The same arrival direction resolves to the same side of the field for
    either runway — the runway decides the approach flown, not which side the
    aircraft is allowed to arrive from."""
    for rwy in ("R19", "R01"):
        idents, trn = _connect("VTSF", rwy, "KASNI M757 LOSDA Y94 NKS")
        assert (idents[-1], trn) == ("DOXAS", "TAWIT"), rwy


def test_full_generate_flies_in_without_doubling_back() -> None:
    """End to end: the spliced route runs continuously into the approach (no
    sharp reversal) and lands on the runway."""
    req = server.GenerateRequest(
        callsign="T", actype="B738", adep="VTBD", ades="VTSR",
        eobt="2026-07-13T15:54:00Z", rfl=350, source="fpl",
        route="SABIS Y8 MENEX W34 RAN", star_runway="RW02", approach="R02",
        output_every_s=5,
    )
    res = server._generate_one(req)
    idents = [w["ident"] for w in res["route"]]
    assert idents[-3:] == ["OLBUN", "SR022", "SR021"]  # into the final segment
    assert "RAN" not in idents
    trk = [s["track_deg"] for s in res["points"]]
    worst = max(
        abs((trk[i] - trk[i - 1] + 180) % 360 - 180) for i in range(1, len(trk))
    )
    assert worst < 20.0  # no double-back corner


def test_star_route_ending_on_the_field_vor_is_trimmed() -> None:
    """VTCL's LPN VOR sits at the field, past every STAR entry, so a route filed
    to LPN doubles back. It is dropped and the route joins the STAR's entry
    (OTBAD for OTBA1B)."""
    idents, _trn = _connect(
        "VTCL", "OTBA1B", "SEMBO A464 TOPAS DCT LPN", ProcedureType.STAR
    )
    assert "LPN" not in idents
    assert idents[-1] == "TOPAS"  # joins the STAR from the fix before the VOR
    # OTBA1B is single-entry (OTBAD), keyed on the runway, so there is no
    # separate enroute transition to force (trn is None); the STAR name is the
    # entry. The end-to-end test confirms it joins OTBAD cleanly.


def test_star_full_generate_drops_the_field_vor_backtrack() -> None:
    """End to end, VTCL OTBA1B off an LPN-ending route reversed ~175° at LPN;
    dropping LPN removes the double-back."""
    req = server.GenerateRequest(
        callsign="T", actype="B738", adep="VTBD", ades="VTCL",
        eobt="2026-07-13T15:54:00Z", rfl=250, source="fpl",
        route="SEMBO A464 TOPAS DCT LPN", star="OTBA1B", star_runway="RW18",
        output_every_s=5,
    )
    res = server._generate_one(req)
    assert "LPN" not in [w["ident"] for w in res["route"]]
    trk = [s["track_deg"] for s in res["points"]]
    worst = max(
        abs((trk[i] - trk[i - 1] + 180) % 360 - 180) for i in range(1, len(trk))
    )
    assert worst < 20.0  # was ~175 before the trim


def test_field_vor_gate_ignores_a_non_vor_ending() -> None:
    """The AIP route to VTSP ends on SAVSA (an ordinary fix, not a VOR), so the
    trim must not fire — only routes filed to the field VOR are touched."""
    route = _resolve_route("OLVUK Y26 SAVSA")
    assert not server._ends_at_field_vor(route, "VTSP")


def test_field_vor_gate_ignores_a_distant_vor() -> None:
    """VTUD routes pass the KKN VOR ~55 NM out — a fix on the way, not the field
    navaid — so it is not treated as a terminal-VOR overshoot."""
    route = _resolve_route("ROBKA A1 SELKA Y14 KRT Y23 KKN")
    assert route and route[-1][0] == "KKN"
    assert not server._ends_at_field_vor(route, "VTUD")


def test_vor_that_is_itself_the_entry_is_kept() -> None:
    """VTCC's CMA VOR is a STAR entry — a route to CMA enters the STAR there, so
    CMA is kept, not dropped."""
    idents, trn = _connect("VTCC", "CMA2A", "OLVUK CMA", ProcedureType.STAR)
    assert idents[-1] == "CMA"
    assert trn is None  # CMA2A's single (runway) transition
