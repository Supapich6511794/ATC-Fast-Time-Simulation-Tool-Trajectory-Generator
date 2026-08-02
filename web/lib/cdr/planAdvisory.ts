/**
 * Plan-aware resolution advisory.
 *
 * Unlike the live advisory (advisory.ts), which reasons over a short constant-
 * velocity look-ahead, this engine works for ANY conflict in the filed plan —
 * including ones far in the future — by actually building the maneuvered
 * trajectory (with route recovery), re-checking it in 3-D against EVERY other
 * flight over the whole plan, and running the constraint engine. Only candidates
 * that genuinely clear and pass hard constraints survive; they're ranked by a
 * weighted cost and returned with a plain-language reason and a 0–100 score, so
 * the controller sees "Turn right 20° · 94 · clears to 6.3 NM, back on route in
 * 4 min" instead of having to hand-tune sliders.
 *
 * Heavier than the live advisory (it re-times trajectories and scans the plan),
 * so it's meant to run on demand — when a conflict is opened — not per frame.
 */

import type { TrajectoryResult } from "@/lib/trajectory/types";
import {
  aircraftAt,
  toSamples,
  totalSeconds,
  type AircraftState,
} from "@/lib/useSimPlayback";

import { respectsSemicircular } from "./advisory";
import {
  horizontalMinimumNm,
  verticalMinimumFt,
  type CdrConfig,
  type ManeuverType,
} from "./config";
import {
  areaIdentsOnPath,
  evaluateConstraints,
  type PathPoint,
  type RestrictedArea,
} from "./constraints";
import { headingDeltaDeg } from "./geo";
import {
  applyManeuver,
  recoveryTiming,
  type ManeuverTiming,
} from "./kinematics";
import {
  pairConflict,
  pairSeparation,
  type PlanConflict,
  type PlanFlight,
} from "./planScan";
import type { ManeuverResolution } from "./types";
import { holdLegSec, holdLoopSec, type Holding } from "@/lib/holdings";

interface Sample extends AircraftState {
  t: number;
}

/** A ranked, plan-validated resolution with rationale + score. */
export interface PlanResolution {
  type: ManeuverType;
  target: string; // flightKey
  targetCallsign: string;
  instruction: string;
  resolution: ManeuverResolution;
  value: number;
  /** Horizontal CPA to the conflict partner: before → after (NM). */
  origDCpaNm: number;
  newDCpaNm: number;
  /** Vertical separation at CPA to the partner: before → after (ft). */
  origVertFt: number;
  newVertFt: number;
  extraDistanceNm: number;
  extraTimeSec: number;
  altChangeFt: number;
  trackDeviationDeg: number;
  cost: number;
  /** 0–100, higher = better (relative to the best candidate). */
  score: number;
  reason: string;
  constraintVerdict: "accept" | "caution" | "reject";
  /** The EXACT maneuver timing this candidate was validated with (local time to
   *  start the turn + how long to deviate + rejoin). The UI must apply the
   *  maneuver with this timing — recomputing it from the current track would
   *  produce a different, unvalidated maneuver. */
  tManLocal: number;
  deviationSec: number;
  rejoinSec: number;
}

export interface PlanAdvisoryArgs {
  conflict: PlanConflict;
  /** Every flight (index-aligned tables for the re-check). */
  flights: PlanFlight[];
  /** flightKey → its trajectory + EOBT offset, for building maneuvers. */
  trajById: Map<string, { traj: TrajectoryResult; offset: number }>;
  simT: number;
  cfg: CdrConfig;
  restricted: RestrictedArea[];
  /** Published holdings by fix ident — enables the HOLD resolution (fly one
   *  racetrack loop at a holding fix on the route ahead to delay + open
   *  spacing). Omitted → hold isn't offered. */
  holdings?: Map<string, Holding>;
  topN?: number;
}

const FL_DELTAS = [1000, -1000, 2000, -2000];
// Gentlest first: the per-(target,type) dedup keeps the FIRST clearing delta,
// so we prefer the smallest reduction that works. Larger cuts (−40/−50) cover
// overtakes where the rear jet is much faster (e.g. a −30 leaves it catching up).
const SPEED_DELTAS = [-10, -20, -30, -40, -50, 10, 20, 30, 40];
const HEADING_STEPS = [10, 15, 20, 25, 30, 35, 40];

