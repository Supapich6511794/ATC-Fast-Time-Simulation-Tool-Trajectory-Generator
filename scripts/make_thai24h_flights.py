"""Generate a 24-hour sample of Thai (Bangkok FIR) traffic — all four flavours.

The other dummy generators only file *domestic* published AIP routes. A real
Bangkok-FIR day is roughly a third domestic; the rest arrives from abroad,
departs abroad, or never lands in Thailand at all. This generator reproduces
that whole day, statistically matched to the real CAT062 surveillance log for
2025-12-23 — 2 906 flights with an ICAO city pair, distilled by
``scripts/build_thai24h_profile.py`` into ``scripts/data/thai24h_profile.json``:

    domestic    946  (33 %)   VT… -> VT…
    arrival     718  (25 %)   foreign -> VT…
    departure   712  (24 %)   VT… -> foreign
    overflight  530  (18 %)   foreign -> foreign, crossing the FIR

Everything sampled is drawn from that real day: the category mix, the hourly
EOBT curve (peaks 01–12 UTC = 08–19 ICT, troughs 20–22 UTC = 03–05 ICT), the
city-pair market, the operator mix, and the cruising-level spread.

Routes are built inside Thai airspace, from the published Thai AIP only:

  * **domestic** — a published AIP route for the pair (``aip_routes_VT.json``),
    else an airway path between the SID exit and the STAR entry;
  * **arrival** — enters at a real Bangkok-FIR *gateway* fix for that foreign
    aerodrome, then an airway path to the STAR entry fix at the Thai field;
  * **departure** — SID exit fix, airway path out to the real exit gateway;
  * **overflight** — entry gateway, airway path, exit gateway. No SID/STAR: the
    aircraft is at cruise for the whole Bangkok-FIR crossing.

Gateways are not invented. They are the fixes real traffic from that aerodrome
actually crossed the FIR boundary at, derived by point-in-polygon testing every
CAT062 track against the BANGKOK FIR polygon (see the profile builder). So an
EGLL–WSSS overflight enters over EKAVO/LUDVI in the north-west and leaves via
PASVA/DALAN in the south, the way the real one does.

Because a foreign aerodrome has no coordinates in the Thai AIP, an
international flight's *route* starts (or ends) at its FIR gateway rather than
at the foreign field — which is exactly the segment a Bangkok-FIR simulation
models. The foreign ICAO is still filed as ADEP/ADES.

Output is the same format as the other dummy files, so it round-trips through
``web/lib/flightFile.ts``:
  * dummy_data/thai24h_traffic.csv      — stacked "FLIGHT n of N" blocks.
  * dummy_data/thai24h_traffic.geojson  — route LineString + POINT Z samples.

Run:  python scripts/make_thai24h_flights.py                  # 600-flight sample
      python scripts/make_thai24h_flights.py --flights 2906   # the full day
"""

from __future__ import annotations

import argparse
import heapq
import json
import math
import random
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))

from _dummy_procs import (  # noqa: E402
    load_proc_runways,
    load_thr_elevs,
    make_expand_runway,
)
from trajectory_sim.performance import (  # noqa: E402
    reachable_ceiling_ft,
    register_field_elevations,
    register_runway_elevations,
    runway_threshold_elevation_ft,
)
from trajectory_sim.validation import cab_cruising_level_capped  # noqa: E402

OUT_DIR = _ROOT / "dummy_data"
AIP_PATH = _ROOT / "web" / "public" / "data" / "aip_VT.json"
ROUTES_PATH = _ROOT / "web" / "public" / "data" / "aip_routes_VT.json"
PROFILE_PATH = _ROOT / "scripts" / "data" / "thai24h_profile.json"
_SID_LINE = _ROOT / "web" / "public" / "data" / "aixm" / "sid_line.geojson"
_STAR_LINE = _ROOT / "web" / "public" / "data" / "aixm" / "star_line.geojson"
_SID_WPT = _ROOT / "web" / "public" / "data" / "aixm" / "sid_waypoint.geojson"
_STAR_WPT = _ROOT / "web" / "public" / "data" / "aixm" / "star_waypoint.geojson"
_PBN_WPTS = _ROOT / "web" / "public" / "data" / "aixm" / "pbn_waypoint.geojson"

DAY = datetime(2025, 12, 23, tzinfo=timezone.utc)
SAMPLES_PER_ROUTE = 16      # points written per route table
_SEP_S = 120.0              # min in-trail spacing on a shared SID/STAR corridor
_CATS = ("domestic", "arrival", "departure", "overflight")

# Ground speeds (kt) used to time the samples along the route.
_GS_CLIMB, _GS_CRUISE, _GS_DESCENT = 300.0, 460.0, 290.0
_NM_PER_DEG = 60.0

