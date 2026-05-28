"""Ingest Thai eAIP navdata (CAAT) into a local JSON cache.

The CAAT publication at https://aip.caat.or.th is an *electronic AIP* —
a frameset of HTML pages, not a REST/JSON API. AIP data is fixed for the
whole 28-day AIRAC cycle, so the right design is to scrape + parse it
**once per cycle** into a local file the API reads instantly, rather than
hit the government site on every request.

This script fetches and parses:
  * ENR 4.4  — Name-Code Designators for Significant Points (waypoints)
  * ENR 3.1  — Lower/Upper conventional ATS routes (airways)
  * ENR 3.3  — Area-navigation (RNAV) routes, incl. Y8
  * AD 1.3   — Index of aerodromes (ICAO + name)
  * AD 2.*   — Per-aerodrome ARP coordinates + field elevation

…and writes ``web/public/data/aip_VT.json``::

    {
      "airac": "2026-05-14",
      "source_url": "https://aip.caat.or.th/2026-05-14-AIRAC/html/eAIP/",
      "fetched_at_utc": "2026-05-28T...Z",
      "waypoints": { "VANKO": {"lat": 12.5864, "lon": 99.7606}, ... },
      "airways":   { "Y8": ["BKK", "MOTNA", "SABIS", "VANKO", ...], ... },
      "airports":  { "VTBS": {"lat": 13.6858, "lon": 100.7489,
                              "elev_ft": 8.0, "name": "BANGKOK/SUVARNABHUMI…"}, ... }
    }

Pass ``--skip-aerodromes`` to refresh only waypoints/airways quickly (the
AD section is ~47 large pages and takes a few minutes to crawl).

Re-run when a new AIRAC cycle is published::

    python scripts/ingest_aip.py --airac 2026-06-11

Parsing is dependency-free (stdlib ``urllib`` + ``re``) so it runs on the
same venv as the rest of the project with no extra installs.
"""

from __future__ import annotations

import argparse
import json
import re
import ssl
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
_OUT_DEFAULT = _ROOT / "web" / "public" / "data" / "aip_VT.json"

_BASE = "https://aip.caat.or.th/{airac}-AIRAC/html/eAIP/"
_ENR_PAGES = {
    "waypoints": "VT-ENR-4.4-en-GB.html",
    "airways_conv": "VT-ENR-3.1-en-GB.html",
    "airways_rnav": "VT-ENR-3.3-en-GB.html",
}
_AD_INDEX_PAGE = "VT-AD-1.3-en-GB.html"
_AD_PAGE_TMPL = "VT-AD-2.{icao}-en-GB.html"

_UA = "Mozilla/5.0 (ATC-FastTime-Sim navdata ingester)"

_M_TO_FT = 3.280839895

# --- HTML field patterns ---------------------------------------------------
# Every published value is a `<span class="SD">VALUE</span>` immediately
# followed by a hidden `<span class="sdParams">…;FIELD;…</span>`. AIRAC
# amendments wrap *replaced* values in a span whose class is
# `AmdtDeletedAIRAC` (NOT `SD`), so matching `class="SD"` naturally keeps
# only the current-cycle values.
_LAT_RE = re.compile(
    r'<span class="SD"[^>]*>\s*([0-9.]+[NS])\s*</span>'
    r'<span class="sdParams"[^>]*>[^<]*;GEO_LAT;'
)
_LON_RE = re.compile(
    r'<span class="SD"[^>]*>\s*([0-9.]+[EW])\s*</span>'
    r'<span class="sdParams"[^>]*>[^<]*;GEO_LONG;'
)
_CODEID_RE = re.compile(
    r'<span class="SD"[^>]*>\s*([A-Z0-9]+)\s*</span>'
    r'<span class="sdParams"[^>]*>[^<]*;CODE_ID;'
)
_WPT_ROW_RE = re.compile(r'<tr id="SP-([^"]+)"[^>]*>(.*?)</tr>', re.S)
_ROUTE_DESIG_RE = re.compile(
    r'<span class="SD"[^>]*>\s*([A-Z0-9]+)\s*</span>'
    r'<span class="sdParams"[^>]*>TEN_ROUTE_RTE;TXT_DESIG;'
)
_TYPE2_ROW_RE = re.compile(
    r'<tr[^>]*class="Table-row-type-2[^"]*"[^>]*>(.*?)</tr>', re.S
)

