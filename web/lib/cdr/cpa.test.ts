import { describe, expect, it } from "vitest";

import {
  conflictWindow,
  cpa,
  horizontalWindow,
  intersect,
  verticalWindow,
} from "./cpa";
import { velocityFromGsTrack, type Vec2 } from "./geo";

/** Build a relative-velocity vector from two gs/track ground velocities. */
const relVel = (
  gs1: number,
  trk1: number,
  gs2: number,
  trk2: number,
): Vec2 => {
  const v1 = velocityFromGsTrack(gs1, trk1);
  const v2 = velocityFromGsTrack(gs2, trk2);
  return { x: v2.x - v1.x, y: v2.y - v1.y };
};

describe("cpa", () => {
  it("head-on: CPA is now-ish and passes through zero separation", () => {
    // A flies east at (0,0) 480 kt; B flies west 10 NM ahead, same track line.
    // Relative motion closes them straight to 0.
    const p: Vec2 = { x: 10, y: 0 }; // B is 10 NM east of A
    const v = relVel(480, 90, 480, 270); // A east, B west
    const { tCpa, dCpa } = cpa(p, v);
    expect(dCpa).toBeCloseTo(0, 6);
    // Closing speed 960 kt = 0.2667 NM/s over 10 NM ⇒ ~37.5 s.
    expect(tCpa).toBeCloseTo(10 / (960 / 3600), 3);
  });

  it("in-trail same speed: never closes (CPA distance = current gap)", () => {
    const p: Vec2 = { x: 5, y: 0 };
    const v = relVel(450, 90, 450, 90); // identical velocity → v_rel = 0
    const { tCpa, dCpa } = cpa(p, v);
    expect(tCpa).toBe(0); // clamped, no relative motion
    expect(dCpa).toBeCloseTo(5, 9);
  });

  it("90° crossing: CPA distance is the perpendicular miss", () => {
    // A east through origin; B north-bound, starting 8 NM east and 10 NM south,
    // same speed → they reach the crossing at different times, missing by a set
    // perpendicular distance.
    const v1 = velocityFromGsTrack(360, 90); // east
    const v2 = velocityFromGsTrack(360, 0); // north
    const p: Vec2 = { x: 8, y: -10 };
    const v: Vec2 = { x: v2.x - v1.x, y: v2.y - v1.y };
    const { dCpa } = cpa(p, v);
    expect(dCpa).toBeGreaterThan(0);
    // Analytic check: dCpa = |p + v t*|, sanity that it's below the start range.
    expect(dCpa).toBeLessThan(Math.hypot(8, 10));
  });
});

describe("horizontalWindow", () => {
  it("head-on breach: symmetric interval around CPA", () => {
    const p: Vec2 = { x: 10, y: 0 };
    const v = relVel(480, 90, 480, 270);
    const w = horizontalWindow(p, v, 5)!; // 5 NM minimum
    expect(w).not.toBeNull();
    // Enters 5 NM before the 0-NM CPA and exits 5 NM after, symmetric.
    const mid = (w.t0 + w.t1) / 2;
    expect(mid).toBeCloseTo(10 / (960 / 3600), 3);
    expect(w.t1 - mid).toBeCloseTo(mid - w.t0, 6);
  });

  it("clear pass-by: no interval when miss distance exceeds minimum", () => {
    // Parallel tracks 8 NM apart, both eastbound, different speeds: never < 5.
    const p: Vec2 = { x: 0, y: 8 };
    const v = relVel(400, 90, 460, 90);
    expect(horizontalWindow(p, v, 5)).toBeNull();
  });

  it("no relative motion but already inside: whole timeline", () => {
    const p: Vec2 = { x: 3, y: 0 };
    const v: Vec2 = { x: 0, y: 0 };
    const w = horizontalWindow(p, v, 5)!;
    expect(w.t0).toBe(-Infinity);
    expect(w.t1).toBe(Infinity);
  });
});

describe("verticalWindow", () => {
  it("level co-altitude: always within Sv", () => {
    const w = verticalWindow(0, 0, 1000)!;
    expect(w.t0).toBe(-Infinity);
    expect(w.t1).toBe(Infinity);
  });

  it("level but well separated: never within Sv", () => {
    expect(verticalWindow(2000, 0, 1000)).toBeNull();
  });

  it("converging vertically: bounded interval around the crossing", () => {
    // 2000 ft apart, closing at 2000 ft/min = 33.33 ft/s → gap < 1000 ft only
    // in a window bracketing the level-crossing.
    const dvz = -2000 / 60; // intruder descending toward ownship (ft/s)
    const w = verticalWindow(2000, dvz, 1000)!;
    expect(w.t0).toBeLessThan(w.t1);
    // Gap hits 1000 ft at t=30 s and −1000 ft at t=90 s.
    expect(w.t0).toBeCloseTo(30, 6);
    expect(w.t1).toBeCloseTo(90, 6);
  });
});

describe("intersect / conflictWindow", () => {
  it("returns null when horizontal and vertical breaches don't overlap in time", () => {
    // Horizontal breach early, vertical breach late → no simultaneous conflict.
    expect(intersect({ t0: 0, t1: 30 }, { t0: 60, t1: 90 })).toBeNull();
  });

  it("crossing traffic that is vertically stacked is NOT a conflict", () => {
    // Same 90° crossing geometry that closes horizontally, but 2000 ft apart and
    // level → vertical never within 1000 ft, so no conflict despite small dCpa.
    const v1 = velocityFromGsTrack(360, 90);
    const v2 = velocityFromGsTrack(360, 0);
    const p: Vec2 = { x: 5, y: -5 };
    const v: Vec2 = { x: v2.x - v1.x, y: v2.y - v1.y };
    const w = conflictWindow(p, v, 2000, 0, 5, 1000);
    expect(w).toBeNull();
  });

  it("co-altitude crossing that closes horizontally IS a conflict", () => {
    const v1 = velocityFromGsTrack(360, 90);
    const v2 = velocityFromGsTrack(360, 0);
    const p: Vec2 = { x: 3, y: -3 };
    const v: Vec2 = { x: v2.x - v1.x, y: v2.y - v1.y };
    const w = conflictWindow(p, v, 0, 0, 5, 1000);
    expect(w).not.toBeNull();
  });
});
