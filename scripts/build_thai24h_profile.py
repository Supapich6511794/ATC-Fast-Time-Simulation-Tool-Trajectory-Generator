"""Distil a real 24-hour Bangkok-FIR day into a compact traffic profile.

Reads the CAT062 surveillance log for 2025-12-23 (``web/Data/cat062_20251223.csv``,
2.29 M track rows / 2 953 distinct flights) and writes the statistics that
``scripts/make_thai24h_flights.py`` needs to synthesise a *statistically
faithful* 24-hour sample of Thai traffic:

  * **category mix** — domestic / arrival / departure / overflight, where a
    flight is classified by whether its ADEP and ADES are Thai (``VT…``);
  * **hourly EOBT histogram** per category (UTC), i.e. the real diurnal shape;
  * **city pairs** with their observed frequency, per category — so the sample
    reproduces the real route market (VTBS–VTSM, WSSS–VTBS, EGLL–WSSS …);
  * **Bangkok FIR gateways** — for every foreign aerodrome, the Thai enroute
    fixes its flights actually crossed the FIR boundary at. Derived by
    point-in-polygon testing each track against the BANGKOK FIR polygon in
    ``web/public/data/fir.geojson`` and snapping the first/last inside point to
    the nearest AIP waypoint. This is what lets a synthetic overflight enter and
    leave Thai airspace where real ones do;
  * **operator mix** (ICAO callsign prefixes) per category;
  * **cruising-level distribution** per category, from the max measured FL.

Run:  python scripts/build_thai24h_profile.py
Out:  scripts/data/thai24h_profile.json   (checked in; ~2 min to rebuild)
"""

from __future__ import annotations

import argparse
import collections
import csv
import json
import math
import re
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
CAT062_PATH = _ROOT / "web" / "Data" / "cat062_20251223.csv"
AIP_PATH = _ROOT / "web" / "public" / "data" / "aip_VT.json"
FIR_PATH = _ROOT / "web" / "public" / "data" / "fir.geojson"
OUT_PATH = _ROOT / "scripts" / "data" / "thai24h_profile.json"

# Snap distance limit (NM) from an FIR-boundary crossing to the nearest AIP fix.
_SNAP_NM = 80.0
# The log's dep/dest fields are free text for non-aerodrome operations — gas
# fields, hospital helipads, army camps. Only a 4-letter ICAO ident is a usable
# city pair for the generator.
_ICAO_RE = re.compile(r"^[A-Z]{4}$")
# An airline callsign is a 3-letter ICAO operator designator plus a flight
# number (THA602, SIA978). The other 5 % of the log's ACIDs are registrations
# (HSSFC, B652E) or military/word callsigns (HAMMER, BOZZLEE); those flights
# still count towards the traffic statistics, but their first three characters
# are not an operator, so they must not seed the callsign generator.
_AIRLINE_RE = re.compile(r"^[A-Z]{3}\d{1,4}[A-Z]?$")


def _load_waypoints() -> list[tuple[str, float, float]]:
    data = json.loads(AIP_PATH.read_text(encoding="utf-8"))
    return [
        (ident, float(w["lat"]), float(w["lon"]))
        for ident, w in data["waypoints"].items()
    ]


def _load_fir_rings() -> list[list[list[float]]]:
    """Outer rings (lon/lat) of the BANGKOK FIR MultiPolygon."""
    fc = json.loads(FIR_PATH.read_text(encoding="utf-8"))
    feat = next(
        f for f in fc["features"] if f["properties"].get("name") == "BANGKOK FIR"
    )
    return [poly[0] for poly in feat["geometry"]["coordinates"]]


def _make_inside(rings):
    """Ray-casting point-in-polygon over the FIR's outer rings."""

    def inside(lon: float, lat: float) -> bool:
        for ring in rings:
            hit = False
            n = len(ring)
            j = n - 1
            for i in range(n):
                xi, yi = ring[i][0], ring[i][1]
                xj, yj = ring[j][0], ring[j][1]
                if (yi > lat) != (yj > lat) and lon < (
                    (xj - xi) * (lat - yi) / (yj - yi) + xi
                ):
                    hit = not hit
                j = i
            if hit:
                return True
        return False

    return inside


def _make_nearest(waypoints):
    """Nearest AIP fix to a lat/lon, as (distance_nm, ident) — flat-earth NM."""

    def nearest(lat: float, lon: float) -> tuple[float, str]:
        coslat = math.cos(math.radians(lat))
        best_d2, best = None, ""
        for ident, wlat, wlon in waypoints:
            dlat = (wlat - lat) * 60.0
            dlon = (wlon - lon) * 60.0 * coslat
            d2 = dlat * dlat + dlon * dlon
            if best_d2 is None or d2 < best_d2:
                best_d2, best = d2, ident
        return math.sqrt(best_d2 or 0.0), best

    return nearest


