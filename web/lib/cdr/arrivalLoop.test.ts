/**
 * THE CLOSED LOOP — does the fix the panel proposes actually work?
 *
 * VERDICT: not yet. This file records how far it gets, and why it stops there.
 *
 * Everything else tests one link: the sequencer measures a deficit, the planner
 * turns it into an extension, the engine flies it. This runs the chain:
 *
 *   1. sequence + plan the bank as filed        -> a delay per aircraft
 *   2. swap each delayed aircraft for the path the engine ACTUALLY flew with
 *      that downwind extension                  -> the resolved bank
 *   3. sequence it again                        -> is the bank clean?
 *
 * Step 2 is what makes this real rather than arithmetic: the substituted paths
 * are engine output (`make_vtbs_openstar_arrivals.py --variants`), so the extra
 * track miles come from actual vector geometry.
 *
 * One pass now removes ~90 % of the shortfall. It gets there because the
 * extension is flown TACTICALLY (`tactical_extend`): the aircraft is already at
 * the hand-over fix when the instruction is issued, so everything up to that
 * fix is kept and only the track after it changes. Re-planning the flight from
 * EOBT instead — which is what a plain `extend_downwind_nm` does — moves
 * top-of-descent back, puts the aircraft over the hand-over fix 3 000 ft
 * higher, and flies the extra track in the cruise band at ~450 kt, so the
 * extension buys almost none of the delay it should.
 *
 * What is left is the variant matrix in this fixture being coarse: the plan
 * asks for (say) 0.8 NM and the nearest variant flies 2 NM, and that overshoot
 * pushes the aircraft behind. That is a property of the fixture, not of the
 * engine — with a continuous extension the residual would be the ~5 % turn
 * smoothing loss alone.
 *
 * Regenerate the fixture with:
 *   python scripts/make_vtbs_openstar_arrivals.py --n 10 --spacing-sec 62 \
 *          --variants "0,2,4,6,8,10,14,18" --out vtbs_arrival_loop
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { planArrivalStream, type ArrivalPlan } from "./arrivalPlan";
import { sequenceArrivals, type ArrivalInput } from "./arrivalSequence";
import { resolveConfig } from "./config";
import type { FutureSample } from "./types";

const cfg = resolveConfig();
const THR = { lat: 13.69171389, lon: 100.76103333 };
const CONTEXT = () => ({ openStar: true, vectorHeadingDeg: 15 });

interface Feat {
  properties: Record<string, string | number | boolean | string[] | null>;
  geometry: { type: string; coordinates: number[] | number[][] };
}

// Generated, not in git — skip (with the rebuild command) rather than failing
// the suite when the artefact is absent.
const FIXTURE = resolve(
  __dirname,
  "../../../dummy_data/vtbs_arrival_loop.geojson",
);
const present = existsSync(FIXTURE);
if (!present) {
  console.warn(
    "[arrivalLoop] fixture missing — skipping. Rebuild with:" +
      '  python scripts/make_vtbs_openstar_arrivals.py --n 10 --spacing-sec 62 ' +
      '--variants "0,2,4,6,8,10,14,18" --out vtbs_arrival_loop',
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

const tsOf = (f: Feat): number =>
  new Date(String(f.properties.epoch_ts).replace(" ", "T")).getTime();
/** One shared clock for the bank, so every dt is on the same origin. */
const T0 = Math.min(...[...pointsByKey.values()].map((p) => tsOf(p[0])));

interface Variant {
  extendNm: number;
  input: ArrivalInput;
  /** Track distance (NM) and block time (s) of the engine's own path. */
  distNm: number;
  blockSec: number;
  /** Ground speed the engine REPORTS at touchdown (kt). */
  reportedFinalGsKt: number;
}
const byCallsign = new Map<string, Variant[]>();

