"""Airspace sector membership for exports — Python twin of web/lib/airspace.ts.

Tags each trajectory sample with the airspace volumes that contain it, so the
download formats (CSV / GeoPackage / GeoJSON) can carry a per-timestamp
"sector" column that matches what the web UI shows on the map and the
altitude-profile chart. Reads the SAME GeoJSON sector files the web app
renders (web/public/data/sectors/): BACC sectors + subsectors, Control Zones
(CTR), Terminal Areas (TMA) and Prohibited/Danger/Restricted areas (PDR).

Membership is ALTITUDE-AWARE: a point belongs only to volumes whose vertical
band contains its altitude ("which sector is the aircraft IN") — a plane at
FL350 is not in a TMA that tops at 11 000 ft. The corrected vertical limits
(sectors_corrected/, fixed against AIP Thailand) are therefore what decides
each label.

The vertical-limit formats differ per layer exactly as on the web: numeric FL
on bacc, numeric feet on tma, and strings like "GND"/"ALT 2000"/"FL 120"/
"UNL" on ctr/pdr. Labels are rendered with the web's compact format, e.g.
``"8S/Bangkok CTR/VTR1"``, and layer hits follow the web's rule: first
feature in file order wins (PDR areas overlap, so they are all listed).
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

import numpy as np
import shapely
from shapely.geometry import shape

# Sector GeoJSONs live with the web app's static data so both sides of the
# stack read the one dataset. `sectors_corrected` has the vertical limits fixed
# against AIP Thailand ENR 2.1 / 5.1 (AIRAC 2026-07-09) — see its CORRECTIONS.md.
# Layer order = display order in the compact label.
_SECTORS_DIR = (
    Path(__file__).resolve().parents[1]
    / "web"
    / "public"
    / "data"
    / "sectors_corrected"
)
_LAYERS: list[tuple[str, str]] = [
    ("bacc", "bacc_geo"),
    ("subsector", "bacc_subsector"),
    ("ctr", "ctr"),
    ("tma", "tma"),
    ("pdr", "pdr"),
]

# Abbreviations kept upper-case when title-casing a zone name for display.
_ZONE_ABBR = {"CTR", "TMA", "FIR", "ACC", "CTA", "ATZ", "TCA", "MTMA", "APP"}

#: Airspace hierarchy — an aircraft is in exactly ONE airspace at a time, so a
#: point inside several overlapping volumes resolves to one (highest priority
#: first), per the BACC ops structure:
#:
#:   1. ``pdr``       — prohibited/danger/restricted. Not an ATS unit, but being
#:                      inside one is the fact that matters, so it overrides.
#:   2. ``ctr``       — Control Zone, worked by Aerodrome Control (Tower).
#:   3. ``tma``       — Terminal Control Area, worked by Approach Control.
#:                      (A CTA would sit here too — none in the Thai dataset.)
#:   4. ``bacc``      — Area Control (ACC). The reporting unit; it carries the
#:                      vertical limits (2S FL270-460, 3S/6S below).
#:   5. ``subsector`` — the horizontal controller-split, INSIDE its sector, so
#:                      with the sector above it a target normally reports the
#:                      sector; the subsector shows only where no sector exists.
#:
#: Annex 11 airspace / ATS-unit structure, applied AFTER the lateral and
#: vertical tests, so an aircraft above a CTR's ceiling has already dropped out
#: of it and falls through to the TMA/ACC below.
#: Must stay in step with HIERARCHY in web/lib/airspace.ts.
_HIERARCHY = ("pdr", "ctr", "tma", "bacc", "subsector")


def parse_alt_ft(v: object, is_fl: bool = False) -> float:
    """Feet from a vertical-limit value (mirror of the web's parseAltFt).

    ``is_fl`` treats a bare number as a flight level. Strings: GND/SFC/MSL ->
    0, UNL -> +inf, "FL 120" -> 12000, "ALT 2000"/bare digits -> feet.
    """
    if v is None:
        return math.nan
    if isinstance(v, (int, float)):
        if isinstance(v, float) and math.isnan(v):
            return math.nan
        return float(v) * 100.0 if is_fl else float(v)
    s = str(v).strip().upper()
    if not s:
        return math.nan
    if s in ("GND", "SFC", "MSL"):
        return 0.0
    if s.startswith("UNL"):
        return math.inf
    fl = re.search(r"FL\s*(\d+)", s)
    if fl:
        return float(fl.group(1)) * 100.0
    n = re.search(r"(\d+)", s)
    return float(n.group(1)) if n else math.nan


def _band(props: dict, layer: str) -> tuple[float, float]:
    """(lo, hi) feet for a feature — each layer codes its limits differently."""
    if layer == "bacc":
        return parse_alt_ft(props.get("lower"), True), parse_alt_ft(
            props.get("upper"), True
        )
    if layer == "subsector":  # no coded band — horizontal only
        return 0.0, math.inf
    if layer == "tma":
        return parse_alt_ft(props.get("lower")), parse_alt_ft(props.get("upper"))
    if layer == "ctr":
        return (
            parse_alt_ft(props.get("lower_1", props.get("lowerlimit"))),
            parse_alt_ft(props.get("upper_1", props.get("upperlimit"))),
        )
    # pdr
    return parse_alt_ft(props.get("lowerlimit")), parse_alt_ft(
        props.get("upperlimit")
    )


def _label(props: dict, layer: str) -> str:
    if layer == "pdr":
        ident = str(props.get("ident") or "").strip()
        name = str(props.get("name") or "").strip()
        return " ".join(p for p in (ident, name) if p) or "PDR"
    return str(props.get("name") or props.get("ident") or "").strip() or (
        layer.upper()
    )


def _title_zone(name: str) -> str:
    """"BANGKOK TMA" -> "Bangkok TMA"; idents with digits (VTD16) kept as-is."""
    out = []
    for w in name.split():
        if any(ch.isdigit() for ch in w):
            out.append(w)
        elif w.upper() in _ZONE_ABBR:
            out.append(w.upper())
        else:
            out.append(w[:1].upper() + w[1:].lower())
    return " ".join(out)


@dataclass
class _Entry:
    label: str
    lo: float
    hi: float


class AirspaceIndex:
    """Per-layer feature metadata + an STRtree over the polygons.

    Whole flights are tagged in one vectorized tree query per layer, then the
    (point, feature) candidate pairs are resolved in file order so the label
    matches the web engine exactly.
    """

    def __init__(
        self,
        entries: dict[str, list[_Entry]],
        trees: dict[str, "shapely.STRtree | None"],
    ):
        self.entries = entries
        self.trees = trees

    def tag(
        self,
        lons: Sequence[float],
        lats: Sequence[float],
        alts_ft: Sequence[float | None],
    ) -> list[str]:
        """Altitude-aware compact sector label for every point of a flight — the
        volume that actually CONTAINS the aircraft at its altitude (a plane at
        FL350 is not in a TMA that tops at 11 000 ft)."""
        n = len(lons)
        pts = shapely.points(
            np.asarray(lons, dtype=float), np.asarray(lats, dtype=float)
        )
        # hits[layer][point] -> labels the point is inside, in file order.
        hits: dict[str, list[list[str]]] = {}
        for layer, _ in _LAYERS:
            per: list[list[str]] = [[] for _ in range(n)]
            tree = self.trees.get(layer)
            entries = self.entries.get(layer, [])
            if tree is not None and n:
                pt_i, ft_i = tree.query(pts, predicate="intersects")
                # Resolve candidates in ascending feature order per point —
                # the web's "first feature wins" rule for non-PDR layers.
                for k in np.lexsort((ft_i, pt_i)):
                    p = int(pt_i[k])
                    e = entries[int(ft_i[k])]
                    alt = alts_ft[p]
                    in_band = (
                        alt is None
                        or layer == "subsector"  # no coded band, horizontal only
                        or (e.lo <= alt <= e.hi)
                    )
                    if in_band and (layer == "pdr" or not per[p]):
                        per[p].append(e.label)
            hits[layer] = per

        def compact(p: int) -> str:
            """The ONE airspace that owns the aircraft here, by _HIERARCHY."""
            for layer in _HIERARCHY:
                got = hits[layer][p]
                if not got:
                    continue
                if layer == "pdr":
                    return ",".join(s.split(" ")[0] for s in got)
                if layer in ("ctr", "tma"):
                    return _title_zone(got[0])
                # 3S/6S are modelled as two altitude slabs (3S_lower/3S_upper);
                # a target is called just "3S"/"6S" (per BACC ops) — the
                # altitude test already picked the right slab. Drop the suffix.
                return re.sub(r"_(lower|upper)$", "", got[0], flags=re.I)
            return ""

        return [compact(p) for p in range(n)]


_INDEX: AirspaceIndex | None = None
_INDEX_FAILED = False


def _load_index() -> AirspaceIndex | None:
    """Build the singleton index; None (and stay quiet) if the data files are
    absent so exports still work in a deployment without the web assets."""
    global _INDEX, _INDEX_FAILED
    if _INDEX is not None or _INDEX_FAILED:
        return _INDEX
    entries: dict[str, list[_Entry]] = {}
    trees: dict[str, shapely.STRtree | None] = {}
    try:
        for layer, fname in _LAYERS:
            path = _SECTORS_DIR / f"{fname}.geojson"
            fc = json.loads(path.read_text(encoding="utf-8"))
            es: list[_Entry] = []
            geoms = []
            for f in fc.get("features", []):
                geom_json = f.get("geometry")
                if not geom_json or geom_json.get("type") not in (
                    "Polygon",
                    "MultiPolygon",
                ):
                    continue
                props = f.get("properties") or {}
                lo, hi = _band(props, layer)
                es.append(
                    _Entry(
                        label=_label(props, layer),
                        lo=lo if not math.isnan(lo) else -math.inf,
                        hi=hi if not math.isnan(hi) else math.inf,
                    )
                )
                geoms.append(shape(geom_json))
            entries[layer] = es
            trees[layer] = shapely.STRtree(geoms) if geoms else None
        _INDEX = AirspaceIndex(entries, trees)
    except (OSError, ValueError, KeyError):
        _INDEX_FAILED = True
        return None
    return _INDEX


def sector_columns(
    lons: Sequence[float],
    lats: Sequence[float],
    alts_ft: Sequence[float | None],
) -> list[str]:
    """Per-point altitude-aware sector label for a whole flight — one compact
    string per input point ("" when the point is outside every volume at its
    altitude, or when the sector data isn't available)."""
    lons = list(lons)
    lats = list(lats)
    alts = list(alts_ft)
    idx = _load_index()
    if idx is None:
        return [""] * len(lons)
    return idx.tag(lons, lats, alts)
