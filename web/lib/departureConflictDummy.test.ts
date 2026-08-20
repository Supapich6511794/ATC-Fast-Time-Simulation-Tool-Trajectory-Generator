/**
 * The departure-conflict sample (dummy_data/departure_conflict_flights.csv) is
 * a fixture with a claim attached: import it and the panel must raise exactly
 * four departure conflicts, one per Doc 4444 rule, and stay silent on the three
 * control pairs. A fixture nobody checks drifts away from the engine, so this
 * runs the file through the SAME parser the upload button uses and then through
 * the same rules the panel calls, mapping plans to departures the way
 * GeneratorPanel does (track = bearing to the first fix the route names).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  eobtToMs,
  findDepartureConflicts,
  initialBearingDeg,
  msToEobt,
  resolvedEobtMs,
  type DepartureFlight,
} from "./departureSeparation";
import { parseFlightFile } from "./flightFile";

const DUMMY = resolve(__dirname, "../../dummy_data/departure_conflict_flights.csv");
const AIP = resolve(__dirname, "../public/data/aip_VT.json");

const csv = readFileSync(DUMMY, "utf-8");
const records = await parseFlightFile(new File([csv], "departure_conflict_flights.csv"));

const aip = JSON.parse(readFileSync(AIP, "utf-8")) as {
  waypoints: Record<string, { lat: number; lon: number }>;
  airports: Record<string, { lat: number; lon: number }>;
};

/** The panel's own mapping: a plan becomes a departure, and its track is the
 *  bearing from the aerodrome to the first fix its route names. */
const flights: DepartureFlight[] = records.map((r, i) => {
  const from = aip.airports[r.adep ?? ""];
  const firstFix = (r.route ?? "")
    .toUpperCase()
    .split(/\s+/)
    .find((w) => aip.waypoints[w]);
  const to = firstFix ? aip.waypoints[firstFix] : aip.airports[r.ades ?? ""];
  return {
    id: `p${i + 1}`,
    callsign: r.callsign ?? "",
    actype: r.actype ?? "",
    adep: r.adep ?? "",
    ades: r.ades ?? "",
    eobtMs: eobtToMs(r.eobt ?? ""),
    depRwy: r.depRwy ?? "",
    trackDeg:
      from && to ? initialBearingDeg(from.lat, from.lon, to.lat, to.lon) : null,
    gsKt: r.gsKt ?? 450,
    rfl: r.rfl ?? 350,
  };
});

const conflicts = findDepartureConflicts(flights);
const byPair = new Map(
  conflicts.map((c) => [`${c.leader.callsign}|${c.follower.callsign}`, c]),
);

describe("departure_conflict_flights dummy file", () => {
  it("imports as plans, not as trajectories", () => {
    // The panel must open these as editable tabs and warn — NOT load them
    // as-is, which is what happens when a file carries 4D samples.
    expect(records).toHaveLength(16);
    expect(records.every((r) => r.trajectory == null)).toBe(true);
    for (const r of records) {
      expect(r.callsign).toMatch(/^[A-Z]{3}\d+$/);
      expect(r.adep).toMatch(/^[A-Z]{4}$/);
      expect(r.eobt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
      expect(r.route).toBeTruthy();
      expect(r.gsKt).toBeGreaterThan(100);
    }
  });

  it("raises exactly the five designed conflicts, worst first", () => {
    expect([...byPair.keys()].sort()).toEqual([
      "MAS701|QTR700",
      "SIA500|JAL501",
      "TGW400|THA401",
      "THA100|THA200",
      "UAE300|AIQ301",
    ].sort());
    // Ranked by how much time is missing: the 5-minute rule with 2 minutes
    // filed is the worst of them.
    expect(conflicts[0].follower.callsign).toBe("THA401");
  });

  it("§7.9.2 — same everything, so the runway itself sets the minute", () => {
    const c = byPair.get("THA100|THA200")!;
    expect(c.adep).toBe("VTCC");
    expect(c.gapSec).toBe(0);
    expect(c.requiredSec).toBe(60);
    expect(c.requiredBy).toBe("runway-occupancy");
    // Both plans file "Auto", which is the aerodrome's default runway.
    expect(c.runway).toBe("Auto");
    expect(c.runwayAssumed).toBe(true);
  });

  it("§5.8.3.1 — MEDIUM behind HEAVY needs 2 min", () => {
    const c = byPair.get("UAE300|AIQ301")!;
    expect(c.requiredBy).toBe("wake");
    expect(c.requiredSec).toBe(120);
    expect(c.gapSec).toBe(60);
    expect(c.runway).toBe("RW19");
  });

  it("§5.6.3 — climbing through the level ahead needs 5 min", () => {
    const c = byPair.get("TGW400|THA401")!;
    expect(c.requiredBy).toBe("level-crossing");
    expect(c.requiredSec).toBe(300);
    expect(c.gapSec).toBe(120);
  });

  it("§5.6.2 — a 50 kt faster leader on the same track needs 2 min", () => {
    const c = byPair.get("SIA500|JAL501")!;
    expect(c.requiredBy).toBe("speed");
    expect(c.requiredSec).toBe(120);
    expect(c.gapSec).toBe(60);
  });

  it("§8.7.3 — two runways feeding one path is still a conflict", () => {
    // The pair a runway-keyed check waves through: RW19 and RW01, but both
    // filed VANKO Y8 at FL350 and 450 kt, so they climb out in formation.
    const c = byPair.get("MAS701|QTR700")!;
    expect(c.runway).toBe("RW01 / RW19");
    expect(c.runwayAssumed).toBe(false);
    expect(c.requiredBy).toBe("in-trail");
    expect(c.requiredSec).toBe(24); // 3 NM at 450 kt
    expect(c.gapSec).toBe(0);
    // Same track is what makes it one: the runways point opposite ways, the
    // filed paths do not.
    const q = flights.find((f) => f.callsign === "QTR700")!;
    const m = flights.find((f) => f.callsign === "MAS701")!;
    expect(Math.abs(q.trackDeg! - m.trackDeg!)).toBeLessThan(1);
  });

  it("stays silent on the three control pairs", () => {
    // §5.6.1 divergence relief on one runway, the same relief across two, and
    // simply enough time.
    for (const pair of ["KAL600|BAW601", "EVA901|SVA900", "ANA800|CPA801"]) {
      expect(byPair.has(pair)).toBe(false);
    }
    // …and the divergence control really is diverging, not merely spaced out.
    const kal = flights.find((f) => f.callsign === "KAL600")!;
    const baw = flights.find((f) => f.callsign === "BAW601")!;
    expect(Math.abs(kal.trackDeg! - baw.trackDeg!)).toBeGreaterThan(45);
    expect((baw.eobtMs! - kal.eobtMs!) / 1000).toBe(60);
  });

  it("clears completely once each follower takes the suggested EOBT", () => {
    let fixed = flights;
    for (const c of conflicts) {
      const ms = resolvedEobtMs(c, c.follower.id)!;
      fixed = fixed.map((f) =>
        f.id === c.follower.id ? { ...f, eobtMs: eobtToMs(msToEobt(ms)) } : f,
      );
    }
    expect(findDepartureConflicts(fixed)).toEqual([]);
  });
});