# ---------------------------------------------------------------------------
# Foreign aerodromes. The Thai AIP has no coordinates outside VT, and the only
# thing the generator needs them for is stage length (which picks the airframe),
# so a reference-point table for the aerodromes that carry ~90 % of the real
# day's international traffic is enough; anything else falls back to the ICAO
# prefix region centroid below.
# ---------------------------------------------------------------------------
FOREIGN_AD: dict[str, tuple[float, float]] = {
    "WSSS": (1.3502, 103.9944), "WMKK": (2.7456, 101.7099),
    "WMKP": (5.2971, 100.2770), "WMSA": (3.1306, 101.5494),
    "WMKJ": (1.6413, 103.6700), "WIII": (-6.1256, 106.6559),
    "WADD": (-8.7482, 115.1672),
    "VHHH": (22.3089, 113.9145), "VMMC": (22.1496, 113.5915),
    "VVTS": (10.8188, 106.6520), "VVNB": (21.2212, 105.8072),
    "VVDN": (16.0439, 108.1994), "VVCR": (11.9982, 109.2192),
    "VVPQ": (10.1698, 103.9931),
    "VYYY": (16.9073, 96.1332), "VYMD": (21.7022, 95.9779),
    "VLVT": (17.9883, 102.5633), "VLLB": (19.8973, 102.1608),
    "VLPS": (15.1323, 105.7817),
    "VDTI": (11.4194, 104.9414), "VDSA": (13.3667, 104.0333),
    "VIDP": (28.5665, 77.1031), "VABB": (19.0887, 72.8679),
    "VECC": (22.6547, 88.4467), "VOBL": (13.1979, 77.7063),
    "VOMM": (12.9941, 80.1709), "VOHS": (17.2403, 78.4294),
    "VOCI": (10.1520, 76.4019), "VAAH": (23.0772, 72.6347),
    "VEGY": (24.7443, 84.9512), "VGHS": (23.8433, 90.3978),
    "VCBI": (7.1808, 79.8841), "VNKT": (27.6966, 85.3591),
    "VRMM": (4.1918, 73.5291),
    "ZGGG": (23.3924, 113.2988), "ZGSZ": (22.6393, 113.8106),
    "ZGNN": (22.6083, 108.1722), "ZSPD": (31.1443, 121.8083),
    "ZSAM": (24.5440, 118.1277), "ZSNJ": (31.7420, 118.8622),
    "ZUTF": (30.3125, 104.4413), "ZUCK": (29.7192, 106.6417),
    "ZPPP": (25.1019, 102.9292), "ZBAA": (40.0801, 116.5846),
    "ZLXY": (34.4471, 108.7516), "ZJHK": (19.9349, 110.4590),
    "ZMCK": (47.6503, 106.8225),
    "RCTP": (25.0777, 121.2328), "RCKH": (22.5771, 120.3500),
    "RKSI": (37.4691, 126.4505), "RKPK": (35.1795, 128.9382),
    "RJAA": (35.7647, 140.3864), "RJTT": (35.5533, 139.7811),
    "RJBB": (34.4347, 135.2440), "RJFF": (33.5859, 130.4510),
    "RPLL": (14.5086, 121.0197),
    "OMDB": (25.2528, 55.3644), "OMDW": (24.8964, 55.1614),
    "OMAA": (24.4330, 54.6511), "OMSJ": (25.3286, 55.5172),
    "OTHH": (25.2731, 51.6081), "OBBI": (26.2708, 50.6336),
    "OOMS": (23.5933, 58.2844), "OERK": (24.9576, 46.6988),
    "OEJN": (21.6796, 39.1565),
    "EGLL": (51.4700, -0.4543), "EGKK": (51.1481, -0.1903),
    "LFPG": (49.0097, 2.5479), "EDDF": (50.0379, 8.5622),
    "EDDM": (48.3538, 11.7861), "EHAM": (52.3086, 4.7639),
    "LSZH": (47.4647, 8.5492), "LOWW": (48.1103, 16.5697),
    "EKCH": (55.6180, 12.6560), "EFHK": (60.3172, 24.9633),
    "ENGM": (60.1939, 11.1004), "LTFM": (41.2753, 28.7519),
    "LLBG": (32.0114, 34.8867),
    "UUEE": (55.9726, 37.4146), "UAAA": (43.3521, 77.0405),
    "UIII": (52.2680, 104.3889), "UHWW": (43.3990, 132.1483),
    "USSS": (56.7431, 60.8027), "UNKL": (56.1729, 92.4933),
    "YSSY": (-33.9461, 151.1772), "YMML": (-37.6733, 144.8433),
    "HAAB": (8.9779, 38.7993),
}

# Coarse fallback: ICAO 2-letter prefix -> a representative point in that
# region, so an aerodrome outside the table still gets a sane stage length.
_REGION: dict[str, tuple[float, float]] = {
    "WS": (1.35, 103.99), "WM": (3.1, 101.6), "WI": (-6.1, 106.7),
    "WA": (-7.0, 112.7), "WB": (5.3, 115.1), "WR": (-8.7, 115.2),
    "VH": (22.3, 113.9), "VM": (22.1, 113.6), "VV": (16.0, 108.2),
    "VY": (18.0, 96.2), "VL": (18.0, 102.6), "VD": (12.0, 104.5),
    "VI": (28.6, 77.1), "VA": (21.0, 73.0), "VE": (22.7, 88.4),
    "VO": (13.0, 77.7), "VC": (7.2, 79.9), "VN": (27.7, 85.4),
    "VG": (23.8, 90.4), "VR": (4.2, 73.5), "VQ": (27.4, 89.4),
    "ZG": (23.0, 113.0), "ZS": (31.1, 121.8), "ZU": (30.0, 104.0),
    "ZP": (25.1, 102.9), "ZB": (40.1, 116.6), "ZL": (34.4, 108.8),
    "ZJ": (19.9, 110.5), "ZY": (41.6, 123.5), "ZH": (30.6, 114.2),
    "ZW": (43.9, 87.5), "ZM": (47.7, 106.8),
    "RC": (25.1, 121.2), "RK": (37.5, 126.5), "RJ": (35.6, 139.8),
    "RO": (26.2, 127.7), "RP": (14.5, 121.0),
    "OM": (25.3, 55.4), "OT": (25.3, 51.6), "OB": (26.3, 50.6),
    "OO": (23.6, 58.3), "OE": (24.7, 46.7), "OK": (29.2, 48.0),
    "OI": (35.4, 51.2), "OP": (33.6, 73.1), "OY": (15.5, 44.2),
    "OJ": (31.7, 36.0), "OL": (33.8, 35.5), "OS": (33.4, 36.5),
    "EG": (51.5, -0.5), "LF": (49.0, 2.5), "ED": (50.0, 8.6),
    "EH": (52.3, 4.8), "LS": (47.5, 8.5), "LO": (48.1, 16.6),
    "EK": (55.6, 12.7), "EF": (60.3, 25.0), "EN": (60.2, 11.1),
    "ES": (59.7, 17.9), "LT": (41.3, 28.8), "LL": (32.0, 34.9),
    "LI": (41.8, 12.3), "LE": (40.5, -3.6), "LP": (38.8, -9.1),
    "EB": (50.9, 4.5), "EP": (52.2, 20.9), "LK": (50.1, 14.3),
    "LH": (47.4, 19.3), "LR": (44.6, 26.1), "LG": (37.9, 23.9),
    "LY": (44.8, 20.3), "LZ": (48.2, 17.2),
    "UU": (55.9, 37.4), "UA": (43.4, 77.0), "UI": (52.3, 104.4),
    "UH": (43.4, 132.1), "US": (56.7, 60.8), "UN": (56.2, 92.5),
    "UT": (41.3, 69.3), "UK": (50.4, 30.9), "UB": (40.4, 50.0),
    "UM": (53.9, 27.6), "UG": (41.7, 44.9), "UD": (40.1, 44.4),
    "YS": (-33.9, 151.2), "YM": (-37.7, 144.8), "YB": (-27.4, 153.1),
    "YP": (-31.9, 115.9), "NZ": (-37.0, 174.8), "NF": (-18.0, 177.4),
    "HA": (9.0, 38.8), "HK": (-1.3, 36.9), "HE": (30.1, 31.4),
    "FA": (-26.1, 28.2), "FN": (-8.9, 13.2), "FI": (-20.4, 57.7),
    "DN": (9.0, 7.3), "DG": (5.6, -0.2), "GM": (33.4, -7.6),
    "KJ": (40.6, -73.8), "KL": (34.0, -118.4), "KS": (47.4, -122.3),
    "CY": (43.7, -79.6), "PH": (21.3, -157.9), "PA": (61.2, -150.0),
    "SB": (-23.4, -46.5), "SA": (-34.8, -58.5), "MM": (19.4, -99.1),
}

