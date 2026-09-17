/**
 * Dynamic sector AREA — the cut itself.
 *
 * A boundary change is drawn on a radar screen and briefed to two controllers,
 * so what has to hold is that the slice is a real piece of the overloaded
 * sector, that it lies on the side facing the sector taking it, and that it
 * contains exactly the traffic that needs to move. The refusals matter as much
 * as the cuts: each one has to come back with its reason.
 */
import { describe, expect, it } from "vitest";

import {
  bearingOf,
  centroidOf,
  clipHalfPlane,
  planAreaTransfer,
  ringAreaNm2,
  toLocalNm,
  type AreaFlight,
  type Rings,
} from "./dynamicArea";

/** A 2°x2° box. At 14°N that is about 116 x 120 NM. */
const box = (west: number, south: number, size = 2): Rings => [
  [
    { lat: south, lon: west },
    { lat: south, lon: west + size },
    { lat: south + size, lon: west + size },
    { lat: south + size, lon: west },
  ],
];

/** WEST is 98-100E, EAST is 100-102E; they share the 100E boundary. */
const WEST = box(98, 13);
const EAST = box(100, 13);

/** `n` aircraft spread west-to-east across WEST, at a constant latitude. */
const spread = (n: number, from = 98.1, to = 99.9): AreaFlight[] =>
  Array.from({ length: n }, (_, i) => ({
    flight: "F" + String(i).padStart(2, "0"),
    lat: 14,
    lon: from + ((to - from) * i) / Math.max(1, n - 1),
  }));

describe("the local frame", () => {
  it("measures a degree of latitude as 60 NM", () => {
    const [, y] = toLocalNm({ lat: 14, lon: 100 }, { lat: 15, lon: 100 });
    expect(y).toBeCloseTo(60, 6);
  });

  it("shrinks a degree of longitude by the cosine of the latitude", () => {
    const [x] = toLocalNm({ lat: 60, lon: 100 }, { lat: 60, lon: 101 });
    expect(x).toBeCloseTo(30, 1); // cos 60 = 0.5
  });

  it("gives a 2-degree box its real area", () => {
    // 2 deg lat = 120 NM; 2 deg lon at 14N = 120 * cos 14 = 116.4 NM.
    const a = ringAreaNm2({ lat: 14, lon: 99 }, WEST[0]);
    expect(a).toBeGreaterThan(13000);
    expect(a).toBeLessThan(14500);
  });

  it("puts the centroid of a box in its middle", () => {
    const c = centroidOf(WEST);
    expect(c.lat).toBeCloseTo(14, 3);
    expect(c.lon).toBeCloseTo(99, 3);
  });
});

describe("clipping to a half-plane", () => {
  const square: [number, number][] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];

  it("keeps the far side of the cut", () => {
    const out = clipHalfPlane(square, [1, 0], 6);
    expect(out.map((p) => p[0])).toEqual([6, 10, 10, 6]);
  });

  it("keeps everything when the cut misses the shape", () => {
    expect(clipHalfPlane(square, [1, 0], -5)).toHaveLength(4);
  });

  it("keeps nothing when the cut is past it", () => {
    expect(clipHalfPlane(square, [1, 0], 50)).toHaveLength(0);
  });

  it("handles a concave shape, which is the case convex clippers get wrong", () => {
    // An L: clipping the right half must leave the two arms, not a hull.
    const L: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 4],
      [4, 4],
      [4, 10],
      [0, 10],
    ];
    const out = clipHalfPlane(L, [1, 0], 2);
    expect(out.length).toBeGreaterThanOrEqual(6);
    expect(out.every((p) => p[0] >= 2 - 1e-9)).toBe(true);
  });
});

describe("bearings", () => {
  it("names the compass point the slice faces", () => {
    expect(bearingOf([0, 1]).name).toBe("north");
    expect(bearingOf([1, 0]).name).toBe("east");
    expect(bearingOf([0, -1]).name).toBe("south");
    expect(bearingOf([-1, 0]).name).toBe("west");
    expect(bearingOf([1, 1]).name).toBe("north-east");
  });
});

