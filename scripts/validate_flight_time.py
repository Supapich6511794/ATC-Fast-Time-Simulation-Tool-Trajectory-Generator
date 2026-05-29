"""Validate simulated total flight time against the CAT62 reference.

Builds a variable-speed timeline for a route, compares its total flight
time to the CAT62 reference for the city pair, and prints a PASS/FAIL
report. Speed-schedule parameters can be tuned from the command line so
you can re-run until the delta is within 5 minutes.

Examples
--------
Validate the canonical Y8 corridor::

    python scripts/validate_flight_time.py --adep VTBS --ades VTSP \
        --route "BKK Y8 PUT" --rfl 350

Tune the schedule and re-check (slower cruise → longer time)::

    python scripts/validate_flight_time.py --adep VTBS --ades VTSP \
        --route "BKK Y8 PUT" --rfl 350 \
        --cruise-mach 0.74 --climb-cas 280 --descent-cas 280

Disable the 250 kt restriction below FL100::

    python scripts/validate_flight_time.py ... --restrict-cas 9999

Waypoint coordinates come from the AIP cache
(``web/public/data/aip_VT.json``); airway designators in --route are
expanded automatically.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))

from trajectory_sim.performance import (  # noqa: E402
    aircraft_speeds,
    get_speed_restriction,
    set_speed_restriction,
    tune_speed_schedule,
)
from trajectory_sim.trajectory import build_flight_timeline  # noqa: E402
from trajectory_sim.validation import CAT62Reference  # noqa: E402

_AIP_PATH = _ROOT / "web" / "public" / "data" / "aip_VT.json"


def _load_aip() -> tuple[dict, dict]:
    data = json.loads(_AIP_PATH.read_text(encoding="utf-8"))
    return data.get("waypoints", {}), data.get("airways", {})


def _expand_route(tokens: list[str], airways: dict[str, list[str]]) -> list[str]:
    """Expand `<fix> <airway> <fix>` spans and drop DCT / airway tokens."""
    out: list[str] = []
    i = 0
    while i < len(tokens):
        out.append(tokens[i])
        if (
            i + 2 < len(tokens)
            and tokens[i + 1] in airways
            and tokens[i] in airways[tokens[i + 1]]
            and tokens[i + 2] in airways[tokens[i + 1]]
        ):
            seq = airways[tokens[i + 1]]
            a, b = seq.index(tokens[i]), seq.index(tokens[i + 2])
            step = 1 if a < b else -1
            for k in range(a + step, b, step):
                out.append(seq[k])
        i += 1
    return [t for t in out if t != "DCT" and t not in airways]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--adep", required=True, help="Departure ICAO, e.g. VTBS")
    ap.add_argument("--ades", required=True, help="Destination ICAO, e.g. VTSP")
    ap.add_argument(
        "--route",
        required=True,
        help='Item-15 route, e.g. "BKK Y8 PUT" (airways auto-expanded)',
    )
    ap.add_argument("--actype", default="B738", help="ICAO aircraft type")
    ap.add_argument("--rfl", type=int, default=350, help="RFL in FL (e.g. 350)")
    ap.add_argument(
        "--reference",
        type=Path,
        default=None,
        help="CAT62 reference JSON (default: bundled cat62_reference.json)",
    )
    # --- speed-schedule tuning knobs ---
    ap.add_argument("--climb-cas", type=float, help="Climb CAS (kt)")
    ap.add_argument("--climb-mach", type=float, help="Climb Mach")
    ap.add_argument("--cruise-mach", type=float, help="Cruise Mach")
    ap.add_argument("--descent-mach", type=float, help="Descent Mach")
    ap.add_argument("--descent-cas", type=float, help="Descent CAS (kt)")
    ap.add_argument(
        "--restrict-cas",
        type=float,
        help="Below-FL100 CAS cap (kt); use 9999 to disable",
    )
    args = ap.parse_args(argv)

    # Apply tuning before building the timeline.
    if any(
        v is not None
        for v in (
            args.climb_cas,
            args.climb_mach,
            args.cruise_mach,
            args.descent_mach,
            args.descent_cas,
        )
    ):
        tune_speed_schedule(
            args.actype,
            climb_cas_kt=args.climb_cas,
            climb_mach=args.climb_mach,
            cruise_mach=args.cruise_mach,
            descent_mach=args.descent_mach,
            descent_cas_kt=args.descent_cas,
        )
    if args.restrict_cas is not None:
        set_speed_restriction(cas_kt=args.restrict_cas)

    # Resolve the route to a (lat, lon) sequence from the AIP cache.
    waypoints, airways = _load_aip()
    idents = _expand_route(args.route.upper().split(), airways)
    seq: list[tuple[float, float]] = []
    missing: list[str] = []
    for ident in idents:
        wp = waypoints.get(ident)
        if wp:
            seq.append((wp["lat"], wp["lon"]))
        else:
            missing.append(ident)
    if missing:
        print(f"[warn] not in AIP cache, skipped: {', '.join(missing)}")
    if len(seq) < 2:
        print("[error] route resolved to fewer than 2 known fixes", file=sys.stderr)
        return 2

    timeline = build_flight_timeline(
        waypoint_sequence=seq,
        aircraft_type=args.actype,
        adep=args.adep,
        ades=args.ades,
        rfl_ft=args.rfl * 100.0,
        eobt=datetime(2026, 1, 1, 0, 0, tzinfo=timezone.utc),
    )
    simulated_min = timeline.total_time_s / 60.0

    # Echo the active speed schedule so a tuning run is self-documenting.
    sched = aircraft_speeds(args.actype)
    cap_cas, cap_alt = get_speed_restriction()
    print(
        f"[schedule] climb {sched.climb_cas_kt:.0f}kt/M{sched.climb_mach:.3f} "
        f"| cruise M{sched.cruise_mach:.3f} "
        f"| descent M{sched.descent_mach:.3f}/{sched.descent_cas_kt:.0f}kt "
        f"| restrict {cap_cas:.0f}kt <{cap_alt:.0f}ft"
    )
    print(
        f"[route] {len(seq)} fixes | "
        f"{timeline.total_distance_nm:.1f} NM | RFL F{args.rfl}"
    )
    print()

    ref = CAT62Reference.load(args.reference)
    result = ref.validate(args.adep, args.ades, simulated_min)
    if result is None:
        print(
            f"Route: {args.adep.upper()}-{args.ades.upper()}\n"
            f"Simulated Time: {simulated_min:.0f} min\n"
            "Status: NO REFERENCE (add this pair to cat62_reference.json)"
        )
        return 0

    print(result.report())
    return 0 if result.passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