# Airframe pools by stage length — what actually flies these markets.
_TURBOPROP = ["AT76", "AT75"]
_NARROW_SHORT = ["A320", "A20N", "B738", "A321", "A21N", "B38M"]
_NARROW_MED = ["A321", "A20N", "A21N", "B738", "B38M", "A320", "B39M"]
_WIDE_MED = ["A333", "B788", "A359", "B78X", "A332", "B77W"]
_WIDE_LONG = ["B77W", "B789", "A359", "A35K", "B78X", "A388", "B77L"]


# ---------------------------------------------------------------------------
# Static data
# ---------------------------------------------------------------------------
def _load_aip():
    data = json.loads(AIP_PATH.read_text(encoding="utf-8"))
    waypoints = {
        ident: (float(w["lat"]), float(w["lon"]))
        for ident, w in data["waypoints"].items()
    }
    airways = {d: list(seq) for d, seq in data["airways"].items()}
    airports = {
        icao: (float(a["lat"]), float(a["lon"]),
               int(round(float(a.get("elev_ft", 0)))))
        for icao, a in data.get("airports", {}).items()
        if "lat" in a and "lon" in a
    }
    return waypoints, airways, airports


WAYPOINTS, AIRWAYS, AIRPORTS = _load_aip()
PROFILE = json.loads(PROFILE_PATH.read_text(encoding="utf-8"))

SIDS, SID_RWY = load_proc_runways(_SID_LINE)
STARS, STAR_RWY = load_proc_runways(_STAR_LINE)
THR_ELEV = load_thr_elevs()
register_runway_elevations(THR_ELEV)
register_field_elevations({icao: e for icao, (_a, _b, e) in AIRPORTS.items()})
_expand_runway = make_expand_runway(THR_ELEV)


def _proc_connect_fixes(path: Path, take_last: bool) -> dict[str, dict[str, str]]:
    """``airport -> {procedure: connecting enroute fix}``.

    A SID connects to the enroute structure on its LAST coded fix, a STAR on
    its FIRST — the same rule the server's ``_suggest_procedure`` uses. Only
    fixes that exist in the AIP enroute waypoint set are usable as a join.
    """
    fc = json.loads(path.read_text(encoding="utf-8"))
    best: dict[str, dict[str, tuple[int, str]]] = {}
    for feat in fc.get("features", []):
        p = feat.get("properties") or {}
        ad, proc = p.get("airport_identifier"), p.get("procedure_identifier")
        ident, seq = p.get("waypoint_identifier"), p.get("seqno")
        if not ad or not proc or not ident or seq is None:
            continue
        ident = str(ident).strip().upper()
        if ident not in WAYPOINTS:
            continue
        cur = best.setdefault(ad, {}).get(proc)
        seq = int(seq)
        if cur is None or (seq > cur[0] if take_last else seq < cur[0]):
            best[ad][proc] = (seq, ident)
    return {ad: {pr: v[1] for pr, v in d.items()} for ad, d in best.items()}


SID_EXIT = _proc_connect_fixes(_SID_WPT, take_last=True)
STAR_ENTRY = _proc_connect_fixes(_STAR_WPT, take_last=False)


def _load_approaches() -> dict[str, dict[str, list[str]]]:
    """``airport -> {"RW09": ["R09-Y", …]}`` PBN approaches by landing runway —
    mirrors ``buildApproachIndex`` in web/lib/geojson.ts so an imported flight
    pre-selects a real entry in the app's Approach picker."""
    fc = json.loads(_PBN_WPTS.read_text(encoding="utf-8"))
    out: dict[str, dict[str, set[str]]] = {}
    for f in fc["features"]:
        p = f.get("properties") or {}
        ad, name = p.get("airport_identifier"), p.get("procedure_identifier")
        if not ad or not name:
            continue
        m = re.match(r"^R(\d{2}[LCR]?)(?:-.*)?$", str(name).strip().upper())
        if m:
            out.setdefault(ad, {}).setdefault(f"RW{m.group(1)}", set()).add(name)
    return {a: {r: sorted(v) for r, v in d.items()} for a, d in out.items()}


APPROACHES = _load_approaches()


# ---------------------------------------------------------------------------
# Geometry + airway graph
# ---------------------------------------------------------------------------
def nm_between(a: tuple[float, float], b: tuple[float, float]) -> float:
    dlat = (b[0] - a[0]) * _NM_PER_DEG
    dlon = (b[1] - a[1]) * _NM_PER_DEG * math.cos(math.radians((a[0] + b[0]) / 2))
    return math.hypot(dlat, dlon)


def bearing(lat1, lon1, lat2, lon2) -> int:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return int(round(math.degrees(math.atan2(x, y)))) % 360


