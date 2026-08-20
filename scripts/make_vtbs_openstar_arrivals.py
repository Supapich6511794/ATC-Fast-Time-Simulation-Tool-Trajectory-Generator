"""Generate a VTBS arrival bank flown on OPEN STARs — the vector-to-final case.

Every VTBS STAR ends in a VM leg ("fly heading 015, expect vectors"), so an
arrival there is not a coded path to the runway: the controller vectors it onto
final. This file is the test fixture for that whole chain —

  * the engine's vector-to-final builder (``trajectory_sim.vectors``), which
    puts a TURN and an INTC fix between the STAR and the approach's FAF;
  * the arrival sequencer (``web/lib/cdr/arrivalSequence.ts``), which measures
    in-trail spacing against the Doc 4444 §8.7.3 minima;
  * the wake table (``web/lib/cdr/wake.ts``), which is what actually binds on
    final — a MEDIUM behind a HEAVY needs 5 NM, not 3.

By default the bank flies the NO-CONFLICT flow: the STAR to its last fix, then
the approach from its IAF (ATKIN, LETMA, LAVOG, LOTMU, FAF, MAPt). That is the
problem to be solved — the arrivals are all on the published path and several
consecutive pairs are inside their minima. Pass ``--vector`` to fly the same
bank on the CONFLICT flow instead (hold the published heading, then intercept),
which is what applying the fix produces.

Unlike the other dummy generators these are NOT cosmetic samples: each flight
is generated through the REAL backend, so the written 4D points follow the
path actually flown.

The bank is deliberately over-delivered. Landing times are calibrated to the
engine and spaced by ``--spacing-sec`` (default 75 s ≈ 3.4 NM at approach
speed), which is inside the wake minimum for most consecutive pairs, so the
sequencer has real deficits to find and the vectoring has real work to do.
Aircraft types cycle HEAVY/MEDIUM (plus an A380) so every row of the wake
matrix gets exercised.

Each flight flies the STAR its filed route actually connects to, resolved by the
same ``/api/suggest-procedure`` the map's generator panel uses. That is what the
route says: a flight filed "… BLAFF DCT NORTA" arrives on NORT1C, and naming any
of the other four RW19 STARs would send it to an entry gate its route never
reaches. A bank into one runway therefore lands mostly on one or two STARs —
which is what an arrival stream looks like. Pass ``--cycle-stars`` for the old
round-robin over all five.

Each flight is flown on a published SID out of its origin as well — the
best-connecting one for its route, picked by the same ``/api/suggest-procedure``
the map's generator panel uses. An arrival bank whose flights all begin with a
DCT off the departure aerodrome is not what a controller ever sees, and the
climb shape differs: a SID turns and levels where the chart says to, so the
en-route entry point and the cruise arrival time are not the same as a direct
climb-out. Pass ``--no-sid`` for the old behaviour.

Outputs (same format as the other dummy files, round-trips through
``web/lib/flightFile.ts``):
  * dummy_data/vtbs_openstar_arrivals.csv
  * dummy_data/vtbs_openstar_arrivals.geojson

Run:  python scripts/make_vtbs_openstar_arrivals.py [--n 24] [--vector]

The three checked-in banks are made with:
  vtbs_openstar_arrivals  --n 24 --cycle-stars
  vtbs_arrival_loop       --n 10 --spacing-sec 62 --cycle-stars
                          --variants "0,2,4,6,8,10,14,18" --out vtbs_arrival_loop
  vtbs_arrival_demo       --n 12 --spacing-sec 66 --jitter-sec 30
                          --out vtbs_arrival_demo

``--cycle-stars`` on the first two only records how they were built; regenerate
them without it to put every flight on the STAR its route reaches.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from api.server import app  # noqa: E402

OUT_DIR = _ROOT / "dummy_data"
ROUTES_PATH = _ROOT / "web" / "public" / "data" / "aip_routes_VT.json"

HUB = "VTBS"
#: The five VTBS arrivals that serve RW19 — every one of them ends in a VM leg.
OPEN_STARS_RW19 = ["EAST1C", "LEBI1C", "NORT1C", "TUMG1C", "WILA1C"]
ARR_RWY = "RW19"
APPROACH = "R19"

#: Cycled so consecutive pairs exercise the §8.7.3.4 matrix: HEAVY behind
#: HEAVY (4 NM), MEDIUM behind HEAVY (5 NM), and the A380's own minima (7 NM
#: for a MEDIUM behind it). A LIGHT is not realistic into VTBS.
ACTYPES = [
    "B77W", "A320", "B789", "A21N", "A388", "B738",
    "A359", "A320", "B788", "B738", "A333", "A21N",
]
AIRLINES = [
    "THA", "SIA", "UAE", "AIQ", "CPA", "QTR",
    "ANA", "MAS", "JAL", "TGW", "KAL", "BAW",
]

DAY = datetime(2025, 12, 23, tzinfo=timezone.utc)
#: Downsample the engine's ~1 Hz output to keep the file a sane size while
#: still resolving the base turn (a 25° bank turn takes ~40 s).
SAMPLE_EVERY_S = 20.0


def _sid_airports(client: TestClient, adeps: set[str]) -> set[str]:
    """Of `adeps`, the ones that publish a SID at all."""
    out = set()
    for a in sorted(adeps):
        resp = client.get(f"/api/procedures/{a}", params={"type": "SID"})
        if resp.status_code == 200 and resp.json().get("SID"):
            out.add(a)
    return out


def _load_routes(client: TestClient, want_sid: bool) -> list[dict]:
    """Published AIP routes that arrive at the hub, RNAV first.

    With SIDs wanted, origins that publish one are preferred — only the first
    `--n` routes get used, so without this the bank can end up made entirely of
    the handful of aerodromes with no published departure and the SID column
    comes out empty.
    """
    routes = json.loads(ROUTES_PATH.read_text(encoding="utf-8"))["routes"]
    usable = [
        r for r in routes
        if r["ades"] == HUB and r["adep"] != HUB and "CTRI" not in r["route"].split()
    ]
    has_sid = (
        _sid_airports(client, {r["adep"] for r in usable}) if want_sid else set()
    )
    usable.sort(
        key=lambda r: (
            want_sid and r["adep"] not in has_sid, not r.get("rnav"), r["adep"]
        )
    )
    return usable


def _suggest_sid(client: TestClient, adep: str, route: str) -> str | None:
    """The published SID out of `adep` that best connects to `route`.

    Same endpoint the generator panel calls, so the fixture departs the way the
    app would have it depart rather than on a name picked here.
    """
    resp = client.get(
        f"/api/suggest-procedure/{adep}", params={"type": "SID", "route": route}
    )
    if resp.status_code != 200:
        return None
    name = resp.json().get("name")
    return str(name) if name else None


def _suggest_star(client: TestClient, route: str) -> str | None:
    """The RW19 STAR that actually CONNECTS to `route`.

    An arrival is filed to the fix its STAR begins at — a flight ending
    "… BLAFF DCT NORTA" is flying NORT1C, and putting WILA1C on it makes the
    aircraft leave the route it filed and cut across the terminal area to a
    different entry gate. Cycling the five RW19 STARs (``--cycle-stars``) gave
    the bank variety at the cost of exactly that: nine of twelve flights in the
    demo bank named a STAR their route never reaches.

    Restricted to `ARR_RWY` so the suggestion can always be flown to `APPROACH`,
    and resolved by the same endpoint the generator panel uses.
    """
    resp = client.get(
        f"/api/suggest-procedure/{HUB}",
        params={"type": "STAR", "route": route, "runway": ARR_RWY},
    )
    if resp.status_code != 200:
        return None
    name = resp.json().get("name")
    return str(name) if name else None


def _generate(client: TestClient, spec: dict) -> dict | None:
    resp = client.post("/api/generate", json=spec)
    if resp.status_code != 200:
        return None
    return resp.json()


def _spec(
    callsign: str, actype: str, adep: str, route: str, star: str,
    eobt: datetime, rfl: int, extend_nm: float = 0.0, vectors: bool = False,
    sid: str | None = None,
) -> dict:
    spec = {
        "source": "fpl",
        "callsign": callsign,
        "actype": actype,
        "adep": adep,
        "ades": HUB,
        "route": route,
        "eobt": eobt.strftime("%Y-%m-%dT%H:%M:%S"),
        "rfl": rfl,
        "star": star,
        "star_runway": ARR_RWY,
        "approach": APPROACH,
    }
    if sid:
        spec["sid"] = sid
    if vectors:
        spec["vector_to_final"] = True
        # Fly the vectored arrival tactically — timed from the speeds the
        # aircraft actually reports, and (with an extension) continuing from
        # the hand-over fix rather than re-planning the whole flight. Applied
        # at every extension INCLUDING zero, so the variants differ only by the
        # extension itself.
        spec["tactical_extend"] = True
    if extend_nm > 0:
        spec["extend_downwind_nm"] = extend_nm
    return spec


def _points(payload: dict) -> list[dict]:
    """Engine points, thinned to the output cadence (endpoints always kept)."""
    pts = payload["points"]
    if not pts:
        return []
    out = [pts[0]]
    last = datetime.fromisoformat(pts[0]["epoch_ts"])
    for p in pts[1:-1]:
        t = datetime.fromisoformat(p["epoch_ts"])
        if (t - last).total_seconds() >= SAMPLE_EVERY_S:
            out.append(p)
            last = t
    out.append(pts[-1])
    return out


def csv_block(fl: dict) -> str:
    lines = [
        f"ROUTE: {fl['route']}",
        f"DEP: {fl['adep']}",
        f"DEST: {HUB}",
        f"ACTYPE: {fl['actype']}",
        f"FL: F{fl['rfl']}",
        f"ATD: {fl['eobt'].strftime('%Y-%m-%d %H:%M:%S')}",
    ]
    if fl.get("sid"):
        lines.append(f"SID: {fl['sid']}")
    if fl.get("dep_rwy"):
        lines.append(f"DEP RWY: {fl['dep_rwy']}")
    lines += [
        f"ARR RWY: {ARR_RWY}",
        f"STAR: {fl['star']}",
        f"APPROACH: {APPROACH}",
        "",
        "---",
        "",
        "Timestamp,UTC,Callsign,Lat,Lon,Altitude,Speed,Direction",
    ]
    for p in fl["points"]:
        t = datetime.fromisoformat(p["epoch_ts"])
        lines.append(
            f"{int(t.timestamp())},{t.strftime('%Y-%m-%dT%H:%M:%SZ')},"
            f"{fl['callsign']},{p['lat']:.6f},{p['lon']:.6f},"
            f"{int(round(p.get('altitude_ft') or 0))},"
            f"{int(round(p.get('gs_kt') or 0))},"
            f"{int(round(p.get('track_deg') or 0))}"
        )
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--n", type=int, default=24, help="flights in the bank")
    ap.add_argument(
        "--spacing-sec", type=float, default=70.0,
        help="nominal seconds between landings. Deliberately tight: with the "
             "jitter below it puts several consecutive pairs inside their "
             "wake/runway minima, so the sequencer has real deficits to find "
             "(default 70)",
    )
    ap.add_argument(
        "--jitter-sec", type=float, default=20.0,
        help="+/- random spread on each landing slot, so the bank has a MIX of "
             "comfortable and tight pairs instead of one uniform gap that is "
             "either all legal or all illegal (default 20)",
    )
    ap.add_argument("--seed", type=int, default=20251223, help="jitter seed")
    ap.add_argument(
        "--first-landing", default="2025-12-23T03:00:00",
        help="UTC time the first aircraft touches down",
    )
    ap.add_argument(
        "--vector", action="store_true",
        help="fly the CONFLICT flow — hold the published heading off the end "
             "of the STAR, then intercept the extended centreline. Default is "
             "the no-conflict flow, straight down the published procedure.",
    )
    ap.add_argument(
        "--variants", default="",
        help="comma-separated extend_downwind_nm values to ALSO generate for "
             "every flight, e.g. '0,3,6,9,12'. Each variant is written as its "
             "own set of features tagged `extend_nm`, so a consumer can pick "
             "the one that delivers the delay it needs and re-measure the "
             "bank. Implies --vector.",
    )
    ap.add_argument(
        "--no-sid", dest="sid", action="store_false",
        help="depart on a DCT off the aerodrome instead of the published SID",
    )
    ap.add_argument(
        "--cycle-stars", action="store_true",
        help="assign the five RW19 STARs round-robin instead of the one that "
             "connects to each filed route. Spreads the bank across all five "
             "entry gates, but most flights then name a STAR their route never "
             "reaches — kept only to reproduce the pre-existing banks",
    )
    ap.add_argument("--out", default="vtbs_openstar_arrivals")
    args = ap.parse_args()

    variants = [
        float(v) for v in (args.variants or "").split(",") if v.strip() != ""
    ]
    if variants:
        args.vector = True
    client = TestClient(app)
    rng = random.Random(args.seed)
    routes = _load_routes(client, args.sid)
    if not routes:
        raise SystemExit(f"No published AIP routes into {HUB}")
    first_landing = datetime.fromisoformat(args.first_landing).replace(
        tzinfo=timezone.utc
    )

    flights: list[dict] = []
    # `flights` holds every generated trajectory INCLUDING the extra variants,
    # so the bank size is counted separately — otherwise asking for 10 flights
    # with 8 variants each would stop after the second aircraft.
    n_base = 0
    attempts = 0
    i = 0
    while n_base < args.n and attempts < args.n * 6:
        attempts += 1
        r = routes[i % len(routes)]
        i += 1
        actype = ACTYPES[n_base % len(ACTYPES)]
        callsign = f"{AIRLINES[n_base % len(AIRLINES)]}{100 + n_base}"
        # The STAR the filed route actually reaches. Falls back to the cycle
        # only when nothing connects, so a route with no usable arrival still
        # produces a flight instead of silently dropping out of the bank.
        star = (
            OPEN_STARS_RW19[n_base % len(OPEN_STARS_RW19)]
            if args.cycle_stars
            else _suggest_star(client, r["route"])
            or OPEN_STARS_RW19[n_base % len(OPEN_STARS_RW19)]
        )
        rfl = 320 if actype in ("A320", "A21N", "B738") else 360
        sid = _suggest_sid(client, r["adep"], r["route"]) if args.sid else None

        # Pass 1 — fly it once from a nominal EOBT to measure the block time,
        # then set the real EOBT so it lands in its sequence slot. The
        # trajectory shape is EOBT-invariant, so one probe is enough.
        probe = _generate(
            client,
            _spec(callsign, actype, r["adep"], r["route"], star, DAY, rfl,
                  vectors=args.vector, sid=sid),
        )
        if probe is None or not probe.get("points"):
            continue
        block_s = (
            datetime.fromisoformat(probe["points"][-1]["epoch_ts"])
            - datetime.fromisoformat(probe["points"][0]["epoch_ts"])
        ).total_seconds()
        slot = args.spacing_sec * n_base
        if n_base and args.jitter_sec:
            slot += rng.uniform(-args.jitter_sec, args.jitter_sec)
        target_landing = first_landing + timedelta(seconds=slot)
        eobt = target_landing - timedelta(seconds=block_s)

        payload = _generate(
            client,
            _spec(callsign, actype, r["adep"], r["route"], star, eobt, rfl,
                  vectors=args.vector, sid=sid),
        )
        if payload is None or not payload.get("points"):
            continue
        idents = [w["ident"] for w in payload["route"]]
        # Whichever flow was asked for, the arrival must reach the runway via
        # the published final; a half-resolved path would be a broken fixture.
        if "BS790" not in idents or idents[-1] != "BS791":
            continue
        if args.vector and ("TURN" not in idents or "INTC" not in idents):
            continue

        def record(pl: dict, extend: float) -> dict:
            meta = pl.get("meta") or {}
            return {
                "callsign": callsign,
                "actype": actype,
                "adep": r["adep"],
                "route": r["route"],
                "star": star,
                # Taken from the RESPONSE, not from what was asked for: the
                # server resolves the runway and may decline a SID it cannot
                # splice, and the file has to say what was actually flown.
                "sid": meta.get("sid") or "",
                "dep_rwy": meta.get("dep_rwy") or "",
                "rfl": rfl,
                "eobt": eobt,
                "extend_nm": extend,
                "clearance": (pl.get("meta") or {}).get("clearance"),
                "landing": datetime.fromisoformat(pl["points"][-1]["epoch_ts"]),
                "idents": [w["ident"] for w in pl["route"]],
                "points": _points(pl),
                "route_pts": pl["route"],
            }

        flights.append(record(payload, 0.0))
        n_base += 1
        # The SAME flight flown with a longer downwind. Keeping the EOBT fixed
        # is the point: the delay has to come from the extra track miles, which
        # is exactly what the resolution claims to buy.
        for extend in variants:
            if extend <= 0:
                continue
            alt = _generate(
                client,
                _spec(callsign, actype, r["adep"], r["route"], star, eobt, rfl,
                      extend_nm=extend, vectors=True, sid=sid),
            )
            if alt and alt.get("points"):
                flights.append(record(alt, extend))

    if not flights:
        raise SystemExit("No arrivals could be generated")
    flights.sort(key=lambda f: (f["landing"], f["extend_nm"]))

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    total = len(flights)
    blocks = []
    for n, fl in enumerate(flights, start=1):
        key = (
            f"{fl['callsign']}_{fl['adep']}_{HUB}_"
            f"{fl['eobt'].strftime('%Y-%m-%d %H:%M')}"
        )
        if fl["extend_nm"]:
            key = f"{key}+{fl['extend_nm']:g}"
        fl["flight_key"] = key
        banner = (
            "=" * 64 + f"\nFLIGHT {n} of {total}  -  {key}\n" + "=" * 64 + "\n\n"
        )
        blocks.append(banner + csv_block(fl))
    csv_path = OUT_DIR / f"{args.out}.csv"
    csv_path.write_text("\n\n\n".join(blocks) + "\n", encoding="utf-8")

    features = []
    for fl in flights:
        features.append({
            "type": "Feature",
            "properties": {
                "feature_type": "route",
                "flight_key": fl["flight_key"],
                "route": fl["route"],
                "callsign": fl["callsign"],
                "aircraft_type": fl["actype"],
                "adep": fl["adep"],
                "ades": HUB,
                "rfl": fl["rfl"],
                "sid": fl.get("sid") or "",
                "star": fl["star"],
                "approach": APPROACH,
                "dep_rwy": fl.get("dep_rwy") or "",
                "arr_rwy": ARR_RWY,
                "eobt": fl["eobt"].isoformat(),
                "flight_category": "arrival",
                "vectored": bool(args.vector),
                "extend_nm": fl["extend_nm"],
                "clearance": fl.get("clearance"),
                "idents": fl["idents"],
            },
            "geometry": {
                "type": "LineString",
                "coordinates": [[w["lon"], w["lat"]] for w in fl["route_pts"]],
            },
        })
        for p in fl["points"]:
            t = datetime.fromisoformat(p["epoch_ts"])
            features.append({
                "type": "Feature",
                "properties": {
                    "flight_key": fl["flight_key"],
                    "callsign": fl["callsign"],
                    "aircraft_type": fl["actype"],
                    "adep": fl["adep"],
                    "ades": HUB,
                    "epoch_ts": t.strftime("%Y-%m-%d %H:%M:%S+00:00"),
                    "altitude_ft": round(p.get("altitude_ft") or 0.0, 1),
                    "tas_kt": p.get("tas_kt"),
                    "gs_kt": p.get("gs_kt"),
                    "track_deg": p.get("track_deg"),
                    "phase": p.get("phase"),
                },
                "geometry": {
                    "type": "Point",
                    "coordinates": [
                        round(p["lon"], 6), round(p["lat"], 6),
                        round((p.get("altitude_ft") or 0.0) * 0.3048, 1),
                    ],
                },
            })
    geojson_path = OUT_DIR / f"{args.out}.geojson"
    geojson_path.write_text(
        json.dumps({"type": "FeatureCollection", "features": features}),
        encoding="utf-8",
    )

    base = [f for f in flights if not f["extend_nm"]]
    gaps = [
        (b["landing"] - a["landing"]).total_seconds()
        for a, b in zip(base, base[1:])
    ]
    flow = "CONFLICT (vectored)" if args.vector else "NO CONFLICT (published)"
    print(f"Flights: {len(base)}   flow: {flow}"
          + (f"   variants: {variants} ({total} trajectories)" if variants else ""))
    sids = sorted({f.get("sid") or "" for f in flights} - {""})
    print(f"SIDs:    {len(sids)} distinct "
          f"({sum(1 for f in base if f.get('sid'))}/{len(base)} flights) {sids}"
          if args.sid else "SIDs:    off (--no-sid)")
    print(f"STARs:   {sorted({f['star'] for f in flights})}")
    print(f"Types:   {sorted({f['actype'] for f in flights})}")
    print(
        f"Landing: {base[0]['landing'].strftime('%H:%M:%S')} … "
        f"{base[-1]['landing'].strftime('%H:%M:%S')} UTC | "
        f"gap min/median {min(gaps):.0f}/{sorted(gaps)[len(gaps)//2]:.0f} s"
        if gaps else ""
    )
    print(f"CSV:     {csv_path}")
    print(f"GeoJSON: {geojson_path}")


if __name__ == "__main__":
    main()
