import { describe, expect, it } from "vitest";

import { resolveConfig } from "./config";
import { generatePlanResolutions } from "./planAdvisory";
import { scanFlightPlanConflicts, type PlanFlight } from "./planScan";
import { applyManeuver } from "./kinematics";
import { toSamples, totalSeconds } from "@/lib/useSimPlayback";
import type { TrajectoryPoint, TrajectoryResult } from "@/lib/trajectory/types";

const cfg = resolveConfig();
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

/** A straight, level cruise leg from lon0 heading east (90) or west (270). */
function leg(
  id: string,
  lat: number,
  lon0: number,
  trackDeg: number,
  altFt = 35000,
  n = 220,
  gs = 450,
): TrajectoryResult {
  const dt = 4;
  const nmPerDegLon = Math.cos((lat * Math.PI) / 180) * 60;
  const east = Math.sin((trackDeg * Math.PI) / 180); // +1 E, −1 W
  const points: TrajectoryPoint[] = [];
  for (let i = 0; i < n; i++) {
    const nm = (gs * i * dt) / 3600;
    points.push({
      lat,
      lon: lon0 + (nm * east) / nmPerDegLon,
      epoch_ts: new Date(T0 + i * dt * 1000).toISOString(),
      altitude_ft: altFt,
      gs_kt: gs,
      tas_kt: gs,
      track_deg: trackDeg,
      phase: "cruise",
    });
  }
  const last = points[points.length - 1];
  return {
    route: [{ ident: "WPT1", lat, lon: last.lon }],
    points,
    stats: {
      waypointCount: 1,
      pointCount: n,
      distanceNm: 100,
      timeMinutes: (n * dt) / 60,
      cruiseAltFt: altFt,
      rflFt: altFt,
    },
    profile: { toc: null, tod: null },
    validation: null,
    meta: {
      flightKey: id,
      callsign: id,
      aircraftType: "B738",
      adep: "AAAA",
      ades: "BBBB",
      eobtIso: new Date(T0).toISOString(),
    },
  };
}

/** Head-on pair at FL350: A east from lon 100, B west from ~60 NM ahead. */
function headOn() {
  const lat = 13;
  const nmPerDegLon = Math.cos((lat * Math.PI) / 180) * 60;
  const a = leg("THA1", lat, 100, 90);
  const b = leg("AIQ2", lat, 100 + 60 / nmPerDegLon, 270);
  const flights: PlanFlight[] = [a, b].map((t) => ({
    id: t.meta.flightKey,
    callsign: t.meta.callsign,
    samples: toSamples(t.points),
    offsetSec: 0,
    durationSec: totalSeconds(t.points),
  }));
  const trajById = new Map([
    ["THA1", { traj: a, offset: 0 }],
    ["AIQ2", { traj: b, offset: 0 }],
  ]);
  return { a, b, flights, trajById };
}

describe("generatePlanResolutions", () => {
  const { flights, trajById } = headOn();
  const [conflict] = scanFlightPlanConflicts(flights, cfg);

  it("detects the head-on conflict as a definite loss", () => {
    expect(conflict).toBeDefined();
    expect(conflict.definite).toBe(true);
  });

  it("auto-generates ranked, validated suggestions with reason + score", () => {
    const res = generatePlanResolutions({
      conflict,
      flights,
      trajById,
      simT: 0,
      cfg,
      restricted: [],
    });
    expect(res.length).toBeGreaterThan(0);
    // Ranked cheapest-first; every one carries a reason, a score and a verdict.
    for (let i = 1; i < res.length; i++) {
      expect(res[i].cost).toBeGreaterThanOrEqual(res[i - 1].cost);
    }
    for (const r of res) {
      expect(r.instruction).not.toBe("");
      expect(r.reason).not.toBe("");
      expect(r.score).toBeGreaterThan(0);
      expect(r.score).toBeLessThanOrEqual(100);
      expect(r.constraintVerdict).not.toBe("reject");
    }
    // The best suggestion scores highest.
    expect(res[0].score).toBe(100);
  });

  it("offers a level change (clears vertically) among the options", () => {
    const res = generatePlanResolutions({
      conflict,
      flights,
      trajById,
      simT: 0,
      cfg,
      restricted: [],
    });
    expect(res.some((r) => r.type === "flightlevel")).toBe(true);
  });

  it("the top suggestion, when applied, actually clears the conflict", () => {
    const res = generatePlanResolutions({
      conflict,
      flights,
      trajById,
      simT: 0,
      cfg,
      restricted: [],
    });
    const top = res[0];
    const info = trajById.get(top.target)!;
    // Re-apply with the EXACT timing the advisory validated the candidate with.
    const modified = applyManeuver(
      info.traj,
      { type: top.type, resolution: top.resolution },
      top.tManLocal,
      { deviationSec: top.deviationSec, rejoinSec: top.rejoinSec, bankAngleDeg: cfg.bankAngleDeg },
    );
    const newFlights = flights.map((f) =>
      f.id === top.target
        ? { ...f, samples: toSamples(modified.points), durationSec: totalSeconds(modified.points) }
        : f,
    );
    expect(scanFlightPlanConflicts(newFlights, cfg)).toHaveLength(0);
  });
});