def _build_graph() -> dict[str, dict[str, tuple[float, set[str]]]]:
    """Undirected airway graph: fix -> {neighbour: (nm, {airways})}."""
    g: dict[str, dict[str, tuple[float, set[str]]]] = {}
    for desig, seq in AIRWAYS.items():
        fixes = [f for f in seq if f in WAYPOINTS]
        for a, b in zip(fixes, fixes[1:]):
            if a == b:
                continue
            d = nm_between(WAYPOINTS[a], WAYPOINTS[b])
            for u, v in ((a, b), (b, a)):
                edge = g.setdefault(u, {}).get(v)
                if edge is None:
                    g[u][v] = (d, {desig})
                else:
                    edge[1].add(desig)
    return g


GRAPH = _build_graph()


# Fixes inside the Bangkok TMA. Crossing traffic pays a cost penalty there, so
# it takes an outer airway unless the detour is big — but it is a preference,
# not a ban: 27 % of the real day's overflights did pass within 25 NM of VTBS.
# The multiplier is calibrated against exactly that figure (a least-distance
# graph walk with no penalty sends 39 % over the top; at 4.0 it sends 26 %).
# Arrivals and departures are routed without the penalty — they belong there.
_TMA_CENTRE = (13.6900, 100.7501)   # VTBS
_TMA_NM = 45.0
_TMA_PENALTY = 4.0
_IN_TMA = {
    f for f, ll in WAYPOINTS.items() if nm_between(ll, _TMA_CENTRE) < _TMA_NM
}


def shortest_path(src: str, dst: str, avoid_tma: bool = False) -> list[str] | None:
    """Least-distance fix sequence through the airway graph (Dijkstra)."""
    if src == dst:
        return [src]
    if src not in GRAPH or dst not in GRAPH:
        return None
    dist = {src: 0.0}
    prev: dict[str, str] = {}
    pq = [(0.0, src)]
    seen: set[str] = set()
    while pq:
        d, u = heapq.heappop(pq)
        if u in seen:
            continue
        seen.add(u)
        if u == dst:
            break
        for v, (w, _aw) in GRAPH[u].items():
            if avoid_tma and v in _IN_TMA and v != dst:
                w *= _TMA_PENALTY
            nd = d + w
            if nd < dist.get(v, math.inf):
                dist[v] = nd
                prev[v] = u
                heapq.heappush(pq, (nd, v))
    if dst not in seen:
        return None
    path = [dst]
    while path[-1] != src:
        path.append(prev[path[-1]])
    return path[::-1]


def path_nm(path: list[str]) -> float:
    return sum(
        nm_between(WAYPOINTS[a], WAYPOINTS[b]) for a, b in zip(path, path[1:])
    )


def item15(path: list[str]) -> str:
    """Compress a fix sequence into an ICAO Item-15 route string, collapsing
    every maximal run of consecutive edges that share one airway into
    ``FIX AWY FIX``. Legs with no common airway are filed DCT."""
    if len(path) < 2:
        return " ".join(path)
    edges = [
        GRAPH.get(a, {}).get(b, (0.0, set()))[1] for a, b in zip(path, path[1:])
    ]
    toks = [path[0]]
    i = 0
    while i < len(edges):
        common = set(edges[i])
        j = i
        while j + 1 < len(edges) and common & edges[j + 1]:
            common &= edges[j + 1]
            j += 1
        toks.append(sorted(common)[0] if common else "DCT")
        toks.append(path[j + 1])
        i = j + 1
    return " ".join(toks)


def resolve_route_coords(route_str: str) -> list[tuple[str, float, float]]:
    """(ident, lat, lon) along an Item-15 route — expands ``fix AWY fix`` spans
    the way the server resolver does. Unknown tokens are skipped."""
    toks = [t.split("/")[0] if "/" in t else t for t in route_str.upper().split()]
    out: list[tuple[str, float, float]] = []
    prev: str | None = None
    pending: str | None = None
    for t in toks:
        if t == "DCT":
            pending = None
            continue
        if t in AIRWAYS and t not in WAYPOINTS:
            pending = t
            continue
        if t in WAYPOINTS:
            if pending and prev and prev in WAYPOINTS:
                seq = [f for f in AIRWAYS[pending] if f in WAYPOINTS]
                if prev in seq and t in seq:
                    i, j = seq.index(prev), seq.index(t)
                    step = 1 if i < j else -1
                    for k in range(i + step, j, step):
                        out.append((seq[k], *WAYPOINTS[seq[k]]))
            out.append((t, *WAYPOINTS[t]))
            prev = t
            pending = None
    return out


# ---------------------------------------------------------------------------
# Sampling helpers
# ---------------------------------------------------------------------------
def foreign_ll(icao: str) -> tuple[float, float] | None:
    if icao in FOREIGN_AD:
        return FOREIGN_AD[icao]
    return _REGION.get(icao[:2].upper())


def stage_nm(adep: str, ades: str) -> float:
    """Great-circle stage length (NM), using the AIP for Thai fields and the
    foreign table / region centroid otherwise. 0 when neither is known."""
    a = AIRPORTS[adep][:2] if adep in AIRPORTS else foreign_ll(adep)
    b = AIRPORTS[ades][:2] if ades in AIRPORTS else foreign_ll(ades)
    if a is None or b is None:
        return 0.0
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    d = math.acos(
        max(-1.0, min(1.0, math.sin(lat1) * math.sin(lat2)
                      + math.cos(lat1) * math.cos(lat2) * math.cos(lon2 - lon1)))
    )
    return d * 3440.065


def pick_actype(cat: str, adep: str, ades: str, rng: random.Random) -> str:
    nm = stage_nm(adep, ades)
    if cat == "domestic":
        if nm and nm < 230:
            return rng.choice(_TURBOPROP + _NARROW_SHORT[:2])
        return rng.choice(_NARROW_SHORT)
    if not nm:
        return rng.choice(_NARROW_MED)
    if nm < 900:
        return rng.choice(_NARROW_MED)
    if nm < 2600:
        return rng.choice(_NARROW_MED[:3] + _WIDE_MED)
    return rng.choice(_WIDE_LONG)