# --- Aerodrome (AD) patterns ----------------------------------------------
# AD 1.3 index pairs each aerodrome NAME (TXT_NAME) with its ICAO
# (CODE_ICAO) inside a row. AD 2.<ICAO> pages carry the Aerodrome
# Reference Point under the TAD_HP entity.
_AD_NAME_ICAO_RE = re.compile(
    r'<span class="SD"[^>]*>\s*([^<]+?)\s*</span>'
    r'<span class="sdParams"[^>]*>TAD_HP;TXT_NAME;[^<]*</span>'
    r'.*?<span class="SD"[^>]*>\s*([A-Z]{4})\s*</span>'
    r'<span class="sdParams"[^>]*>TAD_HP;CODE_ICAO;',
    re.S,
)
_AD_ICAO_RE = re.compile(
    r'<span class="SD"[^>]*>\s*([A-Z]{4})\s*</span>'
    r'<span class="sdParams"[^>]*>TAD_HP;CODE_ICAO;'
)
_AD_LAT_RE = re.compile(
    r'<span class="SD"[^>]*>\s*([0-9.]+[NS])\s*</span>'
    r'<span class="sdParams"[^>]*>TAD_HP;GEO_LAT;'
)
_AD_LON_RE = re.compile(
    r'<span class="SD"[^>]*>\s*([0-9.]+[EW])\s*</span>'
    r'<span class="sdParams"[^>]*>TAD_HP;GEO_LONG;'
)
# Hidden field-metadata spans carry an element ID that ends in a number
# (e.g. ``TAD_HP;VAL_ELEV_ARP;349``). They MUST be removed before tag
# stripping, otherwise that trailing ID (349) sits right next to the unit
# span and gets mis-read as the elevation value.
_SDPARAMS_RE = re.compile(r'<span class="sdParams"[^>]*>.*?</span>', re.S)
_TAG_RE = re.compile(r"<[^>]+>")
# First "<number> <ft|m>" pair inside the (cleaned) elevation cell.
_ELEV_NUM_RE = re.compile(r"(-?\d+(?:\.\d+)?)\s*(ft|m)\b")


def _ssl_ctx() -> ssl.SSLContext:
    # The CAAT cert chain trips strict verification on some hosts; this is
    # read-only public navdata, so relax verification for the fetch.
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def fetch(url: str, timeout: int = 90) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=timeout, context=_ssl_ctx()) as r:
        return r.read().decode("utf-8", "replace")


def dms_to_deg(token: str) -> float:
    """Convert a DDMMSS[.ss]<N/S/E/W> token to signed decimal degrees.

    Latitude tokens carry 2 degree digits, longitude 3 — distinguished by
    the hemisphere letter. e.g. ``"123511N"`` → 12.585278,
    ``"0994538E"`` → 99.760556. Returns degrees rounded to 6 dp.
    """
    token = token.strip()
    hemi = token[-1].upper()
    body = token[:-1]
    if hemi in ("N", "S"):
        deg_digits = 2
    elif hemi in ("E", "W"):
        deg_digits = 3
    else:
        raise ValueError(f"bad coordinate token: {token!r}")
    deg = int(body[:deg_digits])
    rest = body[deg_digits:]
    minutes = int(rest[:2]) if len(rest) >= 2 else 0
    seconds = float(rest[2:]) if len(rest) > 2 else 0.0
    value = deg + minutes / 60.0 + seconds / 3600.0
    if hemi in ("S", "W"):
        value = -value
    return round(value, 6)


def parse_waypoints(html: str) -> dict[str, dict[str, float]]:
    """Parse ENR 4.4 significant points → {ident: {lat, lon}}."""
    out: dict[str, dict[str, float]] = {}
    for ident, body in _WPT_ROW_RE.findall(html):
        lat_m = _LAT_RE.search(body)
        lon_m = _LON_RE.search(body)
        if not lat_m or not lon_m:
            continue
        try:
            out[ident] = {
                "lat": dms_to_deg(lat_m.group(1)),
                "lon": dms_to_deg(lon_m.group(1)),
            }
        except ValueError:
            continue
    return out


