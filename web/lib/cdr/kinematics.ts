/**
 * Client-side trajectory override — turns a resolution Maneuver into a modified
 * trajectory, used by both Preview (draw dashed, don't commit) and Apply (write
 * it back so the engine detects the resolution on the next tick).
 *
 * The app has no live physics integrator: aircraft ride precomputed `points[]`.
 * So "applying" a maneuver means rebuilding the downstream half of that table
 * from the maneuver point onward, consistent with what the what-if simulator
 * validated. Three faithful branches:
 *
 *   - Flight level : keep the original ground track and timing; re-profile the
 *     altitude, ramping at the configured rate to the new level then holding.
 *     Route and destination are preserved.
 *   - Speed        : keep the original ground track and altitude-by-position;
 *     re-time the downstream points for the new ground speed. Route preserved.
 *   - Heading / Direct-to : fly the new ground track as a straight leg at the
 *     current speed and altitude for the remainder of the flight. (A lateral
 *     maneuver necessarily departs the filed route; this matches the constant-
 *     velocity assumption the resolution was checked under.)
 *
 * Pure and deterministic (kinematics.test.ts): (trajectory, maneuver, maneuver
 * time) → new trajectory.
 */

import { horizontalMinimumNm, type CdrConfig, type ManeuverType } from "./config";
import { headingDeltaDeg } from "./geo";
import type { ManeuverResolution } from "./types";
import type { TrajectoryPoint, TrajectoryResult } from "@/lib/trajectory/types";
import { aircraftAt, toSamples, type AircraftState } from "@/lib/useSimPlayback";

interface Sample extends AircraftState {
  t: number;
}

import { makeFrame, toEnu, toLatLon, velocityFromGsTrack } from "./geo";
import type { Maneuver } from "./types";