def weighted(pairs: list, rng: random.Random):
    """Pick a key from ``[[key, weight], …]`` proportionally to weight."""
    total = sum(w for _k, w in pairs)
    r = rng.random() * total
    acc = 0.0
    for k, w in pairs:
        acc += w
        if r < acc:
            return k
    return pairs[-1][0]


def gateway_for(kind: str, icao: str, rng: random.Random) -> str | None:
    """A real Bangkok-FIR entry/exit fix used by traffic to/from ``icao``,
    restricted to fixes that sit on the airway network."""
    opts = [
        [f, n] for f, n in PROFILE["gateways"][kind].get(icao, []) if f in GRAPH
    ]
    return weighted(opts, rng) if opts else None


def crossing_corridor(adep: str, ades: str,
                      rng: random.Random) -> tuple[str | None, str | None]:
    """An observed (entry, exit) gateway pair for an overflight on this city
    pair — a whole crossing corridor, not two independently drawn fixes. Real
    crossings correlate the two ends (EGLL-WSSS enters EKAVO and leaves PASVA);
    drawing them apart would send far too much crossing traffic over the
    Bangkok TMA. Falls back to the day-wide corridor mix for an unseen pair."""
    opts = [
        [c, n] for c, n in CORRIDORS.get(f"{adep}-{ades}", [])
        if all(f in GRAPH for f in c.split("|"))
    ]
    if not opts:
        opts = CORRIDORS_ALL
    if not opts:
        return None, None
    gin, gout = weighted(opts, rng).split("|")
    return gin, gout


def proc_for_route(procs: dict[str, str], idents: list[str],
                   endpoint: str) -> str:
    """Best SID/STAR for an already-filed route, ranked the way the server's
    ``_suggest_procedure`` ranks: the procedure whose connecting fix IS the
    route endpoint, else one whose connecting fix lies on the route, else the
    one closest to the endpoint. ``procs`` maps procedure name -> connecting
    fix (a SID's last fix, a STAR's first)."""
    if not procs or endpoint not in WAYPOINTS:
        return ""
    on_route = set(idents)
    exact = [p for p, f in procs.items() if f == endpoint]
    if exact:
        return sorted(exact)[0]
    onr = [p for p, f in procs.items() if f in on_route]
    if onr:
        return sorted(onr)[0]
    ref = WAYPOINTS[endpoint]
    best = min(
        ((nm_between(WAYPOINTS[f], ref), p) for p, f in procs.items()
         if f in WAYPOINTS),
        default=None,
    )
    return best[1] if best else ""


def _best_join(gateway: str, procs: dict[str, str], reverse: bool):
    """Cheapest (procedure, connecting fix, path) linking a gateway to one of a
    field's procedures. ``procs`` maps procedure name -> connecting fix; with
    ``reverse`` the path runs procedure -> gateway (a departure)."""
    best = None
    for proc, fix in procs.items():
        if fix not in GRAPH:
            continue
        path = shortest_path(fix, gateway) if reverse else shortest_path(gateway, fix)
        if not path or len(path) < 2:
            continue
        cost = path_nm(path)
        if best is None or cost < best[0]:
            best = (cost, proc, fix, path)
    return best


def pick_approach(ades: str, arr_rwy: str) -> str:
    opts = APPROACHES.get(ades, {}).get(arr_rwy, [])
    return opts[0] if opts else ""


def _ang_diff(a: float, b: float) -> float:
    d = abs(a - b) % 360.0
    return d if d <= 180.0 else 360.0 - d


def arrival_fallback(ades: str, inbound_brg: float) -> tuple[str, str]:
    """Landing runway + PBN approach best aligned with the inbound track, for a
    field whose chosen STAR runway carries no coded approach."""
    best = None
    for rwy, names in (APPROACHES.get(ades) or {}).items():
        m = re.match(r"^RW(\d{2})", rwy)
        if not names or not m:
            continue
        hdg = (int(m.group(1)) % 36) * 10.0
        cand = (_ang_diff(hdg, inbound_brg), rwy, names[0])
        if best is None or cand < best:
            best = cand
    return (best[1], best[2]) if best else ("", "")


# ---------------------------------------------------------------------------
# Vertical profile + 4D samples
# ---------------------------------------------------------------------------
# Rules of thumb the profile uses to place top-of-climb / top-of-descent:
# a jet needs roughly 300 ft of climb per NM and descends on the 3:1 rule
# (3 NM per 1 000 ft). So FL350 puts TOC ~115 NM out and TOD ~105 NM to run —
# far better than a fixed fraction of the route, which would have a 150 NM
# domestic hop and a 600 NM international leg climbing over the same distance.
_CLIMB_FT_PER_NM = 300.0
_DESCENT_NM_PER_1000FT = 3.0


def _profile_fn(cat: str, rfl_ft: float, dep_elev: float, des_elev: float,
                total_nm: float):
    """(altitude_ft, gs_kt, phase) as a function of route fraction, per
    category. An overflight is level for the whole FIR crossing; an arrival
    enters at cruise and descends to the field; a departure climbs off the
    field and leaves the FIR at cruise."""
    total = total_nm or 1.0
    climb_nm = max(0.0, rfl_ft - dep_elev) / _CLIMB_FT_PER_NM
    desc_nm = max(0.0, rfl_ft - des_elev) / 1000.0 * _DESCENT_NM_PER_1000FT

    if cat == "domestic":
        # Short sectors never reach the filed level; share the route pro rata
        # between climb and descent so the profile stays continuous.
        if climb_nm + desc_nm > total * 0.94:
            k = total * 0.94 / (climb_nm + desc_nm)
            climb_nm, desc_nm = climb_nm * k, desc_nm * k
    elif cat == "arrival":
        climb_nm = 0.0
        desc_nm = min(desc_nm, total * 0.85)
    elif cat == "departure":
        desc_nm = 0.0
        climb_nm = min(climb_nm, total * 0.85)
    else:  # overflight — level throughout the crossing
        climb_nm = desc_nm = 0.0

    toc, tod = climb_nm / total, 1.0 - desc_nm / total

    def f(x):
        if x < toc:
            return (dep_elev + (rfl_ft - dep_elev) * (x / toc),
                    _GS_CLIMB, "climb")
        if x > tod and tod < 1.0:
            k = (x - tod) / (1.0 - tod)
            return (des_elev + (rfl_ft - des_elev) * (1 - k),
                    _GS_DESCENT, "descent")
        return rfl_ft, _GS_CRUISE, "cruise"

    return f


