"""Tests for SID/STAR auto-suggestion — the best-connecting procedure for a
route (``api.server._suggest_procedure``).

Uses the real bundled navdata (``aip_VT.json`` airways + SID/STAR GeoJSON)
because the ranking depends on real airway membership and each procedure's
exit fix — the whole point is picking the SID whose exit lands ON the filed
route even when the route is filed off a VOR that names no SID.
"""

from __future__ import annotations

from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[2]
_SID = _ROOT / "web" / "public" / "data" / "aixm" / "sid_waypoint.geojson"
_AIP = _ROOT / "web" / "public" / "data" / "aip_VT.json"

pytestmark = pytest.mark.skipif(
    not (_SID.is_file() and _AIP.is_file()),
    reason="bundled navdata not present",
)


def _ctx(route: str, proc_type):
    from api import server
    from api.server import _airway_waypoint_index, _expand_airways, _route_ctx
    from trajectory_sim.fpl import parse_route

    idx = _airway_waypoint_index()
    pts = [(i, *idx[i]) for i in parse_route(_expand_airways(route)) if i in idx]
    return _route_ctx(pts, proc_type)


def test_sid_whose_exit_lies_on_the_route_wins() -> None:
    # VTSF SIDs are named for their exit fix (GIFB1A→UPNEP, TAWI1A→PINUN, …)
    # and routes are filed off the NKS VOR, which no SID exits at. The SID
    # that delivers ONTO the filed path (its exit is an expanded route fix)
    # must win over the one merely nearest to NKS.
    from api import server
    from api.server import _suggest_procedure
    from trajectory_sim.navdata import ProcedureType as PT

    nav = server._navdata()
    # A464 threads UPNEP → GIFB1A (exit UPNEP).
    r_a464 = "NKS W94 GUPMO A464 GUTSO DCT SABAI"
    assert (
        _suggest_procedure(nav, "VTSF", PT.SID, _ctx(r_a464, PT.SID), "RW01")
        == "GIFB1A"
    )
    # W35 threads PINUN → TAWI1A (exit PINUN).
    r_w35 = "NKS W35 PINUN M769 GOKEX"
    assert (
        _suggest_procedure(nav, "VTSF", PT.SID, _ctx(r_w35, PT.SID), "RW01")
        == "TAWI1A"
    )


def test_sid_exact_first_fix_match() -> None:
    # When the route's first fix IS a SID exit, that SID is picked (tier 0).
    from api import server
    from api.server import _suggest_procedure
    from trajectory_sim.navdata import ProcedureType as PT

    nav = server._navdata()
    ctx = _ctx("OLVUK Y26 MARNI", PT.SID)
    assert _suggest_procedure(nav, "VTBD", PT.SID, ctx, "RW03L") == "OLVU1B"


def test_suggest_none_without_route() -> None:
    from api import server
    from api.server import _suggest_procedure
    from trajectory_sim.navdata import ProcedureType as PT

    nav = server._navdata()
    assert _suggest_procedure(nav, "VTSF", PT.SID, None, "RW01") is None


def test_approach_iaf_scored_on_its_entry_not_the_mapt() -> None:
    # An approach's IAF (its FIRST fix) — not the shared MAPt (its last fix) —
    # must drive transition scoring, else every IAF looks identical. A route
    # arriving at NKS then picks the IAF nearest that fix (TAWIT), giving the
    # AIP flow NKS → TAWIT(IAF) → NSTNI(IF) → NSTNF(FAF) → RWY19.
    from api import server
    from api.server import _resolve_procedure_auto
    from trajectory_sim.navdata import ProcedureType as PT

    nav = server._navdata()
    proc, _ = _resolve_procedure_auto(
        nav, "VTSF", "R19", proc_type=PT.APPROACH,
        route_ctx=_ctx("KASNI M757 LOSDA Y94 NKS", PT.APPROACH),
    )
    assert proc.transition == "TAWIT"
    assert [w.ident for w in proc.waypoints()] == [
        "TAWIT", "NSTNI", "NSTNF", "MA19",
    ]
