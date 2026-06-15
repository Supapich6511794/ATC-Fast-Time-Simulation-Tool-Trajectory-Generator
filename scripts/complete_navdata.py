"""Complete the scraped AIP waypoint cache from the richer GIS GeoJSON.

The eAIP scrape (``scripts/ingest_aip.py`` → ``aip_VT.json``) only captures
ENR 4.4 "significant points", so it MISSES many fixes that real filed routes
use — notably the VTBD/VTBS arrival IAWP fixes (NAKON, NORTA, SEHNA, TUMGA,
WEHHA, WILLA, ENDUU, EASTE) and some enroute fixes (SAPUD, NTW, …). Those
points DO exist in the project's GIS layers (``airway_waypoint.geojson``,
``star/star_waypoint.geojson``, …), where each carries its own
``waypoint_identifier`` + ``waypoint_latitude``/``waypoint_longitude``.

This script merges any ident present in those GeoJSON layers but missing from
``aip_VT.json`` into its ``waypoints`` map, so the server's resolver
(`_airway_waypoint_index`) can resolve every fix the AIP routes reference.

Additive + idempotent: existing waypoints are never overwritten, so the
authoritative ENR 4.4 coordinates win where they exist. Re-run any time the
GIS layers or the scrape change.

    python scripts/complete_navdata.py            # merge + write
    python scripts/complete_navdata.py --dry-run  # report only
"""

from __future__ import annotations

import argparse
import glob
import json
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
_AIP = _ROOT / "web" / "public" / "data" / "aip_VT.json"
_DATA = _ROOT / "web" / "public" / "data"

# GeoJSON layers that publish point fixes with their own lat/lon properties.
# Only the *primary* ``waypoint_identifier`` is trusted — a segment's second
# endpoint (``waypoint_identifier_2``) does NOT match the row's lat/lon.
_LAYERS = (
    "airway_waypoint.geojson",
    "star/star_waypoint.geojson",
    "airways/airways_reporting.geojson",
)


def _coerce(v: object) -> float | None:
    try:
        f = float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return f if -90.0 <= f <= 360.0 else None


def _gather_geojson_fixes() -> dict[str, tuple[float, float]]:
    """ident -> (lat, lon) from the GIS layers (first occurrence wins)."""
    out: dict[str, tuple[float, float]] = {}
    seen_files: list[str] = []
    for rel in _LAYERS:
        fp = _DATA / rel
        if not fp.is_file():
            continue
        seen_files.append(rel)
        gj = json.loads(fp.read_text(encoding="utf-8"))
        for feat in gj.get("features", []):
            p = feat.get("properties") or {}
            ident = p.get("waypoint_identifier")
            lat = _coerce(p.get("waypoint_latitude"))
            lon = _coerce(p.get("waypoint_longitude"))
            if ident and lat is not None and lon is not None:
                out.setdefault(
                    str(ident).strip().upper(), (round(lat, 6), round(lon, 6))
                )
            # Segment-END fix (airway_waypoint LineStrings carry the next fix
            # as waypoint_identifier_2; its coordinate is the line's last
            # point, NOT the primary lat/lon). This recovers fixes like NTW.
            ident2 = p.get("waypoint_identifier_2")
            geom = feat.get("geometry") or {}
            coords = geom.get("coordinates") or []
            if ident2 and geom.get("type") == "LineString" and len(coords) >= 2:
                lon2, lat2 = _coerce(coords[-1][0]), _coerce(coords[-1][1])
                if lat2 is not None and lon2 is not None:
                    out.setdefault(
                        str(ident2).strip().upper(),
                        (round(lat2, 6), round(lon2, 6)),
                    )
    print(f"  scanned layers: {', '.join(seen_files)}")
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="report, don't write")
    args = ap.parse_args()

    data = json.loads(_AIP.read_text(encoding="utf-8"))
    wpts: dict[str, dict[str, float]] = data["waypoints"]
    before = len(wpts)

    gis = _gather_geojson_fixes()
    added: list[str] = []
    for ident, (lat, lon) in gis.items():
        if ident not in wpts:
            wpts[ident] = {"lat": lat, "lon": lon}
            added.append(ident)

    print(f"  aip_VT.json waypoints: {before} -> {before + len(added)}")
    print(f"  added {len(added)} fixes from GIS layers")
    if added:
        sample = ", ".join(sorted(added)[:20])
        print(f"  e.g. {sample}{' …' if len(added) > 20 else ''}")

    if args.dry_run:
        print("  (dry-run: nothing written)")
        return
    if not added:
        print("  nothing to add; file unchanged.")
        return

    _AIP.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"  wrote {_AIP.relative_to(_ROOT)}")


if __name__ == "__main__":
    main()
