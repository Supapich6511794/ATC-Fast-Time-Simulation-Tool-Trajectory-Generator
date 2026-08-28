/**
 * The incremental re-scan.
 *
 * Auto-resolve applies one fix at a time, and each fix re-times exactly one
 * aircraft — but the scan behind it is over every pair, which at traffic-day
 * scale is ~2 million of them and a second of frozen main thread PER FIX. The
 * rescan walks only the pairs that touch a changed flight, so what it must
 * prove is that it still produces the SAME list the full scan would.
 */
import { describe, expect, it } from "vitest";

import { resolveConfig } from "./config";
import {
  rescanFlightPlanConflicts,
  scanFlightPlanConflicts,
  type PlanFlight,
} from "./planScan";

const cfg = resolveConfig();

/** Crossing traffic: even flights run east, odd ones north, all at similar
 *  levels, departures spread out so some pairs overlap and some never do. */
function bank(n: number): PlanFlight[] {
  return Array.from({ length: n }, (_, i) => {
    const east = i % 2 === 0;
    const lat = 13 + ((i * 7) % 12) * 0.05;
    const lon = 100 + ((i * 5) % 12) * 0.05;
    const samples = Array.from({ length: 120 }, (_, k) => ({
      t: k * 15,
      lat: lat + (east ? 0 : k * 0.006),
      lon: lon + (east ? k * 0.006 : 0),
      altitudeFt: 30000 + (i % 3) * 1000,
      gsKt: 450,
      tasKt: 450,
      track: east ? 90 : 0,
      phase: "cruise" as const,
    }));
    return {
      id: `f${i}`,
      callsign: `F${i}`,
      samples,
      offsetSec: i * 90,
      durationSec: 1785,
    };
  });
}

/** The same flight re-timed, as applying a fix produces it: a fresh sample
 *  table (so its identity changes) and a later slot. */
function retime(f: PlanFlight, bySec: number): PlanFlight {
  return {
    ...f,
    samples: f.samples.map((s) => ({ ...s })),
    offsetSec: f.offsetSec + bySec,
  };
}

describe("rescanFlightPlanConflicts", () => {
  const flights = bank(40);
  const full = scanFlightPlanConflicts(flights, cfg);

  it("has something to scan", () => {
    expect(full.length).toBeGreaterThan(3);
  });

  it("matches the full scan after one flight moves", () => {
    const moved = flights.map((f, i) => (i === 6 ? retime(f, 180) : f));
    const inc = rescanFlightPlanConflicts(full, moved, new Set(["f6"]), cfg);
    expect(inc).toEqual(scanFlightPlanConflicts(moved, cfg));
  });

  it("matches after several flights move at once", () => {
    const ids = new Set(["f3", "f4", "f21"]);
    const moved = flights.map((f) => (ids.has(f.id) ? retime(f, 240) : f));
    const inc = rescanFlightPlanConflicts(full, moved, ids, cfg);
    expect(inc).toEqual(scanFlightPlanConflicts(moved, cfg));
  });

  it("drops the conflicts a fix actually resolved", () => {
    // Push one flight two hours clear of everything: every pair it was in has
    // to disappear, and nobody else's may.
    const [gone] = full;
    const moved = flights.map((f) =>
      f.id === gone.a ? retime(f, 7200) : f,
    );
    const inc = rescanFlightPlanConflicts(full, moved, new Set([gone.a]), cfg);
    expect(inc.some((c) => c.id === gone.id)).toBe(false);
    expect(inc).toEqual(scanFlightPlanConflicts(moved, cfg));
  });

  it("keeps every untouched pair byte for byte", () => {
    const moved = flights.map((f, i) => (i === 6 ? retime(f, 60) : f));
    const inc = rescanFlightPlanConflicts(full, moved, new Set(["f6"]), cfg);
    for (const c of inc) {
      if (c.a === "f6" || c.b === "f6") continue;
      expect(full).toContain(c); // same object, not merely equal
    }
  });

  it("returns the previous list untouched when nothing changed", () => {
    expect(rescanFlightPlanConflicts(full, flights, new Set(), cfg)).toBe(full);
  });

  it("forgets a flight that has left the set", () => {
    const fewer = flights.filter((f) => f.id !== "f6");
    const inc = rescanFlightPlanConflicts(full, fewer, new Set(["f6"]), cfg);
    expect(inc.some((c) => c.a === "f6" || c.b === "f6")).toBe(false);
    expect(inc).toEqual(scanFlightPlanConflicts(fewer, cfg));
  });
});