for (const r of routes) {
  const pts = pointsByKey.get(String(r.properties.flight_key)) ?? [];
  if (pts.length < 2) continue;
  const callsign = String(r.properties.callsign);
  const future: FutureSample[] = pts.map((p) => ({
    dt: (tsOf(p) - T0) / 1000,
    lat: (p.geometry.coordinates as number[])[1],
    lon: (p.geometry.coordinates as number[])[0],
    altFt: Number(p.properties.altitude_ft ?? 0),
  }));
  let distNm = 0;
  for (let k = 1; k < future.length; k++) {
    const a = future[k - 1];
    const b = future[k];
    distNm += Math.hypot(
      (b.lat - a.lat) * 60,
      (b.lon - a.lon) * 60 * Math.cos((a.lat * Math.PI) / 180),
    );
  }
  byCallsign.set(callsign, [
    ...(byCallsign.get(callsign) ?? []),
    {
      extendNm: Number(r.properties.extend_nm ?? 0),
      distNm,
      blockSec: future[future.length - 1].dt - future[0].dt,
      reportedFinalGsKt: Number(pts[pts.length - 1].properties.gs_kt ?? 0),
      input: {
        // Identity is the AIRCRAFT, not the variant — swapping one in must not
        // look like a different aeroplane joining the sequence.
        id: callsign,
        callsign,
        type: String(r.properties.aircraft_type),
        ades: "VTBS",
        arrRwy: String(r.properties.arr_rwy),
        threshold: THR,
        future,
        gsKt: Number(pts[0].properties.gs_kt ?? 250),
        trackDeg: Number(pts[0].properties.track_deg ?? 0),
      },
    },
  ]);
}
for (const l of byCallsign.values()) l.sort((a, b) => a.extendNm - b.extendNm);

const baseInputs = [...byCallsign.values()].map(
  (v) => v.find((x) => x.extendNm === 0)!.input,
);

/** Smallest variant delivering at least `needNm` of extra distance. */
function variantFor(callsign: string, needNm: number): Variant {
  const list = byCallsign.get(callsign)!;
  return list.find((v) => v.extendNm >= needNm - 1e-9) ?? list[list.length - 1];
}

function planOf(inputs: ArrivalInput[]): ArrivalPlan {
  const streams = sequenceArrivals(cfg, inputs);
  expect(streams).toHaveLength(1);
  return planArrivalStream(cfg, streams[0], CONTEXT);
}

const before = present ? planOf(baseInputs) : (null as unknown as ArrivalPlan);
/** Apply the plan: each delayed aircraft flies the variant that covers it. */
const applied = present
  ? before.order.map((p) => variantFor(p.arrival.callsign, Math.max(0, p.delayNm)))
  : [];
const after = present
  ? planOf(applied.map((v) => v.input))
  : (null as unknown as ArrivalPlan);

describe.skipIf(!present)("the fixture poses a real problem", () => {
  it("is one VTBS RW19 bank with several pairs inside their minima", () => {
    expect(baseInputs.length).toBeGreaterThanOrEqual(8);
    expect(before.ades).toBe("VTBS");
    expect(before.actions.length).toBeGreaterThan(0);
    expect(before.totalDelayNm).toBeGreaterThan(5);
  });

  it("offers every variant the engine was asked to fly, per aircraft", () => {
    for (const [cs, list] of byCallsign) {
      expect(list.map((v) => v.extendNm), cs).toEqual([
        0, 2, 4, 6, 8, 10, 14, 18,
      ]);
    }
  });

  it("a bigger extension always means further to fly", () => {
    // Monotonic, and the biggest one adds real distance. Deliberately NOT a
    // tight per-variant band: how much of a requested extension actually
    // reaches the path depends on the geometry (the intercept has a feasible
    // range, and the turns get smoothed), and measured here it runs anywhere
    // from ~30 % to ~105 %. That spread is itself why one pass under-delivers.
    for (const [cs, list] of byCallsign) {
      for (let i = 1; i < list.length; i++) {
        expect(list[i].distNm, `${cs} +${list[i].extendNm}`).toBeGreaterThan(
          list[i - 1].distNm,
        );
      }
      expect(
        list[list.length - 1].distNm - list[0].distNm,
        `${cs} +18`,
      ).toBeGreaterThan(10);
    }
  });
});