describe("planning a transfer", () => {
  const plan = (flights: number, toLoad = 0, over = 14) =>
    planAreaTransfer({
      from: { sector: "WEST", rings: WEST, flights: spread(flights) },
      to: { sector: "EAST", rings: EAST, flightCount: toLoad },
      splitAbove: over,
    });

  it("does nothing to a sector that is under capacity", () => {
    const r = plan(13);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not over capacity/);
  });

  it("moves the fewest aircraft that clear the overload", () => {
    // 16 aircraft, capacity 14: three must go so the sector ends at 13.
    const r = plan(16);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.transfer.flights).toHaveLength(3);
      expect(r.transfer.fromAfter).toBe(13);
    }
  });

  it("takes the aircraft nearest the sector receiving them", () => {
    const r = plan(16);
    // The spread runs west to east; EAST is to the east, so the movers are the
    // highest-numbered (easternmost) flights.
    if (r.ok) expect(r.transfer.flights).toEqual(["F13", "F14", "F15"]);
  });

  it("cedes the airspace on the side facing the receiving sector", () => {
    const r = plan(16);
    if (r.ok) {
      expect(r.transfer.quadrant).toBe("east");
      // Every corner of the slice is in the eastern part of WEST.
      expect(Math.min(...r.transfer.boundary.map((p) => p.lon))).toBeGreaterThan(99);
      expect(Math.max(...r.transfer.boundary.map((p) => p.lon))).toBeCloseTo(100, 3);
    }
  });

  it("gives the slice a real area, and less than the whole sector", () => {
    const r = plan(16);
    if (r.ok) {
      const whole = ringAreaNm2(centroidOf(WEST), WEST[0]);
      expect(r.transfer.areaNm2).toBeGreaterThan(0);
      expect(r.transfer.areaNm2).toBeLessThan(whole);
    }
  });

  it("refuses to move the overload rather than clear it", () => {
    // EAST already holds 13 of a 14 ceiling: taking three more just moves it.
    const r = plan(16, 13);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/would reach 16/);
  });

  it("cedes more airspace when the overload is worse", () => {
    const light = plan(16);
    const heavy = plan(24);
    if (light.ok && heavy.ok) {
      expect(heavy.transfer.flights.length).toBeGreaterThan(
        light.transfer.flights.length,
      );
      expect(heavy.transfer.areaNm2).toBeGreaterThan(light.transfer.areaNm2);
    }
  });

  it("refuses a slice holding an active restricted area", () => {
    const r = planAreaTransfer({
      from: { sector: "WEST", rings: WEST, flights: spread(16) },
      to: { sector: "EAST", rings: EAST, flightCount: 0 },
      splitAbove: 14,
      blockers: [{ ident: "VTR9", rings: box(99.7, 13.8, 0.2) }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/VTR9.*active/);
  });

  it("allows the cut when the restricted area sits outside the slice", () => {
    const r = planAreaTransfer({
      from: { sector: "WEST", rings: WEST, flights: spread(16) },
      to: { sector: "EAST", rings: EAST, flightCount: 0 },
      splitAbove: 14,
      // Far west, nowhere near the eastern slice.
      blockers: [{ ident: "VTR9", rings: box(98.1, 13.1, 0.2) }],
    });
    expect(r.ok).toBe(true);
  });

  it("refuses airspace out of the receiving sector's reach", () => {
    const r = planAreaTransfer({
      from: { sector: "WEST", rings: WEST, flights: spread(16) },
      to: { sector: "EAST", rings: EAST, flightCount: 0 },
      splitAbove: 14,
      // The slice's far corner sits ~95 NM from EAST's centre; 50 rules it out.
      maxCedeNm: 50,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/coverage limit/);
  });

  it("says why, every time it refuses", () => {
    for (const r of [plan(13), plan(16, 13)]) {
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
    }
  });
});