/** Great-circle distance (NM) between two lat/lon points (haversine). */
function distNm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 3440.065;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const la1 = (aLat * Math.PI) / 180;
  const la2 = (bLat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Compass bearing (° from north) from A to B. */
function bearingDeg(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const p1 = (aLat * Math.PI) / 180;
  const p2 = (bLat * Math.PI) / 180;
  const dl = ((bLon - aLon) * Math.PI) / 180;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** When a maneuver is flown and how long it deviates, sized to the conflict.
 *  Realism fix: a LATERAL maneuver (heading/direct) for a conflict far ahead must
 *  NOT turn now and hold for the whole time-to-CPA — that flings the aircraft
 *  hundreds of miles off route. Instead it flies the filed route until a short
 *  lead before CPA, deviates just long enough to open the gap, then rejoins.
 *  LEVEL / SPEED changes keep the route, so they're applied immediately. */
export const RECOVERY = { postSec: 120, rejoinSec: 180 };

/** Hard ceiling (s) on any deviation/hold SPAN that drives a per-step trajectory
 *  loop. A separation maneuver never realistically holds a deviation for more
 *  than ~30 min, and this is a SAFETY BOUND: it guarantees the fixed-`step`
 *  `while (elapsed < span)` loops in `recoveredLeg`/`reprofileAltitude` are
 *  finite even if a caller passes a corrupt (Infinity/NaN/huge) CPA time — a
 *  runaway there froze the tab synchronously. Also floors at a sane minimum. */
export const MAX_SPAN_SEC = 1800;
function clampSpanSec(sec: number): number {
  if (!Number.isFinite(sec)) return MAX_SPAN_SEC;
  return Math.min(MAX_SPAN_SEC, Math.max(120, sec));
}

const G_MS2 = 9.80665;
const KT_TO_MS = 0.514444;
const M_PER_NM = 1852;

export interface TurnGeometry {
  /** Turn radius (NM) = V²/(g·tanφ). */
  radiusNm: number;
  /** Turn rate (°/s) = g·tanφ/V. */
  turnRateDegSec: number;
  /** Time (s) to complete the heading change at that rate. */
  turnDurationSec: number;
}

/** Coordinated-turn geometry from ground speed, heading change and bank angle.
 *  Radius ∝ V², so a faster aircraft turns wider and its turn takes longer —
 *  which is what makes it start its avoidance turn earlier. */
export function turnGeometry(
  gsKt: number,
  headingChangeDeg: number,
  bankAngleDeg: number,
): TurnGeometry {
  const vMs = Math.max(1, gsKt * KT_TO_MS);
  const tanB = Math.tan((bankAngleDeg * Math.PI) / 180);
  const turnRateDegSec = ((G_MS2 * tanB) / vMs) * (180 / Math.PI);
  const radiusNm = (vMs * vMs) / (G_MS2 * tanB) / M_PER_NM;
  const turnDurationSec = Math.abs(headingChangeDeg) / Math.max(turnRateDegSec, 0.05);
  return { radiusNm, turnRateDegSec, turnDurationSec };
}

/**
 * Lead time (s) before CPA to START a fly-by turn so it clears the conflict —
 * purely kinematic, no fixed "X NM before". It sums:
 *   - the turn EXECUTION time (∝ speed via radius/rate),
 *   - the time to open the remaining lateral OFFSET on the new heading (the turn
 *     arc itself already contributes R·(1−cosΨ)), and
 *   - a configurable safety buffer.
 * So the aircraft has (nearly) completed the heading change and built the
 * separation offset before reaching the conflict area.
 */
export function turnInitiationLeadSec(
  gsKt: number,
  headingChangeDeg: number,
  requiredOffsetNm: number,
  bankAngleDeg: number,
  bufferSec: number,
): number {
  const geo = turnGeometry(gsKt, headingChangeDeg, bankAngleDeg);
  const psi = (Math.abs(headingChangeDeg) * Math.PI) / 180;
  const vNmSec = gsKt / 3600;
  const arcOffsetNm = geo.radiusNm * (1 - Math.cos(psi)); // built during the arc
  const remainNm = Math.max(0, requiredOffsetNm - arcOffsetNm);
  const sinPsi = Math.max(0.09, Math.sin(psi)); // floor ~5° so tiny turns aren't absurdly early
  const offsetTimeSec = vNmSec > 0 ? remainNm / (vNmSec * sinPsi) : 0;
  return geo.turnDurationSec + offsetTimeSec + bufferSec;
}

export interface ManeuverTiming {
  tMan: number; // local time (s since departure) to start the maneuver
  deviationSec: number;
  rejoinSec: number;
}

/** Kinematic turn-initiation options for a lateral maneuver. */
export interface RecoveryOpts {
  gsKt: number;
  headingChangeDeg: number;
  requiredOffsetNm: number;
  bankAngleDeg: number;
  bufferSec: number;
}

export function recoveryTiming(
  tCpaAbsSec: number,
  offsetSec: number,
  simT: number,
  type: ManeuverType,
  opts?: RecoveryOpts,
): ManeuverTiming {
  const nowLocal = Math.max(0, simT - offsetSec);
  // Level / speed keep the route → apply now, no lateral deviation. For a level
  // change, `deviationSec` is the HOLD duration: keep the new level from now
  // until the CPA is safely behind (+ post-CPA buffer), then it ramps back.
  if (type !== "heading" && type !== "route") {
    const cpaLocal = tCpaAbsSec - offsetSec;
    const holdSec = clampSpanSec(cpaLocal - nowLocal + RECOVERY.postSec);
    return { tMan: nowLocal, deviationSec: holdSec, rejoinSec: RECOVERY.rejoinSec };
  }
  const cpaLocal = tCpaAbsSec - offsetSec;
  const leadSec = opts
    ? turnInitiationLeadSec(
        opts.gsKt,
        opts.headingChangeDeg,
        opts.requiredOffsetNm,
        opts.bankAngleDeg,
        opts.bufferSec,
      )
    : 240; // fallback when kinematics aren't supplied
  const tMan = Math.max(nowLocal, cpaLocal - leadSec);
  const deviationSec = clampSpanSec(cpaLocal - tMan + RECOVERY.postSec);
  return { tMan, deviationSec, rejoinSec: RECOVERY.rejoinSec };
}

/** Convenience: kinematic timing for a concrete maneuver, given the target's
 *  current ground speed + track. */
export function maneuverTiming(
  gsKt: number,
  trackDeg: number,
  tCpaAbsSec: number,
  offsetSec: number,
  simT: number,
  maneuver: { type: ManeuverType; resolution: ManeuverResolution },
  cfg: CdrConfig,
): ManeuverTiming {
  const lateral = maneuver.type === "heading" || maneuver.type === "route";
  const headingChangeDeg =
    lateral && maneuver.resolution.headingDeg != null
      ? headingDeltaDeg(trackDeg, maneuver.resolution.headingDeg)
      : 0;
  return recoveryTiming(
    tCpaAbsSec,
    offsetSec,
    simT,
    maneuver.type,
    lateral
      ? {
          gsKt,
          headingChangeDeg,
          requiredOffsetNm: horizontalMinimumNm(cfg) + cfg.buffer.horizontalNm,
          bankAngleDeg: cfg.bankAngleDeg,
          bufferSec: cfg.turnSafetyBufferSec,
        }
      : undefined,
  );
}

/** Options for applyManeuver. `recover` (default true) makes a lateral maneuver
 *  dog-leg back to the filed route: hold the deviation for `deviationSec`, then
 *  fly direct to rejoin the original path `rejoinSec` later, then resume it —
 *  so the aircraft returns to its flight plan instead of diverging forever. */
export interface ApplyOptions {
  climbFpm?: number;
  recover?: boolean;
  deviationSec?: number;
  rejoinSec?: number;
  /** Bank angle (°) for the fly-by turn arc; sets the turn radius/rate. */
  bankAngleDeg?: number;
}

/**
 * Rebuild a trajectory with `maneuver` applied at local time `tManeuverSec`
 * (seconds since this flight's own departure). Returns a NEW TrajectoryResult;
 * the input is not mutated.
 */
export function applyManeuver(
  traj: TrajectoryResult,
  maneuver: Pick<Maneuver, "type" | "resolution">,
  tManeuverSec: number,
  opts: ApplyOptions = {},
): TrajectoryResult {
  const climbFpm = opts.climbFpm ?? 1200;
  const recover = opts.recover ?? true;
  // Clamp the span that drives the per-step deviation/hold loops so a corrupt
  // (Infinity/huge) timing value can never spin them into a tab-freezing loop.
  const deviationSec = clampSpanSec(opts.deviationSec ?? 180);
  const rejoinSec = opts.rejoinSec ?? 180;
  const bankAngleDeg = opts.bankAngleDeg ?? 25;
  const pts = traj.points;
  if (pts.length < 2) return traj;
  const epoch0 = new Date(pts[0].epoch_ts).getTime();
  const samples = toSamples(pts);
  const duration = samples[samples.length - 1].t;
  const tMan = Math.max(0, Math.min(duration, tManeuverSec));

  // Split: keep everything strictly before the maneuver, plus an exact point
  // at the maneuver time (interpolated) as the pivot.
  const head: TrajectoryPoint[] = pts.filter(
    (p) => (new Date(p.epoch_ts).getTime() - epoch0) / 1000 < tMan,
  );
  const pivotState = aircraftAt(samples, tMan);
  if (!pivotState) return traj;
  const pivot: TrajectoryPoint = {
    lat: pivotState.lat,
    lon: pivotState.lon,
    epoch_ts: iso(epoch0 + tMan * 1000),
    altitude_ft: pivotState.altitudeFt,
    gs_kt: pivotState.gsKt,
    tas_kt: pivotState.tasKt,
    track_deg: pivotState.track,
    phase: pivotState.phase,
  };

  const tail = pts.filter(
    (p) => (new Date(p.epoch_ts).getTime() - epoch0) / 1000 >= tMan,
  );

  let newTail: TrajectoryPoint[];
  switch (maneuver.type) {
    case "flightlevel":
      // deviationSec carries the hold duration (past CPA + buffer) for the
      // temporary level change; the aircraft ramps back to its cleared level.
      newTail = reprofileAltitude(
        pivot,
        tail,
        maneuver.resolution.altFt!,
        climbFpm,
        deviationSec,
      );
      break;
    case "speed":
      newTail = retimeForSpeed(pivot, tail, maneuver.resolution.gsKt!);
      break;
    case "hold": {
      // Fly ONE racetrack loop at the fix (crossed at the pivot), then resume
      // the filed route — every subsequent point is DELAYED by the loop time.
      const loop = holdLoop(pivot, maneuver.resolution.hold!, epoch0 + tMan * 1000);
      const loopMs = loop.length
        ? new Date(loop[loop.length - 1].epoch_ts).getTime() - (epoch0 + tMan * 1000)
        : 0;
      const shifted = tail.map((p) => ({
        ...p,
        epoch_ts: iso(new Date(p.epoch_ts).getTime() + loopMs),
      }));
      newTail = [...loop, ...shifted];
      break;
    }
    default: {
      // heading + route → deviate, then (by default) recover back onto the
      // filed route so the aircraft doesn't diverge forever.
      const heading = maneuver.resolution.headingDeg ?? pivot.track_deg;
      newTail = recover
        ? recoveredLeg(
            pivot,
            heading,
            samples,
            tail,
            tMan,
            epoch0,
            duration,
            deviationSec,
            rejoinSec,
            bankAngleDeg,
          )
        : straightLeg(pivot, heading, duration - tMan, epoch0 + tMan * 1000);
    }
  }

  const points = [...head, pivot, ...newTail];
  const { stats, toc, tod } = recomputeStats(traj, points);
  // Keep the flight-time check in step with the re-timed trajectory: a speed
  // change (or a longer dog-leg) alters the simulated flight time, so the
  // FLIGHT-TIME CHECK's "Sim" / Δ / PASS-FAIL must reflect the new duration —
  // otherwise it keeps showing the pre-fix minutes while FLIGHT TIME updates.
  const validation = traj.validation
    ? (() => {
        const simulatedMin = stats.timeMinutes;
        const deltaMin = Math.round((simulatedMin - traj.validation!.cat62Min) * 10) / 10;
        const passed = Math.abs(deltaMin) <= traj.validation!.thresholdMin;
        return {
          ...traj.validation!,
          simulatedMin,
          deltaMin,
          status: (passed ? "PASS" : "FAIL") as "PASS" | "FAIL",
          passed,
        };
      })()
    : null;
  return { ...traj, points, stats, profile: { ...traj.profile, toc, tod }, validation };
}

/** Recompute the summary stats + TOC/TOD from a modified point list, so the
 *  Route Profile numbers, the "Cruise FLxxx" label and the altitude-chart
 *  markers all reflect the applied fix (a level change, a longer dog-leg, a
 *  re-timed speed) instead of the original flight's figures. */
function recomputeStats(
  traj: TrajectoryResult,
  points: TrajectoryPoint[],
): {
  stats: TrajectoryResult["stats"];
  toc: TrajectoryResult["profile"]["toc"];
  tod: TrajectoryResult["profile"]["tod"];
} {
  let distanceNm = 0;
  for (let i = 1; i < points.length; i++) {
    distanceNm += distNm(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
  }
  const t0 = new Date(points[0].epoch_ts).getTime();
  const tN = new Date(points[points.length - 1].epoch_ts).getTime();
  // Keep the FILED cruise level. A level-change resolution is a TEMPORARY step
  // (climb → hold → return), so its transient peak must not relabel the cruise
  // as FLxxx; lateral/speed maneuvers don't touch altitude at all.
  const cruiseAltFt = traj.stats.cruiseAltFt;
  const stats: TrajectoryResult["stats"] = {
    ...traj.stats,
    pointCount: points.length,
    distanceNm: Math.round(distanceNm * 10) / 10,
    timeMinutes: Math.round(((tN - t0) / 60000) * 10) / 10,
    cruiseAltFt,
  };

  // TOC = first sample at (near) the cruise level; TOD = last such sample.
  const thr = (stats.cruiseAltFt ?? 0) - 100;
  const pp = (i: number) =>
    i >= 0
      ? {
          lat: points[i].lat,
          lon: points[i].lon,
          altitudeFt: points[i].altitude_ft ?? 0,
          epochTs: points[i].epoch_ts,
        }
      : null;
  let tocIdx = -1;
  let todIdx = -1;
  for (let i = 0; i < points.length; i++) {
    if ((points[i].altitude_ft ?? -Infinity) >= thr) {
      tocIdx = i;
      break;
    }
  }
  for (let i = points.length - 1; i >= 0; i--) {
    if ((points[i].altitude_ft ?? -Infinity) >= thr) {
      todIdx = i;
      break;
    }
  }
  return {
    stats,
    toc: tocIdx >= 0 ? pp(tocIdx) : traj.profile.toc,
    tod: todIdx >= 0 && todIdx !== tocIdx ? pp(todIdx) : traj.profile.tod,
  };
}

/**
 * Trace ONE published holding-pattern loop from `fix` (the aircraft crossing the
 * fix), using the AIP hold parameters. Racetrack = outbound turn → outbound leg
 * → inbound turn → inbound leg back to the fix. 180° turns at standard rate
 * (3°/s = 60 s) plus the coded leg time, so a 1-minute leg → ~4-minute loop.
 * Returns samples timed from `startMs`; the last point snaps to the fix so the
 * route resumes cleanly.
 */
function holdLoop(
  fix: TrajectoryPoint,
  hold: NonNullable<ManeuverResolution["hold"]>,
  startMs: number,
): TrajectoryPoint[] {
  const gs = hold.gsKt > 50 ? hold.gsKt : 230;
  const legSec = Math.max(30, hold.legSec);
  const TURN_RATE = 3; // deg/s (standard rate)
  const turnSec = 180 / TURN_RATE; // 60 s per 180° turn
  const sign = hold.turn === "R" ? 1 : -1; // compass-right = clockwise = +
  const STEP = 6; // s per sample
  const nmPerSec = gs / 3600;
  const phases = [
    { dur: turnSec, turning: true }, // turn onto the outbound leg
    { dur: legSec, turning: false }, // outbound leg
    { dur: turnSec, turning: true }, // turn back onto the inbound leg
    { dur: legSec, turning: false }, // inbound leg → back to the fix
  ];
  let hdg = hold.inboundCourseDeg; // heading as it crosses the fix inbound
  let lat = fix.lat;
  let lon = fix.lon;
  let t = 0;
  const out: TrajectoryPoint[] = [];
  for (const ph of phases) {
    let elapsed = 0;
    while (elapsed < ph.dur - 1e-6) {
      const dt = Math.min(STEP, ph.dur - elapsed);
      if (ph.turning) hdg = (hdg + sign * TURN_RATE * dt + 360) % 360;
      const dNm = nmPerSec * dt;
      const rad = (hdg * Math.PI) / 180;
      lat += (dNm * Math.cos(rad)) / 60;
      lon += (dNm * Math.sin(rad)) / (60 * Math.cos((lat * Math.PI) / 180));
      t += dt;
      elapsed += dt;
      out.push({
        lat,
        lon,
        epoch_ts: iso(startMs + t * 1000),
        altitude_ft: fix.altitude_ft,
        gs_kt: gs,
        tas_kt: fix.tas_kt,
        track_deg: hdg,
        phase: fix.phase,
      });
    }
  }
  if (out.length) {
    out[out.length - 1] = { ...out[out.length - 1], lat: fix.lat, lon: fix.lon };
  }
  return out;
}

/**
 * Flight-level branch — a TEMPORARY level change for separation, not a permanent
 * cruise change. Keep track + timing and re-profile the altitude as a step:
 *   climb/descend to the new level → HOLD it for `holdSec` (long enough to carry
 *   past the CPA plus a safety buffer) → ramp BACK to the original level →
 *   resume the filed vertical profile.
 * So the aircraft returns to its cleared level once separation is safe, instead
 * of cruising at the temporary level forever.
 */
function reprofileAltitude(
  pivot: TrajectoryPoint,
  tail: TrajectoryPoint[],
  targetAlt: number,
  climbFpm: number,
  holdSec: number,
): TrajectoryPoint[] {
  const startAlt = pivot.altitude_ft ?? targetAlt;
  const dir = Math.sign(targetAlt - startAlt);
  if (dir === 0) return tail.map((p) => ({ ...p }));
  const t0 = new Date(pivot.epoch_ts).getTime();
  const rampMin = Math.abs(targetAlt - startAlt) / climbFpm; // min to reach the level
  // Hold until the conflict is safely behind (holdSec is measured from the
  // maneuver start and already includes the post-CPA buffer), then ramp back.
  const returnStartMin = Math.max(rampMin, holdSec / 60);
  const returnEndMin = returnStartMin + rampMin;
  return tail.map((p) => {
    const dtMin = (new Date(p.epoch_ts).getTime() - t0) / 60000;
    const origAlt = p.altitude_ft ?? startAlt;
    let alt: number;
    if (dtMin <= rampMin) {
      alt = startAlt + dir * climbFpm * dtMin; // ramp to the new level
    } else if (dtMin <= returnStartMin) {
      alt = targetAlt; // hold through the conflict + buffer
    } else if (dtMin <= returnEndMin) {
      alt = targetAlt - dir * climbFpm * (dtMin - returnStartMin); // ramp back
    } else {
      return { ...p, altitude_ft: origAlt }; // returned → resume the filed profile
    }
    // Stay on the maneuvered side of the filed profile (never dip below cruise
    // while stepped up, or above it while stepped down).
    return { ...p, altitude_ft: dir > 0 ? Math.max(alt, origAlt) : Math.min(alt, origAlt) };
  });
}

/** Speed branch: keep the geographic path + altitude, re-time by applying the
 *  speed DELTA to each segment's ORIGINAL speed — so the descent/approach speed
 *  profile is preserved (shifted by the delta), not flattened to one cruise
 *  speed. A zero delta therefore reproduces the original timing (a true no-op)
 *  rather than accidentally re-timing the descent. */
function retimeForSpeed(
  pivot: TrajectoryPoint,
  tail: TrajectoryPoint[],
  newGs: number,
): TrajectoryPoint[] {
  const delta = newGs - (pivot.gs_kt || newGs);
  const out: TrajectoryPoint[] = [];
  let prev = pivot;
  let clockMs = new Date(pivot.epoch_ts).getTime();
  for (const p of tail) {
    const legNm = distNm(prev.lat, prev.lon, p.lat, p.lon);
    const segGs = Math.max(120, (p.gs_kt ?? pivot.gs_kt ?? newGs) + delta);
    const dtSec = (legNm / segGs) * 3600;
    clockMs += dtSec * 1000;
    out.push({ ...p, gs_kt: segGs, epoch_ts: iso(clockMs) });
    prev = p;
  }
  return out;
}

/** Heading / direct-to branch: a straight leg on `headingDeg` at the pivot's
 *  speed and altitude, sampled at the original ~4 s cadence for `legSec`. */
function straightLeg(
  pivot: TrajectoryPoint,
  headingDeg: number,
  legSec: number,
  startMs: number,
  stepSec = 4,
): TrajectoryPoint[] {
  const frame = makeFrame(pivot.lat, pivot.lon);
  const p0 = toEnu(frame, pivot.lat, pivot.lon);
  const v = velocityFromGsTrack(pivot.gs_kt, headingDeg); // NM/s
  const out: TrajectoryPoint[] = [];
  for (let t = stepSec; t <= legSec + 1e-6; t += stepSec) {
    const { lat, lon } = toLatLon(frame, {
      x: p0.x + v.x * t,
      y: p0.y + v.y * t,
    });
    out.push({
      lat,
      lon,
      epoch_ts: iso(startMs + t * 1000),
      altitude_ft: pivot.altitude_ft,
      gs_kt: pivot.gs_kt,
      tas_kt: pivot.tas_kt,
      track_deg: headingDeg,
      phase: pivot.phase,
    });
  }
  return out;
}

/** Move `dNm` nautical miles from (lat,lon) along a compass heading. */
function advance(lat: number, lon: number, headingDeg: number, dNm: number): { lat: number; lon: number } {
  const frame = makeFrame(lat, lon);
  const r = (headingDeg * Math.PI) / 180;
  return toLatLon(frame, { x: dNm * Math.sin(r), y: dNm * Math.cos(r) });
}

/**
 * Heading / direct-to branch WITH a SMOOTH fly-by turn + route recovery:
 *   1. a coordinated turn ARC (integrated at the bank-angle turn rate) from the
 *      current heading to the target heading — not an instantaneous change,
 *   2. a short straight deviation on the new heading (through the conflict),
 *   3. a direct leg back to rejoin the filed route, then
 *   4. resume the original route.
 * Re-timed by cumulative distance at the pivot's ground speed so the clock stays
 * monotonic. This is the true curved path the preview draws.
 */
function recoveredLeg(
  pivot: TrajectoryPoint,
  headingDeg: number,
  samples: Sample[],
  tail: TrajectoryPoint[],
  tMan: number,
  epoch0: number,
  duration: number,
  deviationSec: number,
  rejoinSec: number,
  bankAngleDeg: number,
  step = 4,
): TrajectoryPoint[] {
  const gs = pivot.gs_kt || 450;
  const pivotAlt = pivot.altitude_ft ?? 0;
  const dPsi = headingDeltaDeg(pivot.track_deg, headingDeg); // signed
  const turnSign = Math.sign(dPsi) || 1;
  const omega = turnGeometry(gs, dPsi, bankAngleDeg).turnRateDegSec; // °/s

  const geo: { lat: number; lon: number; alt: number | null }[] = [];
  let curLat = pivot.lat;
  let curLon = pivot.lon;
  let curHdg = pivot.track_deg;
  let elapsed = 0;
  let remaining = Math.abs(dPsi);

  // 1) Smooth turn arc — integrate heading + position.
  while (remaining > 0.05 && elapsed < deviationSec) {
    const dStep = Math.min(omega * step, remaining);
    const midHdg = curHdg + (turnSign * dStep) / 2; // mid-step for arc accuracy
    const p = advance(curLat, curLon, midHdg, (gs * step) / 3600);
    curLat = p.lat;
    curLon = p.lon;
    curHdg = (((curHdg + turnSign * dStep) % 360) + 360) % 360;
    remaining -= dStep;
    elapsed += step;
    geo.push({ lat: curLat, lon: curLon, alt: pivotAlt });
  }

  // 2) Straight deviation on the achieved heading, through the conflict.
  while (elapsed < deviationSec) {
    const p = advance(curLat, curLon, headingDeg, (gs * step) / 3600);
    curLat = p.lat;
    curLon = p.lon;
    elapsed += step;
    geo.push({ lat: curLat, lon: curLon, alt: pivotAlt });
  }

  // 3) Direct back to the original route (its position `rejoinSec` on).
  const rejoinLocal = Math.min(duration, tMan + deviationSec + Math.max(step, rejoinSec));
  const rej = aircraftAt(samples, rejoinLocal);
  if (rej) {
    const distToRej = distNm(curLat, curLon, rej.lat, rej.lon);
    const brg = bearingDeg(curLat, curLon, rej.lat, rej.lon);
    const n = Math.max(1, Math.round(((distToRej / gs) * 3600) / step));
    const rejAlt = rej.altitudeFt ?? pivotAlt;
    for (let i = 1; i <= n; i++) {
      const p = advance(curLat, curLon, brg, distToRej / n);
      curLat = p.lat;
      curLon = p.lon;
      geo.push({ lat: curLat, lon: curLon, alt: pivotAlt + (rejAlt - pivotAlt) * (i / n) });
    }
  }

  // 4) Resume the original route beyond the rejoin.
  for (const p of tail) {
    const lt = (new Date(p.epoch_ts).getTime() - epoch0) / 1000;
    if (lt > rejoinLocal) geo.push({ lat: p.lat, lon: p.lon, alt: p.altitude_ft });
  }

  // Re-time by cumulative distance at the pivot speed; track from the geometry.
  const out: TrajectoryPoint[] = [];
  let prev = { lat: pivot.lat, lon: pivot.lon };
  let clockMs = epoch0 + tMan * 1000;
  for (const g of geo) {
    const d = distNm(prev.lat, prev.lon, g.lat, g.lon);
    clockMs += (d / gs) * 3600 * 1000;
    out.push({
      lat: g.lat,
      lon: g.lon,
      epoch_ts: iso(clockMs),
      altitude_ft: g.alt,
      gs_kt: gs,
      tas_kt: pivot.tas_kt,
      track_deg: bearingDeg(prev.lat, prev.lon, g.lat, g.lon),
      phase: pivot.phase,
    });
    prev = g;
  }
  return out;
}
