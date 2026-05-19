"""Phase 1 end-to-end demo driven by a pre-resolved airway CSV.

This is the alternative entry point for the case where the route arrives
already resolved as consecutive airway legs (the supervisor-provided
``VTPStoVTBS.csv``) instead of as an FPL route string + ``bearcat_navdata.gpkg``.

Pipeline:
    VTPStoVTBS.csv  --load_route_csv-->  ordered [(lat, lon), ...]
                    --build_trajectory_gdf-->  4D trajectory (lat, lon, time)
                    --write_geopackage / write_csv-->  sim_output.{gpkg,csv}

Notes / Phase 1 scope:
  - Ground speed is the Phase 1 placeholder (450 kt, constant). Real
    speed/altitude profiles are Phase 2 & 3.
  - The route is the enroute airway (BKK..PUT). ADEP->first-enroute and
    last-enroute->ADES legs (SID/STAR) are Phase 4, so they are excluded.
  - The CSV does NOT contain the CAT62 surveillance track, so this only
    produces the simulated trajectory; quantitative validation against
    real radar still needs the cat62 data from the supervisor.

Usage:
    python scripts/run_phase1_csv.py
    python scripts/run_phase1_csv.py --csv path/to/VTPStoVTBS.csv --bkk-to-put
"""

from __future__ import annotations

import argparse
from pathlib import Path

from trajectory_sim.fpl import FlightPlan, parse_eobt
from trajectory_sim.geodesy import route_distance_nm
from trajectory_sim.navdata import load_route_csv
from trajectory_sim.output import (
    build_trajectory_gdf,
    write_csv,
    write_geopackage,
)

# The supervisor dropped the CSV inside the web viewer's data folder; default
# to it but allow an override. Path is relative to the project root (run the
# script from there: `python scripts/run_phase1_csv.py`).
_DEFAULT_CSV = Path("web/public/data/VTPStoVTBS.csv")


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--csv",
        type=Path,
        default=_DEFAULT_CSV,
        help=f"Airway-segment route CSV (default: {_DEFAULT_CSV}).",
    )
    p.add_argument(
        "--out-gpkg",
        type=Path,
        default=Path("sim_output.gpkg"),
        help="Output GeoPackage path (default: sim_output.gpkg).",
    )
    p.add_argument(
        "--out-csv",
        type=Path,
        default=Path("sim_output.csv"),
        help="Output CSV path (default: sim_output.csv).",
    )
    p.add_argument(
        "--bkk-to-put",
        action="store_true",
        help=(
            "Fly the CSV's natural seqno order (Bangkok -> Phuket, "
            "VTBS -> VTSP). Default is the file's named direction: "
            "Phuket -> Bangkok (VTSP -> VTBS)."
        ),
    )
    p.add_argument(
        "--eobt",
        type=str,
        default="2026-01-03T08:15:00Z",
        help="Estimated Off-Block Time, ISO 8601 UTC (default: "
        "2026-01-03T08:15:00Z).",
    )
    p.add_argument(
        "--callsign",
        type=str,
        default="SIM738",
        help="Callsign for the simulated flight (default: SIM738).",
    )
    return p.parse_args()




def main() -> None:
    args = _parse_args()

    # Default direction follows the filename: VTPS -> VTBS (Phuket ->
    # Bangkok), which is the *reverse* of the CSV's seqno order.
    reverse = not args.bkk_to_put
    if reverse:
        adep, ades = "VTSP", "VTBS"
    else:
        adep, ades = "VTBS", "VTSP"

    route = load_route_csv(args.csv, reverse=reverse)
    idents = [w.ident for w in route]
    waypoint_sequence = [(w.lat, w.lon) for w in route]

    eobt = parse_eobt(args.eobt)

    # FlightPlan is built mainly for metadata/validation; parse_route is
    # bypassed because the CSV is already a resolved waypoint chain.
    fpl = FlightPlan(
        callsign=args.callsign,
        aircraft_type="B738",
        adep=adep,
        ades=ades,
        eobt=eobt,
        rfl=330,
        route=" ".join(idents),
    )

    print(f"Route ({adep} -> {ades}): {' '.join(idents)}")
    print("Resolved coordinates:")
    for w in route:
        print(f"  {w.ident:<6} lat={w.lat:9.5f}  lon={w.lon:10.5f}")

    gdf = build_trajectory_gdf(
        waypoint_sequence=waypoint_sequence,
        eobt=fpl.eobt,
        callsign=fpl.callsign,
        aircraft_type=fpl.aircraft_type,
        adep=fpl.adep,
        ades=fpl.ades,
        rfl=fpl.rfl,
    )

    write_geopackage(gdf, args.out_gpkg)
    write_csv(gdf, args.out_csv)

    total_distance_nm = route_distance_nm(waypoint_sequence)
    elapsed = gdf["epoch_ts"].iloc[-1] - gdf["epoch_ts"].iloc[0]
    total_time_minutes = elapsed.total_seconds() / 60.0

    print()
    print(f"Waypoints:           {len(route)}")
    print(f"Trajectory points:   {len(gdf)}")
    print(f"Total distance:      {total_distance_nm:.1f} NM")
    print(f"Total flight time:   {total_time_minutes:.1f} min "
          f"(@ 450 kt Phase 1 placeholder)")
    print(f"GeoPackage written:  {args.out_gpkg}")
    print(f"CSV written:         {args.out_csv}")


if __name__ == "__main__":
    main()