def parse_airways(
    html: str,
) -> tuple[dict[str, list[str]], dict[str, dict[str, float]]]:
    """Parse an ENR 3.x page into airway sequences + inline point coords.

    Returns ``(airways, coords)`` where ``airways[desig]`` is the ordered
    list of point idents along the route, and ``coords`` captures the
    lat/lon of every point seen inline (covers navaids like the BKK VOR
    that live in ENR 4.1 rather than ENR 4.4).
    """
    airways: dict[str, list[str]] = {}
    coords: dict[str, dict[str, float]] = {}

    # Slice the page at each route-designator marker; the text up to the
    # next marker holds that route's point rows in order.
    markers = list(_ROUTE_DESIG_RE.finditer(html))
    for idx, m in enumerate(markers):
        desig = m.group(1)
        start = m.end()
        end = markers[idx + 1].start() if idx + 1 < len(markers) else len(html)
        block = html[start:end]

        seq: list[str] = []
        for row in _TYPE2_ROW_RE.findall(block):
            id_m = _CODEID_RE.search(row)
            if not id_m:
                continue
            ident = id_m.group(1)
            seq.append(ident)
            lat_m = _LAT_RE.search(row)
            lon_m = _LON_RE.search(row)
            if lat_m and lon_m and ident not in coords:
                try:
                    coords[ident] = {
                        "lat": dms_to_deg(lat_m.group(1)),
                        "lon": dms_to_deg(lon_m.group(1)),
                    }
                except ValueError:
                    pass
        # A handful of designators recur (multi-segment tables); merge
        # rather than overwrite so the full sequence is preserved.
        if seq:
            if desig in airways:
                # Append only points not already trailing, to avoid dupes
                # at table boundaries.
                for ident in seq:
                    if not airways[desig] or airways[desig][-1] != ident:
                        airways[desig].append(ident)
            else:
                airways[desig] = seq
    return airways, coords


def parse_aerodrome_index(html: str) -> dict[str, str]:
    """Parse AD 1.3 → {ICAO: aerodrome name}.

    Falls back to bare ICAO codes (name = "") for any row whose name span
    couldn't be paired, so coordinates can still be fetched for it.
    """
    names: dict[str, str] = {
        icao: name.strip()
        for name, icao in _AD_NAME_ICAO_RE.findall(html)
    }
    for icao in _AD_ICAO_RE.findall(html):
        names.setdefault(icao, "")
    return names


def parse_aerodrome_page(html: str) -> dict[str, float] | None:
    """Parse one AD 2.<ICAO> page → {lat, lon, elev_ft}.

    Returns None when the Aerodrome Reference Point can't be located
    (some military/minor fields publish no ARP). Elevation is normalised
    to feet (the AIP gives it as either ``N ft`` or ``N m``).
    """
    lat_m = _AD_LAT_RE.search(html)
    lon_m = _AD_LON_RE.search(html)
    if not lat_m or not lon_m:
        return None
    try:
        lat = dms_to_deg(lat_m.group(1))
        lon = dms_to_deg(lon_m.group(1))
    except ValueError:
        return None

    elev_ft: float | None = None
    label = html.find("Elevation/Reference temperature")
    if label != -1:
        cell = _SDPARAMS_RE.sub(" ", html[label : label + 600])
        window = _TAG_RE.sub(" ", cell)
        num = _ELEV_NUM_RE.search(window)
        if num:
            value = float(num.group(1))
            if num.group(2) == "m":
                value *= _M_TO_FT
            elev_ft = round(value, 1)

    out: dict[str, float] = {"lat": lat, "lon": lon}
    if elev_ft is not None:
        out["elev_ft"] = elev_ft
    return out


