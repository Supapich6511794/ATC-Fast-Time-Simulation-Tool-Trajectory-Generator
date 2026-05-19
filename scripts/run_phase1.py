"""Phase 1 end-to-end demo.

Parses a hardcoded FPL, resolves enroute waypoints from the BearCat
GeoPackage, generates a 4D trajectory (lat, lon, time — no altitude
yet), and writes both .gpkg and .csv outputs.

Note: ADEP→first-enroute and last-enroute→ADES legs are NOT included
in Phase 1; SID/STAR integration is Phase 4.

Usage:
    python scripts/run_phase1.py --gpkg bearcat_navdata.gpkg
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
from pathlib import Path

from trajectory_sim.fpl import FlightPlan, parse_route
from trajectory_sim.geodesy import route_distance_nm
from trajectory_sim.navdata import NavData
from trajectory_sim.output import (
    build_trajectory_gdf,
    write_csv,
    write_geopackage,
)


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--gpkg",
        type=Path,
        required=True,
        help="Path to BearCat navdata GeoPackage (bearcat_navdata.gpkg).",
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
    return p.parse_args()


def main() -> None:
    args = _parse_args()

    fpl = FlightPlan(
        callsign="THA204",
        aircraft_type="B738",
        adep="VTBS",
        ades="VTSP",
        eobt=datetime(2026, 1, 3, 8, 15, tzinfo=timezone.utc),
        rfl=330,
        route="DCT KARBI DCT VIBUN DCT LUSMO DCT",
    )

    idents = parse_route(fpl.route)
    print(f"Parsed waypoint idents: {idents}")

    nav = NavData(args.gpkg)
    coords = nav.lookup_waypoints_bulk(idents)
    waypoint_sequence = [coords[ident] for ident in idents]
    print("Resolved coordinates:")
    for ident, (lat, lon) in zip(idents, waypoint_sequence):
        print(f"  {ident}: lat={lat:.4f}, lon={lon:.4f}")

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
    print(f"Trajectory points:   {len(gdf)}")
    print(f"Total distance:      {total_distance_nm:.1f} NM")
    print(f"Total flight time:   {total_time_minutes:.1f} min")
    print(f"GeoPackage written:  {args.out_gpkg}")
    print(f"CSV written:         {args.out_csv}")


if __name__ == "__main__":
    main()