function flightFrom(id: string, traj: TrajectoryResult, offset: number): PlanFlight {
  return {
    id,
    callsign: traj.meta.callsign,
    samples: toSamples(traj.points),
    offsetSec: offset,
    durationSec: totalSeconds(traj.points),
  };
}

/** Downstream route fixes roughly ahead of the aircraft (for direct-to). */
function fixesAhead(
  traj: TrajectoryResult,
  now: AircraftState,
  limit = 3,
): { ident: string; lat: number; lon: number }[] {
  const out: { ident: string; lat: number; lon: number }[] = [];
  for (const w of traj.route) {
    const dLon = (w.lon - now.lon) * Math.cos((now.lat * Math.PI) / 180);
    const dLat = w.lat - now.lat;
    const distNm = Math.hypot(dLat, dLon) * 60;
    if (distNm < 8) continue; // basically overhead
    const brg = ((Math.atan2(dLon, dLat) * 180) / Math.PI + 360) % 360;
    if (Math.abs(headingDeltaDeg(now.track, brg)) <= 90) {
      out.push({ ident: w.ident, lat: w.lat, lon: w.lon });
      if (out.length >= limit) break;
    }
  }
  return out;
}

const norm360 = (d: number) => ((d % 360) + 360) % 360;

/** Generate ranked, validated resolutions for a conflict. */
/** Max track difference (deg) for a conflict to count as an in-trail OVERTAKE. */
const OVERTAKE_MAX_TRACK_DIFF_DEG = 25;