def fetch_aerodromes(base: str) -> dict[str, dict[str, object]]:
    """Crawl AD 1.3 + each AD 2.<ICAO> page → {ICAO: {lat,lon,elev_ft,name}}."""
    try:
        index_html = fetch(base + _AD_INDEX_PAGE)
    except Exception as e:  # noqa: BLE001
        print(f"[ingest] WARNING: AD 1.3 index fetch failed: {e}", file=sys.stderr)
        return {}

    names = parse_aerodrome_index(index_html)
    print(f"[ingest] AD 1.3 aerodromes indexed: {len(names)}")

    airports: dict[str, dict[str, object]] = {}
    for i, icao in enumerate(sorted(names), 1):
        page = _AD_PAGE_TMPL.format(icao=icao)
        try:
            html = fetch(base + page)
        except Exception:  # noqa: BLE001 — skip fields with no AD 2 page
            print(f"[ingest]   ({i}/{len(names)}) {icao}: no AD 2 page — skipped")
            continue
        parsed = parse_aerodrome_page(html)
        if parsed is None:
            print(f"[ingest]   ({i}/{len(names)}) {icao}: no ARP — skipped")
            continue
        entry: dict[str, object] = dict(parsed)
        if names[icao]:
            entry["name"] = names[icao]
        airports[icao] = entry
        elev = parsed.get("elev_ft")
        print(
            f"[ingest]   ({i}/{len(names)}) {icao}: "
            f"{parsed['lat']:.4f},{parsed['lon']:.4f} "
            f"elev={elev if elev is not None else '?'} ft"
        )
    return airports


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Ingest CAAT eAIP navdata.")
    ap.add_argument(
        "--airac",
        default="2026-05-14",
        help="AIRAC cycle date in the URL path, e.g. 2026-05-14",
    )
    ap.add_argument(
        "--out",
        type=Path,
        default=_OUT_DEFAULT,
        help=f"Output JSON path (default: {_OUT_DEFAULT})",
    )
    ap.add_argument(
        "--skip-aerodromes",
        action="store_true",
        help="Skip the AD 1.3/AD 2 crawl (waypoints + airways only). The "
        "existing airports block in the output file is preserved.",
    )
    args = ap.parse_args(argv)

    base = _BASE.format(airac=args.airac)
    print(f"[ingest] AIRAC {args.airac}")
    print(f"[ingest] base {base}")

    try:
        wpt_html = fetch(base + _ENR_PAGES["waypoints"])
        conv_html = fetch(base + _ENR_PAGES["airways_conv"])
        rnav_html = fetch(base + _ENR_PAGES["airways_rnav"])
    except Exception as e:  # noqa: BLE001 — surface any network error plainly
        print(f"[ingest] ERROR fetching AIP pages: {e}", file=sys.stderr)
        return 1

    waypoints = parse_waypoints(wpt_html)
    print(f"[ingest] ENR 4.4 waypoints: {len(waypoints)}")

    airways: dict[str, list[str]] = {}
    inline_coords: dict[str, dict[str, float]] = {}
    for label, html in (("ENR 3.1", conv_html), ("ENR 3.3", rnav_html)):
        aw, co = parse_airways(html)
        print(f"[ingest] {label} airways: {len(aw)}")
        for desig, seq in aw.items():
            airways.setdefault(desig, seq)
        for ident, c in co.items():
            inline_coords.setdefault(ident, c)

    # Merge inline navaid/point coords for anything not in ENR 4.4 so every
    # airway point resolves to a position.
    added = 0
    for ident, c in inline_coords.items():
        if ident not in waypoints:
            waypoints[ident] = c
            added += 1
    print(f"[ingest] merged {added} inline points from airway tables")

    # --- Aerodromes (AD 1.3 + AD 2.*) -----------------------------------
    if args.skip_aerodromes:
        # Preserve whatever airports block already exists in the output.
        airports: dict[str, dict[str, object]] = {}
        if args.out.is_file():
            try:
                airports = json.loads(args.out.read_text("utf-8")).get(
                    "airports", {}
                )
            except (json.JSONDecodeError, OSError):
                airports = {}
        print(f"[ingest] aerodromes: skipped (kept {len(airports)} existing)")
    else:
        airports = fetch_aerodromes(base)
        print(f"[ingest] aerodromes parsed: {len(airports)}")

    payload = {
        "airac": args.airac,
        "source_url": base,
        "fetched_at_utc": datetime.now(timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        ),
        "waypoint_count": len(waypoints),
        "airway_count": len(airways),
        "airport_count": len(airports),
        "waypoints": dict(sorted(waypoints.items())),
        "airways": dict(sorted(airways.items())),
        "airports": dict(sorted(airports.items())),
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(
        f"[ingest] wrote {args.out} "
        f"({len(waypoints)} waypoints, {len(airways)} airways, "
        f"{len(airports)} airports)"
    )

    # Quick sanity probe on the canonical Y8 corridor.
    y8 = airways.get("Y8")
    if y8:
        print(f"[ingest] Y8 sequence ({len(y8)}): {' '.join(y8)}")
    else:
        print("[ingest] WARNING: Y8 not found — check the parser/AIRAC date")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
