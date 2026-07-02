"""Validate a simulated flight against the real CAT062 track for its pair.

Reports the three altitude/time acceptance metrics together:

  * Top-of-climb altitude vs the real track  (< 2000 ft)   [criterion 1]
  * Cruise altitude vs the FPL RFL (exact)                  [criterion 2]
  * Total flight time vs the real track       (< 5 min)    [criterion 4]

The real reference comes from the raw CAT062 log (default
``web/Data/cat062_20251223.csv``), reduced per flight by
``trajectory_sim.cat62_track``. Because real tracks include ATC
vectoring/holding the clean sim does not model, the time reference is
aggregated across the pair's flights with a selectable method
(``--time-agg``, default ``p10`` = a fast/clean flight); the cruise-level
reference uses the median.

Example::

    python scripts/validate_cat62_track.py --adep VTBS --ades VTSP \
        --route "BKK Y8 PUT" --rfl 350
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from trajectory_sim.cat62_track import (  # noqa: E402
    load_real_tracks,
    pair_cruise_reference_ft,
    pair_time_reference_min,
)
from trajectory_sim.performance import service_ceiling_ft  # noqa: E402
from trajectory_sim.trajectory import build_flight_timeline  # noqa: E402
from trajectory_sim.validation import (  # noqa: E402
    validate_cruise_level,
    validate_flight_time,
    validate_toc_altitude,
)
from validate_flight_time import _expand_route, _load_aip  # noqa: E402

_DEFAULT_CAT62 = _ROOT / "web" / "Data" / "cat062_20251223.csv"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
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
        "--cat62",
        type=Path,
        default=_DEFAULT_CAT62,
        help="Raw CAT062 CSV (default: web/Data/cat062_20251223.csv)",
    )
    ap.add_argument(
        "--time-agg",
        default="p10",
        help="Time reference across flights: min|mean|median|pNN (default p10)",
    )
    args = ap.parse_args(argv)

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
    profile = timeline.profile
    simulated_min = timeline.total_time_s / 60.0
    rfl_ft = args.rfl * 100.0
    route = f"{args.adep.upper()}-{args.ades.upper()}"

    if not args.cat62.exists():
        print(f"[error] CAT062 log not found: {args.cat62}", file=sys.stderr)
        return 2
    # Stream only this pair's flights out of the (large) log.
    tracks = load_real_tracks(args.cat62, pairs=[(args.adep, args.ades)])
    real_time = pair_time_reference_min(tracks, args.adep, args.ades, args.time_agg)
    real_toc = pair_cruise_reference_ft(tracks, args.adep, args.ades, "median")

    print(
        f"[route] {len(seq)} fixes | "
        f"{timeline.total_distance_nm:.1f} NM | RFL F{args.rfl}"
    )
    print(
        f"[real]  {len(tracks)} CAT062 flights for {route} "
        f"| time-agg={args.time_agg}"
    )
    print()

    passed = True

    # Criterion 2 — simulated cruise vs FPL RFL (exact; real clamps PASS).
    lvl = validate_cruise_level(
        rfl_ft=rfl_ft,
        cruise_alt_ft=profile.cruise_alt_ft,
        service_ceiling_ft=service_ceiling_ft(args.actype),
        climb_top_ft=profile.climb_top_ft,
        reaches_rfl=profile.reaches_ft(rfl_ft),
        route=route,
    )
    print(lvl.report())
    print()
    passed = passed and lvl.passed

    # Criterion 1 — simulated top-of-climb vs real track (< 2000 ft).
    if real_toc is not None:
        toc = validate_toc_altitude(profile.cruise_alt_ft, real_toc, route=route)
        print(toc.report())
        passed = passed and toc.passed
    else:
        print(f"Route: {route}\nSimulated TOC: FL{profile.cruise_alt_ft / 100:.0f}")
        print("Status: NO REAL TRACK for this pair")
    print()

    # Criterion 4 — simulated total time vs real track (< 5 min).
    if real_time is not None:
        tv = validate_flight_time(
            route, cat62_min=real_time, simulated_min=simulated_min, source="cat62"
        )
        print(tv.report())
        passed = passed and tv.passed
    else:
        print(f"Route: {route}\nSimulated Time: {simulated_min:.0f} min")
        print("Status: NO REAL TRACK for this pair")

    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