def classify(adep: str, ades: str) -> str:
    dep_th, des_th = adep.startswith("VT"), ades.startswith("VT")
    if dep_th and des_th:
        return "domestic"
    if dep_th:
        return "departure"
    if des_th:
        return "arrival"
    return "overflight"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--src", default=str(CAT062_PATH), help="CAT062 CSV log")
    ap.add_argument("--out", default=str(OUT_PATH), help="profile JSON path")
    args = ap.parse_args()

    inside = _make_inside(_load_fir_rings())
    nearest = _make_nearest(_load_waypoints())

    # --- pass 1: fold the 2.3 M track rows down to one record per flight ----
    meta: dict[str, dict] = {}
    with Path(args.src).open(encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(fh):
            key = row["flight_key"]
            lat, lon = float(row["latitude"]), float(row["longitude"])
            try:
                fl = int(float(row["measured_fl"]))
            except (TypeError, ValueError):
                fl = 0
            rec = meta.get(key)
            if rec is None:
                rec = meta[key] = {
                    "acid": row["acid"],
                    "adep": row["dep"].strip().upper(),
                    "ades": row["dest"].strip().upper(),
                    # flight_key tail is the EOBT: "…_YYYY-MM-DD HH:MM" (UTC —
                    # the resulting diurnal curve peaks 01–12 UTC = 08–19 ICT).
                    "hour": int(key.rsplit(" ", 1)[-1].split(":")[0]),
                    "max_fl": fl,
                    "in_first": None,
                    "in_last": None,
                }
            rec["max_fl"] = max(rec["max_fl"], fl)
            if inside(lon, lat):
                if rec["in_first"] is None:
                    rec["in_first"] = (lat, lon)
                rec["in_last"] = (lat, lon)

    # --- pass 2: aggregate -------------------------------------------------
    cats = collections.Counter()
    hourly = {c: [0] * 24 for c in ("domestic", "arrival", "departure", "overflight")}
    pairs = {c: collections.Counter() for c in hourly}
    airlines = {c: collections.Counter() for c in hourly}
    # Operator mix *per city pair* — so a synthetic VTBS-RJAA leg gets THA/ANA,
    # not whichever ICAO prefix happened to be common that day.
    pair_airlines: dict[str, collections.Counter] = collections.defaultdict(
        collections.Counter
    )
    levels = {c: collections.Counter() for c in hourly}
    entry: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    exitp: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    # Overflights: the entry and exit fix as ONE observed crossing corridor.
    # Sampling the two marginals independently would pair a north-west entry
    # with a north-east exit and route the aircraft over the Bangkok TMA far
    # more often than real crossing traffic does.
    corridors: dict[str, collections.Counter] = collections.defaultdict(
        collections.Counter
    )

    for rec in meta.values():
        adep, ades = rec["adep"], rec["ades"]
        if not _ICAO_RE.match(adep) or not _ICAO_RE.match(ades):
            continue
        cat = classify(adep, ades)
        cats[cat] += 1
        hourly[cat][rec["hour"]] += 1
        pairs[cat][f"{adep}-{ades}"] += 1
        acid = rec["acid"].strip().upper()
        if _AIRLINE_RE.match(acid):
            airlines[cat][acid[:3]] += 1
            pair_airlines[f"{adep}-{ades}"][acid[:3]] += 1
        if rec["max_fl"] >= 60:
            # round to the nearest RVSM-ish 10 FL for a compact histogram
            levels[cat][int(round(rec["max_fl"] / 10.0) * 10)] += 1
        gw_in = gw_out = None
        if rec["in_first"] and not adep.startswith("VT"):
            dist, fix = nearest(*rec["in_first"])
            if dist <= _SNAP_NM:
                entry[adep][fix] = entry[adep][fix] + 1
                gw_in = fix
        if rec["in_last"] and not ades.startswith("VT"):
            dist, fix = nearest(*rec["in_last"])
            if dist <= _SNAP_NM:
                exitp[ades][fix] += 1
                gw_out = fix
        if cat == "overflight" and gw_in and gw_out and gw_in != gw_out:
            corridors[f"{adep}-{ades}"][f"{gw_in}|{gw_out}"] += 1

    def _top(counter, n=None):
        items = counter.most_common(n)
        return [[k, v] for k, v in items]

    profile = {
        "_comment": (
            "Traffic profile distilled from the real CAT062 surveillance log for "
            "2025-12-23 (Bangkok FIR). Built by scripts/build_thai24h_profile.py; "
            "consumed by scripts/make_thai24h_flights.py."
        ),
        "source": str(Path(args.src).relative_to(_ROOT)).replace("\\", "/"),
        "day_utc": "2025-12-23",
        "flights_total": sum(cats.values()),
        "category_counts": dict(cats),
        "hourly_utc": hourly,
        "pairs": {c: _top(pairs[c]) for c in pairs},
        "airlines": {c: _top(airlines[c]) for c in airlines},
        "pair_airlines": {p: _top(c) for p, c in sorted(pair_airlines.items())},
        "cruise_fl": {c: _top(levels[c]) for c in levels},
        "gateways": {
            "entry": {a: _top(c, 6) for a, c in sorted(entry.items())},
            "exit": {a: _top(c, 6) for a, c in sorted(exitp.items())},
        },
        # "ADEP-ADES" -> [["ENTRYFIX|EXITFIX", n], …] observed crossings.
        "overflight_corridors": {p: _top(c) for p, c in sorted(corridors.items())},
        # Marginal corridor mix over all overflights — the fallback for a
        # city pair that was flown only once (or not at all) on the sample day.
        "overflight_corridors_all": _top(
            sum(corridors.values(), collections.Counter())
        ),
    }

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(profile, indent=1), encoding="utf-8")

    print(f"Flights: {profile['flights_total']}  {dict(cats)}")
    print(f"Gateways: {len(entry)} entry aerodromes, {len(exitp)} exit aerodromes")
    print(f"Wrote {out}")


if __name__ == "__main__":
    main()
