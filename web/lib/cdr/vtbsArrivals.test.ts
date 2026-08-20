/**
 * The VTBS open-STAR arrival bank as a fixture.
 *
 * The bank is the NO-CONFLICT flow: every arrival is on the full published
 * path (STAR to its last fix, then the approach from its IAF). That is the
 * PROBLEM state — several consecutive pairs are inside their §8.7.3 minima,
 * and it is what the sequencer and the fix planner have to act on. Flying it
 * vectored is the resolution, and lives on the engine side
 * (`trajectory_sim/tests/test_server_vectors.py` covers both flows).
 *
 * A fixture that quietly stops testing anything is worse than none — if the
 * bank ends up comfortably separated, or loses its wake mix, this fails rather
 * than passing on an empty set. Regenerate with:
 *   python scripts/make_vtbs_openstar_arrivals.py
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { holdFix, holdLoopsFor, planArrivalFix, type ArrivalHold } from "./arrivalFix";
import { nextHoldOnRoute } from "./useArrivals";
import type { Holding } from "@/lib/holdings";
import type { TrajectoryResult } from "@/lib/trajectory/types";
import { sequenceArrivals, type ArrivalInput } from "./arrivalSequence";
import { resolveConfig } from "./config";
import type { FutureSample } from "./types";

const cfg = resolveConfig();

interface Feat {
  properties: Record<string, string | number | boolean | string[] | null>;
  geometry: { type: string; coordinates: number[] | number[][] };
}

// The fixture is GENERATED and not in git, so it can legitimately be absent on
// a fresh clone or after a clean-up. Skip with the command to rebuild it rather
// than failing the suite over a missing artefact.
const FIXTURE = resolve(
  __dirname,
  "../../../dummy_data/vtbs_openstar_arrivals.geojson",
);
const present = existsSync(FIXTURE);
if (!present) {
  console.warn(
    "[vtbsArrivals] fixture missing — skipping. Rebuild with:" +
      "  python scripts/make_vtbs_openstar_arrivals.py --n 24",
  );
}
const gj = (present
  ? JSON.parse(readFileSync(FIXTURE, "utf-8"))
  : { features: [] }) as { features: Feat[] };

const routes = gj.features.filter((f) => f.properties.feature_type === "route");
const pointsByKey = new Map<string, Feat[]>();
for (const f of gj.features) {
  if (f.properties.feature_type === "route") continue;
  const k = String(f.properties.flight_key);
  pointsByKey.set(k, [...(pointsByKey.get(k) ?? []), f]);
}

const ts = (f: Feat): number =>
  new Date(String(f.properties.epoch_ts).replace(" ", "T")).getTime();
const t0 = Math.min(...[...pointsByKey.values()].map((p) => ts(p[0])));

const inputs: ArrivalInput[] = routes.map((r) => {
  const key = String(r.properties.flight_key);
  const pts = pointsByKey.get(key) ?? [];
  const line = r.geometry.coordinates as number[][];
  const end = line[line.length - 1];
  const future: FutureSample[] = pts.map((p) => ({
    dt: (ts(p) - t0) / 1000,
    lat: (p.geometry.coordinates as number[])[1],
    lon: (p.geometry.coordinates as number[])[0],
    altFt: Number(p.properties.altitude_ft ?? 0),
  }));
  return {
    id: key,
    callsign: String(r.properties.callsign),
    type: String(r.properties.aircraft_type),
    ades: "VTBS",
    arrRwy: String(r.properties.arr_rwy),
    threshold: { lat: end[1], lon: end[0] },
    future,
    gsKt: Number(pts[0].properties.gs_kt ?? 250),
    trackDeg: Number(pts[0].properties.track_deg ?? 0),
  };
});

const stream = sequenceArrivals(cfg, inputs)[0];

describe.skipIf(!present)("vtbs_openstar_arrivals fixture — the trajectories", () => {
  it("is a single VTBS RW19 arrival bank", () => {
    expect(routes.length).toBeGreaterThanOrEqual(20);
    expect(sequenceArrivals(cfg, inputs)).toHaveLength(1);
    expect(stream.ades).toBe("VTBS");
    expect(stream.runway).toBe("RW19");
  });

  it("flies the FULL published procedure — the no-conflict flow", () => {
    // Nothing has been resolved yet, so no aircraft has left the chart.
    for (const r of routes) {
      const idents = r.properties.idents as string[];
      const who = String(r.properties.callsign);
      expect(r.properties.vectored, who).toBe(false);
      expect(idents, who).not.toContain("TURN");
      expect(idents, who).not.toContain("INTC");
      // The approach is flown from its IAF through to the runway.
      const tail = idents.slice(-5);
      expect(tail, who).toEqual(["LETMA", "LAVOG", "LOTMU", "BS790", "BS791"]);
    }
  });

  it("departs on a published SID, not a DCT off the aerodrome", () => {
    // A bank whose flights all begin with a direct is not traffic any
    // controller sees, and the climb-out shape is not the same — a SID turns
    // and levels where the chart says to, so the en-route entry point and the
    // arrival time differ from a straight climb.
    for (const r of routes) {
      const who = String(r.properties.callsign);
      expect(String(r.properties.sid), who).not.toBe("");
      expect(String(r.properties.dep_rwy), who).toMatch(/^RW/);
      // Flown, not merely labelled: the path starts at the departure runway.
      const idents = r.properties.idents as string[];
      expect(idents[0], who).toBe(String(r.properties.dep_rwy));
    }
  });

  it("uses all five open VTBS RW19 STARs", () => {
    const stars = new Set(routes.map((r) => String(r.properties.star)));
    expect([...stars].sort()).toEqual([
      "EAST1C",
      "LEBI1C",
      "NORT1C",
      "TUMG1C",
      "WILA1C",
    ]);
  });

  it("carries real engine samples, densely enough to resolve the approach", () => {
    for (const r of routes) {
      const pts = pointsByKey.get(String(r.properties.flight_key))!;
      expect(pts.length).toBeGreaterThan(20);
      // Descending and slowing into the field, not a flat interpolation.
      const alts = pts.map((p) => Number(p.properties.altitude_ft));
      expect(Math.max(...alts)).toBeGreaterThan(20000);
      expect(alts[alts.length - 1]).toBeLessThan(200);
    }
  });
});

describe.skipIf(!present)("vtbs_openstar_arrivals fixture — the spacing problem", () => {
  it("mixes wake categories so the §8.7.3.4 minima actually bind", () => {
    const wakes = new Set(stream.arrivals.map((a) => a.wake));
    expect(wakes.has("HEAVY")).toBe(true);
    expect(wakes.has("MEDIUM")).toBe(true);
    expect(wakes.has("SUPER")).toBe(true); // the A380
    for (const a of stream.arrivals) expect(a.wakeKnown).toBe(true);
  });

  it("is neither all-legal nor all-illegal — a MIX to sequence", () => {
    expect(stream.deficits.length).toBeGreaterThan(0);
    expect(stream.deficits.length).toBeLessThan(stream.pairs.length);
  });

  it("has the wake minimum drive at least one pair", () => {
    expect(stream.pairs.some((p) => p.requiredBy === "wake")).toBe(true);
  });

  it("yields an actionable instruction for every deficit", () => {
    for (const p of stream.deficits) {
      const plan = planArrivalFix(cfg, p, {
        openStar: true,
        vectorHeadingDeg: 15,
      });
      expect(plan.fixes.length).toBeGreaterThan(0);
      expect(plan.fixes.some((f) => f.sufficient)).toBe(true);
      expect(plan.fixes[0].target).toBe(p.follower.id);
    }
  });

  it("measures spacing from the paths, never falling back to an estimate", () => {
    // The whole bank is inside the projection, so every pair is measured.
    for (const p of stream.pairs) expect(p.estimated).toBe(false);
  });
});

/* ---------------------------------------------------------------------------
 * Holding — is there anywhere to actually hold a VTBS arrival?
 *
 * The panel offers a hold whenever a published fix is still ahead on the route.
 * Whether that is ever TRUE at VTBS is a fact about the AIRAC data, not about
 * the code, so it is checked against the real holdings file. If a future AIRAC
 * drops the STAR-entry holds, the feature quietly stops being reachable — this
 * fails instead.
 * ------------------------------------------------------------------------ */