export function generatePlanResolutions(args: PlanAdvisoryArgs): PlanResolution[] {
  const { conflict, flights, trajById, simT, cfg, restricted, holdings, topN = 5 } = args;
  const need = horizontalMinimumNm(cfg) + cfg.buffer.horizontalNm;
  const out: PlanResolution[] = [];

  // Overtake (in-trail catch-up): the two tracks are nearly parallel, so a turn
  // or direct-to only DELAYS the merge — the faster jet rejoins and re-closes.
  // SPEED is the effective fix (slow the rear / speed the lead). Detect it here
  // and, below, make that maneuver the cheapest so it ranks #1 with the top score.
  const stateOf = (id: string) => {
    const inf = trajById.get(id);
    return inf
      ? aircraftAt(toSamples(inf.traj.points), Math.max(0, simT - inf.offset))
      : null;
  };
  const acA = stateOf(conflict.a);
  const acB = stateOf(conflict.b);
  const isOvertake =
    !!acA &&
    !!acB &&
    Math.abs(headingDeltaDeg(acA.track, acB.track)) <= OVERTAKE_MAX_TRACK_DIFF_DEG;
  const fasterId = acA && acB && acA.gsKt < acB.gsKt ? conflict.b : conflict.a;
  const slowerId = fasterId === conflict.a ? conflict.b : conflict.a;

  for (const [targetId, intruderId] of [
    [conflict.a, conflict.b],
    [conflict.b, conflict.a],
  ] as const) {
    const info = trajById.get(targetId);
    const intrFlight = flights.find((f) => f.id === intruderId);
    if (!info || !intrFlight) continue;
    const { traj, offset } = info;
    const samples: Sample[] = toSamples(traj.points);
    const nowLocal = Math.max(0, simT - offset);
    const cpaLocal = conflict.tCpaAbsSec - offset;
    const nowTiming = recoveryTiming(conflict.tCpaAbsSec, offset, simT, "flightlevel");
    const stateNow = aircraftAt(samples, nowLocal);
    if (!stateNow || stateNow.altitudeFt == null) continue;

    const curGs = stateNow.gsKt;
    const curAlt = stateNow.altitudeFt;
    const curTrkNow = stateNow.track;
    const targetCallsign = traj.meta.callsign;
    const others = flights.filter((f) => f.id !== targetId);
    const origDur = totalSeconds(traj.points);

    // Kinematic turn-initiation timing for a lateral maneuver of `headingChange`
    // degrees: the turn starts early enough (turn duration + offset build-up +
    // buffer) that it clears the conflict — bigger/faster turns start earlier.
    const latTimingFor = (headingChangeDeg: number): ManeuverTiming =>
      recoveryTiming(conflict.tCpaAbsSec, offset, simT, "heading", {
        gsKt: curGs,
        headingChangeDeg,
        requiredOffsetNm: need,
        bankAngleDeg: cfg.bankAngleDeg,
        bufferSec: cfg.turnSafetyBufferSec,
      });

    /** Build + validate one candidate; returns a PlanResolution or null. */
    const evaluate = (
      type: ManeuverType,
      resolution: ManeuverResolution,
      value: number,
      trackDeviationDeg: number,
      altChangeFt: number,
      timing: ManeuverTiming,
      trackDeg: number,
    ): PlanResolution | null => {
      const modified = applyManeuver(traj, { type, resolution }, timing.tMan, {
        deviationSec: timing.deviationSec,
        rejoinSec: timing.rejoinSec,
        bankAngleDeg: cfg.bankAngleDeg,
      });
      const afterFlight = flightFrom(targetId, modified, offset);

      // 3-D clearance vs EVERY other flight (level changes clear vertically).
      let offenderCallsign: string | undefined;
      let tightestNm = Infinity;
      let clear = true;
      for (const o of others) {
        const c = pairConflict(afterFlight, o, cfg);
        if (c) {
          clear = false;
          if (c.dCpaNm < tightestNm) {
            tightestNm = c.dCpaNm;
            offenderCallsign = o.callsign;
          }
        }
      }
      if (!clear) return null;

      // Separation to the conflict partner (for the before→after readout).
      const sep = pairSeparation(afterFlight, intrFlight);
      const newDCpaNm = sep?.minHNm ?? conflict.dCpaNm;
      const newVertFt = sep?.vSepAtCpaFt ?? conflict.vSepAtCpaFt;

      // Constraint engine over the maneuver window (local time around the turn).
      const wLo = offset + Math.max(0, timing.tMan - 60);
      const wHi = offset + timing.tMan + timing.deviationSec + 300;
      const afterPath = pathWithAlt(toSamples(modified.points), offset, wLo, wHi);
      const beforePath = pathWithAlt(samples, offset, wLo, wHi);
      const report = evaluateConstraints({
        maneuverType: type,
        resolution,
        cfg,
        afterPath,
        originalAreaIdents: areaIdentsOnPath(beforePath, restricted),
        restricted,
        trackDeg,
        newGsKt: type === "speed" ? resolution.gsKt : undefined,
        newAltFt: type === "flightlevel" ? resolution.altFt : undefined,
        recheck: { clear: true, minSepNm: newDCpaNm, offenderCallsign },
      });
      if (report.verdict === "reject") return null;

      const newDur = totalSeconds(modified.points);
      const extraTimeSec = Math.max(0, newDur - origDur);
      const extraDistanceNm =
        type === "speed" ? 0 : (extraTimeSec / 3600) * curGs;
      const w = cfg.weights;
      const cost =
        w.trackDeviationPerDeg * Math.abs(trackDeviationDeg) +
        w.extraDistancePerNm * extraDistanceNm +
        w.altitudeChangePerThousandFt * (Math.abs(altChangeFt) / 1000) +
        w.typePenalty[type];

      return {
        type,
        target: targetId,
        targetCallsign,
        instruction: "",
        resolution,
        value,
        origDCpaNm: conflict.dCpaNm,
        newDCpaNm,
        origVertFt: conflict.vSepAtCpaFt,
        newVertFt,
        extraDistanceNm,
        extraTimeSec,
        altChangeFt,
        trackDeviationDeg,
        cost,
        score: 0,
        reason: "",
        constraintVerdict: report.verdict,
        tManLocal: timing.tMan,
        deviationSec: timing.deviationSec,
        rejoinSec: timing.rejoinSec,
      };
    };

    // --- Heading: smallest clearing turn each side, started kinematically ---
    for (const sign of [1, -1]) {
      for (const deg of HEADING_STEPS) {
        const timing = latTimingFor(deg);
        const stateAtMan = aircraftAt(samples, timing.tMan) ?? stateNow;
        const trackBase = stateAtMan.track;
        const r = evaluate(
          "heading",
          { headingDeg: norm360(trackBase + sign * deg) },
          sign * deg,
          deg,
          0,
          timing,
          trackBase,
        );
        if (r) {
          const side = sign > 0 ? "right" : "left";
          const lead = Math.round((cpaLocal - timing.tMan) / 60);
          r.instruction = `Turn ${side} ${deg}°`;
          r.reason = `Smallest ${side} turn that clears; a ${cfg.bankAngleDeg}° fly-by turn started ~${Math.max(0, lead)} min before CPA, then rejoins the route.`;
          out.push(r);
          break; // smallest per side is enough
        }
      }
    }

    // --- Flight level: ±1000 / ±2000, semicircular + reachable ---
    for (const delta of FL_DELTAS) {
      const targetAlt = Math.round((curAlt + delta) / 1000) * 1000;
      if (targetAlt < 10000 || targetAlt > 43000) continue;
      if (!respectsSemicircular(targetAlt, curTrkNow)) continue;
      const timeNeeded = Math.abs(targetAlt - curAlt) / (cfg.climbDescentFpm.min / 60);
      if (timeNeeded > Math.max(0, cpaLocal - nowLocal) + 60) continue;
      const r = evaluate("flightlevel", { altFt: targetAlt }, targetAlt - curAlt, 0, targetAlt - curAlt, nowTiming, curTrkNow);
      if (r) {
        const climb = targetAlt > curAlt;
        r.instruction = `${climb ? "Climb" : "Descend"} FL${targetAlt / 100}`;
        r.reason = `Keeps your route; ${climb ? "climb" : "descend"} for vertical separation.`;
        out.push(r);
      }
    }

    // --- Speed: keep the best-clearing reduce and increase ---
    for (const delta of SPEED_DELTAS) {
      const newGs = curGs + delta;
      if (newGs < 150 || newGs > 560) continue;
      const r = evaluate("speed", { gsKt: newGs }, delta, 0, 0, nowTiming, curTrkNow);
      if (r) {
        r.instruction = `${delta < 0 ? "Reduce" : "Increase"} ${Math.abs(delta)} kt`;
        r.reason = `Re-times the crossing; no track or level change.`;
        out.push(r);
      }
    }

    // --- Direct-to a downstream fix (turn started kinematically) ---
    const bearingTo = (fromLat: number, fromLon: number, toLat: number, toLon: number) => {
      const dLon = (toLon - fromLon) * Math.cos((fromLat * Math.PI) / 180);
      const dLat = toLat - fromLat;
      return ((Math.atan2(dLon, dLat) * 180) / Math.PI + 360) % 360;
    };
    for (const fix of fixesAhead(traj, stateNow)) {
      // Estimate the turn size from the current position, size the timing, then
      // recompute the bearing from the (future) maneuver point.
      const dPsi0 = Math.abs(
        headingDeltaDeg(curTrkNow, bearingTo(stateNow.lat, stateNow.lon, fix.lat, fix.lon)),
      );
      const timing = latTimingFor(dPsi0);
      const stateAtMan = aircraftAt(samples, timing.tMan) ?? stateNow;
      const brg = bearingTo(stateAtMan.lat, stateAtMan.lon, fix.lat, fix.lon);
      const trackDev = Math.abs(headingDeltaDeg(stateAtMan.track, brg));
      const r = evaluate(
        "route",
        { headingDeg: brg, directTo: fix },
        0,
        trackDev,
        0,
        timing,
        stateAtMan.track,
      );
      if (r) {
        r.instruction = `Direct ${fix.ident}`;
        r.reason = `Proceed direct ${fix.ident}${r.extraDistanceNm < 1 ? " — shortens the route" : ""} and clears the conflict.`;
        out.push(r);
      }
    }

    // --- Hold at a published holding fix on the route AHEAD (delay the flight
    //     to open spacing — the realistic fix for an arrival-merge conflict) ---
    if (holdings && holdings.size) {
      const t0Ms = new Date(traj.points[0].epoch_ts).getTime();
      const localAtFix = (fixLat: number, fixLon: number): number => {
        let bestT = 0;
        let bestD = Infinity;
        for (const p of traj.points) {
          const d = (p.lat - fixLat) ** 2 + (p.lon - fixLon) ** 2;
          if (d < bestD) {
            bestD = d;
            bestT = (new Date(p.epoch_ts).getTime() - t0Ms) / 1000;
          }
        }
        return bestT;
      };
      const heldIdents = new Set<string>();
      for (const w of traj.route) {
        const h = holdings.get(w.ident);
        if (!h || heldIdents.has(w.ident)) continue;
        const tManHold = localAtFix(w.lat, w.lon);
        // Only a fix that is still ahead AND before the CPA can open spacing.
        if (tManHold <= nowLocal + 30 || tManHold >= cpaLocal) continue;
        const st = aircraftAt(samples, tManHold);
        if (!st) continue;
        heldIdents.add(w.ident);
        const gsAtFix = st.gsKt || curGs;
        const hold = {
          ident: h.ident,
          lat: h.lat,
          lon: h.lon,
          inboundCourseDeg: h.inboundCourseDeg,
          turn: h.turn,
          legSec: holdLegSec(h, gsAtFix),
          gsKt: h.speedKt ?? gsAtFix,
        };
        const r = evaluate(
          "hold",
          { hold },
          0,
          0,
          0,
          { tMan: tManHold, deviationSec: 0, rejoinSec: 0 },
          st.track,
        );
        if (r) {
          const loopMin = Math.round(holdLoopSec(h, gsAtFix) / 60);
          r.instruction = `Hold at ${h.ident}`;
          r.reason = `Fly one ${loopMin}-min ${h.turn === "R" ? "right" : "left"}-hand hold at ${h.ident} to delay ~${loopMin} min and open spacing (for an arrival merge a vector/level can't clear).`;
          out.push(r);
        }
      }
    }
  }

  // For an overtake, discount the effective speed maneuver so it becomes the
  // cheapest → ranks #1 and scores highest. (A turn merely delays the merge.)
  // Slowing the rear/faster jet is preferred over speeding the lead.
  if (isOvertake) {
    for (const r of out) {
      if (r.type !== "speed") continue;
      if (r.target === fasterId && r.value < 0) {
        r.cost = Math.max(0.1, r.cost - 1000);
        r.reason = `In-trail overtake — slowing the rear (faster) aircraft opens the gap and re-sequences the pair (a turn only delays the merge).`;
      } else if (r.target === slowerId && r.value > 0) {
        r.cost = Math.max(0.2, r.cost - 500);
        r.reason = `In-trail overtake — speeding the lead opens the gap (a turn only delays the merge).`;
      }
    }
  }

  // Rank by cost, keep the best per (target,type) so the list stays diverse.
  out.sort((a, b) => a.cost - b.cost);
  const seen = new Set<string>();
  const ranked: PlanResolution[] = [];
  for (const r of out) {
    const key = `${r.target}:${r.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ranked.push(r);
    if (ranked.length >= topN) break;
  }
  // Relative 0–100 score anchored to the cheapest.
  const minCost = ranked.length ? ranked[0].cost : 0;
  for (const r of ranked) {
    r.score = Math.max(1, Math.min(100, Math.round((100 * (minCost + 1)) / (r.cost + 1))));
  }
  return ranked;
}

/** Sample a flight's path with altitude over an absolute-time window. */
function pathWithAlt(
  samples: Sample[],
  offset: number,
  t0: number,
  t1: number,
  step = 15,
): PathPoint[] {
  const out: PathPoint[] = [];
  for (let t = t0; t <= t1; t += step) {
    const ac = aircraftAt(samples, t - offset);
    if (ac && ac.altitudeFt != null) {
      out.push({ lat: ac.lat, lon: ac.lon, altFt: ac.altitudeFt });
    }
  }
  return out;
}