describe.skipIf(!present)("the tactical extension keeps what has already been flown", () => {
  it("the aircraft is at the SAME state over the hand-over fix in every variant", () => {
    // This is the whole point of applying the fix tactically. "Extend downwind"
    // is issued to an aircraft that is already at ATKIN; it cannot retroactively
    // change how high it was when it got there.
    for (const [cs, list] of byCallsign) {
      const alts = list.map((v) => {
        // The hand-over is the last fix before the vector legs; sample the path
        // at its position via the first point of the tail that is common to all
        // variants — here, the highest-altitude point inside the terminal area.
        const near = v.input.future.filter((f) => f.altFt < 12000);
        return near.length ? Math.round(near[0].altFt) : 0;
      });
      const spread = Math.max(...alts) - Math.min(...alts);
      expect(spread, `${cs}: hand-over altitude varies by ${spread} ft`).toBeLessThan(
        250,
      );
    }
  });
});

describe.skipIf(!present)("applying the planned fix", () => {
  it("SINGLE PASS: removes the great majority of the shortfall", () => {
    expect(after.totalDelayNm).toBeLessThan(before.totalDelayNm * 0.2);
    for (const p of after.order) {
      const was = before.order.find(
        (b) => b.arrival.callsign === p.arrival.callsign,
      )!;
      expect(p.delayNm, p.arrival.callsign).toBeLessThanOrEqual(
        was.delayNm + 0.001,
      );
    }
  });

  it("KNOWN GAP: a small residual survives the first pass", () => {
    // Attributable to the coarse variant matrix (see the file header), not to
    // the engine. Tighten if the fixture gains a continuous extension.
    expect(after.totalDelayNm).toBeGreaterThan(0);
    expect(after.totalDelayNm).toBeLessThan(10);
  });

  it("keeps the same aircraft in the same landing order", () => {
    // A fix must re-time the bank, not re-order it.
    expect(after.order.map((p) => p.arrival.callsign)).toEqual(
      before.order.map((p) => p.arrival.callsign),
    );
  });

  it("delays only the aircraft that were short", () => {
    const needed = new Set(before.actions.map((a) => a.arrival.callsign));
    for (const v of applied) {
      if (v.extendNm > 0) {
        expect(needed.has(v.input.callsign), v.input.callsign).toBe(true);
      }
    }
  });
});

describe.skipIf(!present)("the contract the planner relies on", () => {
  it("the extension is flown at APPROACH speed, not cruise speed", () => {
    // The defect this replaced: the extra downwind track used to be flown at
    // ~450 kt because a re-plan booked it to the cruise phase. Flown
    // tactically it goes by at the aircraft's actual approach speed.
    for (const [cs, list] of byCallsign) {
      const plain = list[0];
      const long = list[list.length - 1];
      const marginalKt =
        ((long.distNm - plain.distNm) / (long.blockSec - plain.blockSec)) * 3600;
      expect(
        marginalKt / plain.reportedFinalGsKt,
        `${cs}: extension flown at ${marginalKt.toFixed(0)} kt against a ` +
          `reported ${plain.reportedFinalGsKt.toFixed(0)} kt on approach`,
      ).toBeLessThan(1.35);
    }
  });

  it("extending by D really does open the gap by about D", () => {
    // What `planArrivalFix` promises when it says "extend downwind N NM".
    // Measured on an isolated pair so no cascade interferes.
    const [a, b] = [...byCallsign.keys()];
    const spacingAt = (extendNm: number): number => {
      const inputs = [
        byCallsign.get(a)!.find((v) => v.extendNm === 0)!.input,
        byCallsign.get(b)!.find((v) => v.extendNm === extendNm)!.input,
      ];
      return sequenceArrivals(cfg, inputs)[0].pairs[0].spacingNm;
    };
    const base = spacingAt(0);
    for (const d of [4, 8, 14, 18]) {
      const gained = spacingAt(d) - base;
      // ~5 % is lost to turn smoothing; over-delivering would mean the
      // geometry is not being solved.
      expect(gained, `extend ${d}`).toBeGreaterThan(d * 0.85);
      expect(gained, `extend ${d}`).toBeLessThan(d * 1.05);
    }
  });
});