const HOLDINGS_FILE = resolve(
  __dirname,
  "../../public/data/bangkok_fir_holdings_airac2607/bangkok_fir_holdings_airac2607.geojson",
);
const holdingsPresent = existsSync(HOLDINGS_FILE);

const holdings = new Map<string, Holding>();
if (holdingsPresent) {
  const hg = JSON.parse(readFileSync(HOLDINGS_FILE, "utf-8")) as {
    features: {
      properties: Record<string, string | number | null>;
      geometry: { coordinates: number[] };
    }[];
  };
  for (const f of hg.features) {
    const ident = String(f.properties.waypoint_identifier ?? "").trim();
    if (!ident || holdings.has(ident)) continue;
    const num = (v: unknown) => (v == null || v === "" ? null : Number(v));
    holdings.set(ident, {
      ident,
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
      inboundCourseDeg: num(f.properties.inbound_holding_course_deg) ?? 0,
      turn: f.properties.turn_direction === "L" ? "L" : "R",
      legTimeMin: num(f.properties.leg_time_min) ?? 1,
      legLengthNm: num(f.properties.leg_length_nm),
      speedKt: num(f.properties.holding_speed_kt),
      minAltFt: num(f.properties.minimum_altitude_ft),
      maxAltFt: num(f.properties.maximum_altitude_ft),
    });
  }
}

