"""Generate a FLIGHT-PLAN bank that cannot all be cleared off the same runway.

Every other dummy file in this folder is a bank of generated 4D trajectories.
This one is deliberately NOT: it is a list of filed plans, because the thing it
exercises happens before anything is flown. Two FPLs out of the same aerodrome,
on the same runway, at the same EOBT is a clearance problem — the tower cannot
release the second aircraft — and the CD&R engine cannot see it, since that
works on generated paths. `web/lib/departureSeparation.ts` checks the plans
themselves and the panel raises it the moment the file is IMPORTED.

The bank is built so that each ICAO Doc 4444 (PANS-ATM) rule in that module has
one pair demonstrating it, plus controls that must stay silent:

  VTCC  02:00  THA100 / THA200   §7.9.2    runway not yet clear ......  1 min
  VTBS  02:20  UAE300 / AIQ301   §5.8.3.1  MEDIUM behind HEAVY ......   2 min
  VTBS  02:40  TGW400 / THA401   §5.6.3    climbs through its level ..  5 min
  VTBS  03:00  SIA500 / JAL501   §5.6.2    leader 50 kt faster ......   2 min
  VTBS  03:20  KAL600 / BAW601   §5.6.1    tracks 144 deg apart .....   1 min  OK
  VTBS  03:40  QTR700 / MAS701   different runways ................         OK
  VTCC  04:00  ANA800 / CPA801   5 minutes apart ..................         OK

The first four pairs are conflicts; the last three are the controls — a bank
that only contained violations could not show that the rules also let traffic
go. §5.8.3.2 (3 minutes off an intersection) has no pair here: the plan editor
has no intersection-departure field, so a file cannot express one. The rule is
implemented and unit-tested.

Routes are the real filed AIP routes for each city pair, so every plan also
generates cleanly with "Generate all" once the EOBTs are sorted out.

Output (the plan-list CSV the app's importer reads — callsign,actype,adep,...):
  dummy_data/departure_conflict_flights.csv

Every plan is generated once through the real backend before the file is
written, so a route the resolver cannot fly is caught here rather than in the
UI. Pass --no-verify to skip that.

Run:  python scripts/make_departure_conflict_flights.py
"""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))

OUT = _ROOT / "dummy_data" / "departure_conflict_flights.csv"
ROUTES_PATH = _ROOT / "web" / "public" / "data" / "aip_routes_VT.json"

DAY = "2026-01-03"

#: One row per filed plan. `rwy` is left blank on the VTCC pair on purpose —
#: "Auto" means the aerodrome's default runway, which is the same runway the
#: other flight gets, and the checker has to pair them anyway.
#: (callsign, actype, adep, ades, hhmm, rfl, gs, rwy)
PLANS = [
    # -- §7.9.2: nothing else applies, so what is left is the runway itself.
    #    Identical types, levels and speeds; both filed for 02:00.
    ("THA100", "B738", "VTCC", "VTBS", "02:00", 350, 450, ""),
    ("THA200", "B738", "VTCC", "VTSP", "02:00", 350, 450, ""),

    # -- §5.8.3.1: MEDIUM behind HEAVY on the same runway needs 2 min; filed 1.
    ("UAE300", "B77W", "VTBS", "VTCC", "02:20", 360, 460, "RW19"),
    ("AIQ301", "A320", "VTBS", "VTCP", "02:21", 320, 450, "RW19"),

    # -- §5.6.3: same track and the follower is filed 10 000 ft above the
    #    aircraft ahead, so it climbs through its level: 5 min. Filed 2.
    ("TGW400", "A320", "VTBS", "VTCL", "02:40", 260, 450, "RW19"),
    ("THA401", "A320", "VTBS", "VTCN", "02:42", 360, 450, "RW19"),

    # -- §5.6.2: same track, same category, but the leader is 50 kt faster and
    #    will run away from the follower: 2 min. Filed 1.
    ("SIA500", "B789", "VTBS", "VTPO", "03:00", 350, 500, "RW19"),
    ("JAL501", "B789", "VTBS", "VTPP", "03:01", 350, 450, "RW19"),

    # -- CONTROL, §5.6.1: VTBS to VTUD leaves via SELKA (059 deg) and VTBS to
    #    VTSP via VANKO (221 deg) — 162 deg apart, so lateral separation exists
    #    immediately after take-off and 1 minute is enough. Filed exactly 1.
    ("KAL600", "B738", "VTBS", "VTUD", "03:20", 350, 450, "RW19"),
    ("BAW601", "B738", "VTBS", "VTSP", "03:21", 350, 450, "RW19"),

    # -- CONTROL: same aerodrome, same minute, different runways.
    ("QTR700", "B738", "VTBS", "VTSB", "03:40", 350, 450, "RW19"),
    ("MAS701", "B738", "VTBS", "VTSG", "03:40", 350, 450, "RW01"),

    # -- CONTROL: comfortably spaced, 5 minutes apart.
    ("ANA800", "B738", "VTCC", "VTBD", "04:00", 320, 450, ""),
    ("CPA801", "B738", "VTCC", "VTSF", "04:05", 320, 450, ""),
]