def sample_points(route_pts, eobt, cat, rfl_ft, dep_elev, des_elev):
    """16 samples spaced by equal *time* along the route (not equal distance),
    so the timestamps reflect the climb/cruise/descent speeds actually flown."""
    coords = [(p[1], p[2]) for p in route_pts]
    dist = [0.0]
    for a, b in zip(coords, coords[1:]):
        dist.append(dist[-1] + nm_between(a, b))
    total = dist[-1] or 1.0
    prof = _profile_fn(cat, rfl_ft, dep_elev, des_elev, total)
    time = [0.0]
    for i in range(1, len(dist)):
        gs = prof((dist[i - 1] + dist[i]) / 2.0 / total)[1]
        time.append(time[-1] + (dist[i] - dist[i - 1]) / gs * 3600.0)
    dur = time[-1] or 1.0
    out = []
    for k in range(SAMPLES_PER_ROUTE):
        t = dur * k / (SAMPLES_PER_ROUTE - 1)
        # locate t in the cumulative-time table -> distance -> position
        i = 0
        while i < len(time) - 2 and time[i + 1] < t:
            i += 1
        span = (time[i + 1] - time[i]) or 1.0
        frac = min(1.0, max(0.0, (t - time[i]) / span))
        (a_lat, a_lon), (b_lat, b_lon) = coords[i], coords[i + 1]
        lat = a_lat + (b_lat - a_lat) * frac
        lon = a_lon + (b_lon - a_lon) * frac
        f = (dist[i] + (dist[i + 1] - dist[i]) * frac) / total
        alt_ft, gs, phase = prof(f)
        # Track = bearing to a point a little further along the same leg. That
        # target is degenerate at the very end of the route, and on a
        # zero-length leg (a fix repeated by the route expansion); either way
        # hold the previous track rather than emitting a spurious 000°.
        nxt = frac + 0.01
        ahead = (a_lat + (b_lat - a_lat) * nxt, a_lon + (b_lon - a_lon) * nxt)
        if nxt <= 1.0 and (abs(ahead[0] - lat) > 1e-9 or abs(ahead[1] - lon) > 1e-9):
            trk = bearing(lat, lon, *ahead)
        elif out:
            trk = out[-1]["trk"]
        else:
            nz = next((c for c in coords[1:] if c != coords[0]), coords[-1])
            trk = bearing(lat, lon, *nz)
        out.append({
            "lat": lat, "lon": lon, "alt_ft": alt_ft,
            "gs": int(round(gs)),
            "trk": trk,
            "phase": phase,
            "ts": eobt + timedelta(seconds=round(t)),
        })
    return out, dur


# ---------------------------------------------------------------------------
# Flight construction
# ---------------------------------------------------------------------------
def build_flight(cat: str, adep: str, ades: str, rng: random.Random) -> dict | None:
    """Assemble one flight's route + procedures, or None when it can't be
    routed from the published Thai AIP (unknown gateway, no airway path…)."""
    sid = star = approach = dep_rwy = arr_rwy = ""
    route_str = ""

    if cat == "domestic":
        opts = PUBLISHED.get((adep, ades))
        if opts:
            r = rng.choice(opts)
            route_str, rnav = r["route"], bool(r.get("rnav"))
        else:
            join = None
            for proc, fix in (SID_EXIT.get(adep) or {}).items():
                for sproc, sfix in (STAR_ENTRY.get(ades) or {}).items():
                    p = shortest_path(fix, sfix)
                    if p and len(p) >= 2:
                        c = path_nm(p)
                        if join is None or c < join[0]:
                            join = (c, proc, sproc, p)
            if join is None:
                return None
            _c, sid, star, path = join
            route_str, rnav = item15(path), True
    else:
        rnav = True
        if cat == "arrival":
            gw = gateway_for("entry", adep, rng)
            if gw is None:
                return None
            best = _best_join(gw, STAR_ENTRY.get(ades) or {}, reverse=False)
            if best is None:
                return None
            _c, star, _fix, path = best
            route_str = item15(path)
        elif cat == "departure":
            gw = gateway_for("exit", ades, rng)
            if gw is None:
                return None
            best = _best_join(gw, SID_EXIT.get(adep) or {}, reverse=True)
            if best is None:
                return None
            _c, sid, _fix, path = best
            route_str = item15(path)
        else:  # overflight
            gin, gout = crossing_corridor(adep, ades, rng)
            if not gin or not gout or gin == gout:
                return None
            path = shortest_path(gin, gout, avoid_tma=True)
            if not path or len(path) < 2:
                return None
            route_str = item15(path)

    coords = resolve_route_coords(route_str)
    if len(coords) < 2:
        return None

    if cat == "domestic" and not (sid and star):
        # A published AIP route is filed fix-to-fix; attach the SID/STAR that
        # best connects to its ends, exactly as the app would on import.
        idents = [c[0] for c in coords]
        sid = sid or proc_for_route(SID_EXIT.get(adep) or {}, idents, idents[0])
        star = star or proc_for_route(
            STAR_ENTRY.get(ades) or {}, idents, idents[-1]
        )

    # Anchor the modelled path at the Thai aerodrome(s); a foreign field has no
    # AIP coordinates, so that end of the route stays at the FIR gateway fix.
    pts = list(coords)
    if adep in AIRPORTS:
        la, lo, _e = AIRPORTS[adep]
        pts = [(adep, la, lo)] + pts
    if ades in AIRPORTS:
        la, lo, _e = AIRPORTS[ades]
        pts = pts + [(ades, la, lo)]

    if sid:
        dep_rwy = _expand_runway(adep, SID_RWY.get((adep, sid), ""))
    if star:
        arr_rwy = _expand_runway(ades, STAR_RWY.get((ades, star), ""))
        approach = pick_approach(ades, arr_rwy)
        if not approach:
            inbound = bearing(pts[-2][1], pts[-2][2], pts[-1][1], pts[-1][2])
            fb_rwy, fb_app = arrival_fallback(ades, inbound)
            if fb_app:
                arr_rwy, approach = fb_rwy, fb_app

    return {
        "cat": cat, "adep": adep, "ades": ades,
        "route_str": route_str, "route_pts": pts, "rnav": rnav,
        "sid": sid, "star": star, "approach": approach,
        "dep_rwy": dep_rwy, "arr_rwy": arr_rwy,
        "dep_elev": (runway_threshold_elevation_ft(adep, dep_rwy)
                     if adep in AIRPORTS else None),
        "des_elev": (runway_threshold_elevation_ft(ades, arr_rwy)
                     if ades in AIRPORTS else None),
    }