/**
 * The hold the app would actually offer this flight, via the REAL resolver.
 *
 * Re-implementing the "which fix" rule here would test the re-implementation
 * and not the code: `nextHoldOnRoute` picks the earliest published fix still
 * AHEAD of the aircraft, and now that these flights fly a SID there are holds
 * behind them too — departure-area patterns 250+ NM from Bangkok. Which one is
 * offered depends entirely on where the aircraft is, so the clock is the whole
 * question and the test has to ask it the same way the app does.
 */
function holdFor(r: Feat, localT: number): ArrivalHold | null {
  const key = String(r.properties.flight_key);
  const idents = r.properties.idents as string[];
  const line = r.geometry.coordinates as number[][];
  const traj = {
    route: idents.map((ident, i) => ({
      ident,
      lat: line[i]?.[1] ?? 0,
      lon: line[i]?.[0] ?? 0,
    })),
  } as TrajectoryResult;
  const pts = pointsByKey.get(key) ?? [];
  const samples = pts.map((p) => ({
    t: (ts(p) - ts(pts[0])) / 1000,
    lat: (p.geometry.coordinates as number[])[1],
    lon: (p.geometry.coordinates as number[])[0],
    altitudeFt: Number(p.properties.altitude_ft ?? 0),
    gsKt: Number(p.properties.gs_kt ?? 230),
    tasKt: Number(p.properties.tas_kt ?? 230),
    track: Number(p.properties.track_deg ?? 0),
    phase: String(p.properties.phase ?? "descent"),
  })) as Parameters<typeof nextHoldOnRoute>[1];
  return nextHoldOnRoute(traj, samples, localT, holdings);
}

/** Local time (s) this flight begins its descent — where an arrival that needs
 *  sequencing actually is when the panel looks at it. */
function descentStart(r: Feat): number {
  const pts = pointsByKey.get(String(r.properties.flight_key)) ?? [];
  const t0 = ts(pts[0]);
  const i = pts.findIndex((p) => p.properties.phase === "descent");
  return ((i < 0 ? ts(pts[pts.length - 1]) : ts(pts[i])) - t0) / 1000;
}

describe.skipIf(!present || !holdingsPresent)(
  "vtbs_openstar_arrivals fixture — somewhere to hold",
  () => {
    it("every arrival has a published holding fix still ahead of it", () => {
      for (const r of routes) {
        expect(
          holdFor(r, descentStart(r)),
          String(r.properties.callsign),
        ).not.toBeNull();
      }
    });

    it("holds INSIDE the arrival area, not back at the departure aerodrome", () => {
      // These flights depart on a SID and cross half of Thailand, so there are
      // published holds behind them as well as ahead — BIXEB off VTCL is 278 NM
      // from Bangkok. A hold there is a flow-control measure, not an
      // approach-spacing one, and it is not even reachable. What the descending
      // arrival gets offered must be a Bangkok TMA-entry pattern.
      const thr = stream.arrivals.length ? inputs[0].threshold : null;
      expect(thr).not.toBeNull();
      for (const r of routes) {
        const h = holdFor(r, descentStart(r))!;
        const dNm = Math.hypot(
          (h.lat - thr!.lat) * 60,
          (h.lon - thr!.lon) * 60 * Math.cos((thr!.lat * Math.PI) / 180),
        );
        expect(dNm, `${h.ident} for ${r.properties.callsign}`).toBeLessThan(120);
      }
    });

    it("offers a flyable hold for every short pair, at a real fix", () => {
      for (const p of stream.deficits) {
        const r = routes.find(
          (x) => String(x.properties.flight_key) === p.follower.id,
        )!;
        const hold = holdFor(r, descentStart(r))!;
        const plan = planArrivalFix(cfg, p, {
          openStar: true,
          vectorHeadingDeg: 15,
          hold,
        });
        const h = plan.fixes.find((f) => f.kind === "hold")!;
        // Flyable: it names the fix, so Issue can splice the racetrack in.
        expect(h.hold?.ident).toBe(hold.ident);
        expect(h.sufficient).toBe(true);
        // One published 4-minute loop is far more than any of these gaps —
        // holding is a blunt instrument, and the panel must say what it buys
        // rather than pretend it is dialled to the deficit.
        expect(h.holdLoops).toBe(1);
        expect(h.absorbsNm).toBeGreaterThan(p.deficitNm);
      }
    });

    it("sizes a long bank in whole loops", () => {
      const f = stream.arrivals[stream.arrivals.length - 1];
      const r = routes.find((x) => String(x.properties.flight_key) === f.id)!;
      const hold = holdFor(r, descentStart(r))!;
      // A 60 NM backlog at a real Bangkok pattern takes more than one loop.
      const loops = holdLoopsFor(cfg, f, hold, 60);
      expect(loops).toBeGreaterThan(1);
      expect(holdFix(cfg, f, hold, 60, loops).absorbsNm).toBeGreaterThanOrEqual(60);
    });
  },
);