/** In-trail overtake: LEAD (slower) ahead, REAR (faster) 6 NM behind on the same
 *  track/level → REAR catches up. A turn only delays it; speed is the fix. */
function overtake() {
  const lat = 13;
  const nmPerDegLon = Math.cos((lat * Math.PI) / 180) * 60;
  // LEAD 450 kt; REAR 20 kt faster, 8 NM behind → catches up over ~24 min. A
  // −30 kt reduction puts REAR below LEAD (as for a real A320↔B77W pair).
  const lead = leg("LEAD", lat, 100, 90, 35000, 400, 450);
  const rear = leg("REAR", lat, 100 - 8 / nmPerDegLon, 90, 35000, 400, 470);
  const flights: PlanFlight[] = [lead, rear].map((t) => ({
    id: t.meta.flightKey,
    callsign: t.meta.callsign,
    samples: toSamples(t.points),
    offsetSec: 0,
    durationSec: totalSeconds(t.points),
  }));
  const trajById = new Map([
    ["LEAD", { traj: lead, offset: 0 }],
    ["REAR", { traj: rear, offset: 0 }],
  ]);
  return { flights, trajById };
}

describe("generatePlanResolutions — in-trail overtake", () => {
  const { flights, trajById } = overtake();
  const [conflict] = scanFlightPlanConflicts(flights, cfg);

  it("ranks a speed REDUCTION on the rear (faster) aircraft #1", () => {
    expect(conflict).toBeDefined();
    const res = generatePlanResolutions({
      conflict,
      flights,
      trajById,
      simT: 0,
      cfg,
      restricted: [],
    });
    expect(res.length).toBeGreaterThan(0);
    expect(res[0].type).toBe("speed");
    expect(res[0].value).toBeLessThan(0); // a reduction
    expect(res[0].target).toBe("REAR"); // the faster / rear aircraft
    expect(res[0].score).toBe(100);
  });

  it("finds a LARGER reduction (−40+) for a fast overtake a −30 can't clear", () => {
    // REAR 45 kt faster than LEAD → a −30 leaves it at +15 kt, still catching.
    // The engine must reach for a bigger cut (−40/−50) rather than give up.
    const lat = 13;
    const nmPerDegLon = Math.cos((lat * Math.PI) / 180) * 60;
    const lead = leg("LEAD", lat, 100, 90, 35000, 400, 450);
    const rear = leg("REAR", lat, 100 - 8 / nmPerDegLon, 90, 35000, 400, 495);
    const flights: PlanFlight[] = [lead, rear].map((t) => ({
      id: t.meta.flightKey,
      callsign: t.meta.callsign,
      samples: toSamples(t.points),
      offsetSec: 0,
      durationSec: totalSeconds(t.points),
    }));
    const trajById = new Map([
      ["LEAD", { traj: lead, offset: 0 }],
      ["REAR", { traj: rear, offset: 0 }],
    ]);
    const [conflict] = scanFlightPlanConflicts(flights, cfg);
    const res = generatePlanResolutions({
      conflict,
      flights,
      trajById,
      simT: 0,
      cfg,
      restricted: [],
    });
    expect(res[0].type).toBe("speed");
    expect(res[0].target).toBe("REAR");
    expect(res[0].value).toBeLessThanOrEqual(-40); // needed a bigger cut than −30
  });

  it("the #1 speed reduction, when applied, actually clears the overtake", () => {
    const res = generatePlanResolutions({
      conflict,
      flights,
      trajById,
      simT: 0,
      cfg,
      restricted: [],
    });
    const top = res[0];
    const info = trajById.get(top.target)!;
    const modified = applyManeuver(
      info.traj,
      { type: top.type, resolution: top.resolution },
      top.tManLocal,
      { deviationSec: top.deviationSec, rejoinSec: top.rejoinSec, bankAngleDeg: cfg.bankAngleDeg },
    );
    const newFlights = flights.map((f) =>
      f.id === top.target
        ? { ...f, samples: toSamples(modified.points), durationSec: totalSeconds(modified.points) }
        : f,
    );
    expect(scanFlightPlanConflicts(newFlights, cfg)).toHaveLength(0);
  });
});