def _level_window(cat: str, nm: float) -> tuple[int, int]:
    """Plausible cruising-level band for a stage of ``nm``. Sampling the raw
    day-wide histogram would otherwise put a Bangkok–Narita departure at FL170
    (a level that only ever belonged to the 150 NM domestic hops in it)."""
    if cat == "overflight":
        return 280, 430          # already at cruise when it enters the FIR
    if not nm:
        return 260, 400
    if nm < 250:
        return 150, 260
    if nm < 600:
        return 200, 330
    if nm < 1500:
        return 280, 390
    return 300, 430


def pick_level(cat: str, fl: dict, actype: str, brg: float, nm: float,
               rng: random.Random) -> int:
    """A CAB-compliant cruising level: sample the real day's level histogram for
    this category — restricted to the band this stage length can support — then
    snap to the semicircular rule and the airframe's reachable ceiling (CAB
    Rules of the Air §2.4.2)."""
    lo, hi = _level_window(cat, nm)
    band = [[k, v] for k, v in fl[cat] if lo <= int(k) <= hi]
    desired = int(weighted(band, rng)) if band else (lo + hi) // 2
    return cab_cruising_level_capped(
        brg, desired, int(reachable_ceiling_ft(actype) // 100)
    )


def csv_block(callsign, actype, adep, ades, rfl, route_str, eobt, samples,
              sid="", star="", approach="", dep_rwy="", arr_rwy=""):
    lines = [
        f"ROUTE: {route_str}",
        f"DEP: {adep}",
        f"DEST: {ades}",
        f"ACTYPE: {actype}",
        f"FL: F{rfl}",
        f"ATD: {eobt.strftime('%Y-%m-%d %H:%M:%S')}",
    ]
    if dep_rwy:
        lines.append(f"DEP RWY: {dep_rwy}")
    if arr_rwy:
        lines.append(f"ARR RWY: {arr_rwy}")
    if sid:
        lines.append(f"SID: {sid}")
    if star:
        lines.append(f"STAR: {star}")
    if approach:
        lines.append(f"APPROACH: {approach}")
    lines += ["", "---", "", "Timestamp,UTC,Callsign,Lat,Lon,Altitude,Speed,Direction"]
    for s in samples:
        lines.append(
            f"{int(s['ts'].timestamp())},{s['ts'].strftime('%Y-%m-%dT%H:%M:%SZ')},"
            f"{callsign},{s['lat']:.6f},{s['lon']:.6f},"
            f"{int(round(s['alt_ft']))},{s['gs']},{s['trk']}"
        )
    return "\n".join(lines)


CORRIDORS: dict[str, list] = {
    p: [[c, n] for c, n in v]
    for p, v in PROFILE["overflight_corridors"].items()
}
CORRIDORS_ALL: list = [
    [c, n] for c, n in PROFILE["overflight_corridors_all"]
    if all(f in GRAPH for f in c.split("|"))
]

PUBLISHED: dict[tuple[str, str], list[dict]] = {}
for _r in json.loads(ROUTES_PATH.read_text(encoding="utf-8"))["routes"]:
    if "CTRI" in _r["route"].split():        # AIP "CTR I" typo — no coords
        continue
    PUBLISHED.setdefault((_r["adep"], _r["ades"]), []).append(_r)


def main() -> None:
    ap = argparse.ArgumentParser(description="Generate the 24-hour Thai traffic sample.")
    ap.add_argument("--flights", type=int, default=600,
                    help="flights in the sample; the real day was 2906 (default: 600)")
    ap.add_argument("--seed", type=int, default=20251223, help="RNG seed")
    ap.add_argument("--out", default="thai24h_traffic",
                    help="output basename under dummy_data/")
    args = ap.parse_args()

    rng = random.Random(args.seed)
    counts = PROFILE["category_counts"]
    total_real = sum(counts.values())
    quota = {c: max(1, round(args.flights * counts[c] / total_real)) for c in _CATS}

    hourly = PROFILE["hourly_utc"]
    pairs = {c: [[k, v] for k, v in PROFILE["pairs"][c]] for c in _CATS}
    airlines = {c: [[k, v] for k, v in PROFILE["airlines"][c]] for c in _CATS}
    pair_ops = {p: [[k, v] for k, v in ops]
                for p, ops in PROFILE["pair_airlines"].items()}
    fl_hist = {c: [[int(k), v] for k, v in PROFILE["cruise_fl"][c]] for c in _CATS}

    used_cs: set[str] = set()
    prelim: list[dict] = []
    skipped = {c: 0 for c in _CATS}
    for cat in _CATS:
        made = 0
        attempts = 0
        while made < quota[cat] and attempts < quota[cat] * 40:
            attempts += 1
            adep, ades = weighted(pairs[cat], rng).split("-")
            if adep == ades:
                continue
            fl = build_flight(cat, adep, ades, rng)
            if fl is None:
                skipped[cat] += 1
                continue
            # EOBT: sample the real diurnal curve for this category, then a
            # uniform minute/second inside the hour.
            hh = int(weighted([[h, n] for h, n in enumerate(hourly[cat])], rng))
            eobt = DAY + timedelta(hours=hh, minutes=rng.randrange(60),
                                   seconds=rng.randrange(0, 60, 5))
            actype = pick_actype(cat, adep, ades, rng)
            brg = bearing(fl["route_pts"][0][1], fl["route_pts"][0][2],
                          fl["route_pts"][-1][1], fl["route_pts"][-1][2])
            rfl = pick_level(cat, fl_hist, actype, brg, stage_nm(adep, ades), rng)
            # Operator: prefer the carriers that actually fly this city pair,
            # falling back to the category-wide mix for a pair seen only once.
            market = pair_ops.get(f"{adep}-{ades}")
            prefix = weighted(market or airlines[cat], rng)
            while True:
                cs = f"{prefix}{rng.randrange(10, 999)}"
                if cs not in used_cs:
                    used_cs.add(cs)
                    break
            fl.update({"callsign": cs, "actype": actype, "rfl": rfl, "eobt": eobt})
            fl["dur"] = sample_points(
                fl["route_pts"], eobt, cat, rfl * 100.0,
                fl["dep_elev"] if fl["dep_elev"] is not None else rfl * 100.0,
                fl["des_elev"] if fl["des_elev"] is not None else rfl * 100.0,
            )[1]
            prelim.append(fl)
            made += 1

    # In-trail separation on shared corridors: two aircraft must not leave the
    # same ADEP on the same SID (or land at the same ADES off the same STAR)
    # within _SEP_S of each other. Overflights are spread by entry gateway.
    sep = timedelta(seconds=_SEP_S)
    dep_last: dict[tuple, datetime] = {}
    arr_last: dict[tuple, datetime] = {}
    used_starts: set[datetime] = set()
    for p in sorted(prelim, key=lambda x: x["eobt"]):
        dur = timedelta(seconds=p["dur"])
        dep_key = (p["adep"], p["sid"] or p["route_pts"][0][0])
        arr_key = (p["ades"], p["star"] or p["route_pts"][-1][0])
        t = p["eobt"]
        if dep_key in dep_last:
            t = max(t, dep_last[dep_key] + sep)
        if arr_key in arr_last:
            t = max(t, arr_last[arr_key] + sep - dur)
        t = t.replace(microsecond=0)   # keep EOBTs on whole seconds
        while t in used_starts:
            t += timedelta(seconds=1)
        used_starts.add(t)
        p["eobt"] = t
        dep_last[dep_key] = t
        arr_last[arr_key] = t + dur

    # Rebuild the samples on the final times and emit.
    flights = sorted(prelim, key=lambda x: x["eobt"])
    for p in flights:
        p["samples"], p["dur"] = sample_points(
            p["route_pts"], p["eobt"], p["cat"], p["rfl"] * 100.0,
            p["dep_elev"] if p["dep_elev"] is not None else p["rfl"] * 100.0,
            p["des_elev"] if p["des_elev"] is not None else p["rfl"] * 100.0,
        )
        p["flight_key"] = (
            f"{p['callsign']}_{p['adep']}_{p['ades']}_"
            f"{p['eobt'].strftime('%Y-%m-%d %H:%M')}"
        )

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    total = len(flights)
    blocks = []
    for i, p in enumerate(flights, start=1):
        banner = ("=" * 64 + f"\nFLIGHT {i} of {total}  -  {p['flight_key']}\n"
                  + "=" * 64 + "\n\n")
        blocks.append(banner + csv_block(
            p["callsign"], p["actype"], p["adep"], p["ades"], p["rfl"],
            p["route_str"], p["eobt"], p["samples"],
            sid=p["sid"], star=p["star"], approach=p["approach"],
            dep_rwy=p["dep_rwy"], arr_rwy=p["arr_rwy"],
        ))
    csv_path = OUT_DIR / f"{args.out}.csv"
    csv_path.write_text("\n\n\n".join(blocks) + "\n", encoding="utf-8")

    features = []
    for p in flights:
        features.append({
            "type": "Feature",
            "properties": {
                "feature_type": "route",
                "flight_key": p["flight_key"],
                "route": p["route_str"],
                "callsign": p["callsign"],
                "aircraft_type": p["actype"],
                "adep": p["adep"], "ades": p["ades"],
                "rfl": p["rfl"],
                "sid": p["sid"], "star": p["star"], "approach": p["approach"],
                "dep_rwy": p["dep_rwy"], "arr_rwy": p["arr_rwy"],
                "eobt": p["eobt"].isoformat(),
                "flight_category": p["cat"],
                "idents": [q[0] for q in p["route_pts"]],
            },
            "geometry": {
                "type": "LineString",
                "coordinates": [[q[2], q[1]] for q in p["route_pts"]],
            },
        })
        for s in p["samples"]:
            features.append({
                "type": "Feature",
                "properties": {
                    "flight_key": p["flight_key"],
                    "callsign": p["callsign"],
                    "aircraft_type": p["actype"],
                    "adep": p["adep"], "ades": p["ades"],
                    "epoch_ts": s["ts"].strftime("%Y-%m-%d %H:%M:%S+00:00"),
                    "altitude_ft": round(s["alt_ft"], 1),
                    "tas_kt": None,
                    "gs_kt": float(s["gs"]),
                    "track_deg": s["trk"],
                    "phase": s["phase"],
                },
                "geometry": {
                    "type": "Point",
                    "coordinates": [round(s["lon"], 6), round(s["lat"], 6),
                                    round(s["alt_ft"] * 0.3048, 1)],
                },
            })
    geojson_path = OUT_DIR / f"{args.out}.geojson"
    geojson_path.write_text(
        json.dumps({"type": "FeatureCollection", "features": features}),
        encoding="utf-8",
    )

    made = {c: sum(1 for p in flights if p["cat"] == c) for c in _CATS}
    foreign = {p["adep"] for p in flights if p["adep"] not in AIRPORTS}
    foreign |= {p["ades"] for p in flights if p["ades"] not in AIRPORTS}
    span = (min(p["eobt"] for p in flights), max(p["eobt"] for p in flights))
    print(f"Flights: {total}  {made}")
    print(f"Foreign aerodromes: {len(foreign)} | unroutable attempts: {skipped}")
    print(f"UTC span: {span[0].isoformat()} … {span[1].isoformat()}")
    print(f"CSV:     {csv_path}")
    print(f"GeoJSON: {geojson_path}")


if __name__ == "__main__":
    main()