def _routes() -> dict[tuple[str, str], str]:
    """Filed AIP route per city pair, RNAV preferred."""
    raw = json.loads(ROUTES_PATH.read_text(encoding="utf-8"))["routes"]
    out: dict[tuple[str, str], str] = {}
    for r in sorted(raw, key=lambda r: not r.get("rnav")):
        out.setdefault((r["adep"], r["ades"]), r["route"])
    return out


def _verify(rows: list[dict]) -> None:
    """Every plan must actually generate.

    A plan file only looks harmless: a filed AIP route can still be one the
    resolver cannot fly (VTBS-VTUU is filed as the bare "SELKA A1", which has
    no second waypoint), and the fixture is meant to be usable with "Generate
    all" once the EOBTs are fixed. Cheaper to find that here than in the UI.
    """
    from fastapi.testclient import TestClient  # noqa: PLC0415

    from api.server import app  # noqa: PLC0415

    client = TestClient(app)
    bad = []
    for r in rows:
        resp = client.post(
            "/api/generate",
            json={
                "source": "fpl",
                "callsign": r["callsign"],
                "actype": r["actype"],
                "adep": r["adep"],
                "ades": r["ades"],
                "route": r["route"],
                "eobt": r["eobt"].replace("Z", ""),
                "rfl": r["rfl"],
                "gs_kt": r["gs"],
            },
        )
        if resp.status_code != 200:
            bad.append(f"{r['callsign']} {r['adep']}->{r['ades']}: {resp.text[:120]}")
    if bad:
        raise SystemExit("Plans that do not generate:\n  " + "\n  ".join(bad))
    print(f"Verified: {len(rows)}/{len(rows)} plans generate")


def main() -> None:
    routes = _routes()
    rows = []
    for cs, actype, adep, ades, hhmm, rfl, gs, rwy in PLANS:
        route = routes.get((adep, ades))
        if route is None:
            raise SystemExit(f"No filed AIP route for {adep}->{ades}")
        rows.append({
            "callsign": cs,
            "actype": actype,
            "adep": adep,
            "ades": ades,
            "eobt": f"{DAY}T{hhmm}:00Z",
            "rfl": rfl,
            "gs": gs,
            "dep_rwy": rwy,
            "route": route,
        })

    if "--no-verify" not in sys.argv:
        _verify(rows)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(
            f,
            fieldnames=[
                "callsign", "actype", "adep", "ades", "eobt",
                "rfl", "gs", "dep_rwy", "route",
            ],
        )
        w.writeheader()
        w.writerows(rows)

    print(f"Plans:   {len(rows)} ({len({r['adep'] for r in rows})} aerodromes)")
    print(f"Window:  {rows[0]['eobt']} .. {rows[-1]['eobt']}")
    print(f"CSV:     {OUT}")


if __name__ == "__main__":
    main()
