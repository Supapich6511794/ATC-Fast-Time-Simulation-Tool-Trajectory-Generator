/**
 * Strategic flight-plan conflict scan.
 *
 * The live detector (useCdr) only looks a short window ahead of the current
 * clock — that drives the realtime toast/badge. The Dashboard, by contrast,
 * wants the WHOLE picture: every loss of separation the filed plans will
 * produce, including ones far in the future that haven't alerted yet ("THA100 &
 * TGW122 will lose separation at 00:24"). Because the trajectories are fully
 * precomputed, we can simply march each pair along its real path across the
 * entire shared timeline once and record where they breach minima.
 *
 * Runs once per trajectory set (memoised in MapApp), not per tick — so it can
 * afford to scan hours of flight time at a modest step. Absolute times are on
 * the same shared "all routes" clock the map uses (seconds from the earliest
 * departure); the Dashboard subtracts the live clock to show a countdown.
 */

import { aircraftAt, type AircraftState } from "@/lib/useSimPlayback";

import {
  sepMinNmForPair,
  verticalMinimumFt,
  type CdrConfig,
} from "./config";
import { frameFor, mag, sub, toEnu } from "./geo";

interface Sample extends AircraftState {
  t: number;
}

/** Absolute ceiling on scan iterations per pair — a safety stop so a pathological
 *  overlap (huge/near-infinite duration from a corrupt maneuvered trajectory) can
 *  never spin the main thread and freeze the tab. 500k @ 15 s ≈ 2000 flight-hours,
 *  far beyond any real encounter, so it never bites legitimate scans. */
const MAX_SCAN_STEPS = 500_000;

/** One flight for the scan: its elapsed-time sample table, EOBT offset and
 *  duration on the shared absolute timeline. */
export interface PlanFlight {
  id: string;
  callsign: string;
  samples: Sample[];
  offsetSec: number;
  durationSec: number;
}

/** A conflict found anywhere in the filed plans. */
export interface PlanConflict {
  id: string;
  a: string;
  b: string;
  aCallsign: string;
  bCallsign: string;
  /** Absolute time (s, shared clock) the pair first breaches HARD minima, or
   *  null when it only ever breaches the advisory buffer. */
  losStartAbsSec: number | null;
  /** Absolute time of closest approach and the separations there. */
  tCpaAbsSec: number;
  dCpaNm: number;
  vSepAtCpaFt: number;
  shNm: number;
  svFt: number;
  /** True when hard minima are actually breached (a real loss of separation),
   *  false when only the advisory buffer is (a close, sub-buffer pass). */
  definite: boolean;
}

/** Minimum horizontal separation (NM) between two flights over their overlapping
 *  airborne window, with the CPA time + vertical gap there. Used by the preview
 *  modal to show the resolved d_CPA live as the user edits a maneuver. Returns
 *  null when they're never airborne together. */
export function pairSeparation(
  A: PlanFlight,
  B: PlanFlight,
  stepSec = 10,
): { minHNm: number; tCpaAbsSec: number; vSepAtCpaFt: number } | null {
  const start = Math.max(A.offsetSec, B.offsetSec);
  const end = Math.min(A.offsetSec + A.durationSec, B.offsetSec + B.durationSec);
  // Guard the scan bounds: a non-finite duration (e.g. a corrupt timestamp from
  // a maneuvered trajectory) would make `end` Infinity and spin this loop
  // forever — a synchronous tab freeze. A non-positive step would too.
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 1) return null;
  const step = stepSec > 0 ? stepSec : 10;
  const a0 = aircraftAt(A.samples, start - A.offsetSec);
  const b0 = aircraftAt(B.samples, start - B.offsetSec);
  if (!a0 || !b0) return null;
  const frame = frameFor([a0, b0]);
  let minH = Infinity;
  let tCpa = start;
  let vAt = 0;
  let guard = 0;
  for (let t = start; t <= end; t += step) {
    if (++guard > MAX_SCAN_STEPS) break; // hard stop — never spin the main thread
    const acA = aircraftAt(A.samples, t - A.offsetSec);
    const acB = aircraftAt(B.samples, t - B.offsetSec);
    if (!acA || !acB || acA.altitudeFt == null || acB.altitudeFt == null) continue;
    const h = mag(sub(toEnu(frame, acB.lat, acB.lon), toEnu(frame, acA.lat, acA.lon)));
    if (h < minH) {
      minH = h;
      tCpa = t;
      vAt = Math.abs(acB.altitudeFt - acA.altitudeFt);
    }
  }
  return { minHNm: minH, tCpaAbsSec: tCpa, vSepAtCpaFt: vAt };
}

/** 3-D conflict check between two flights over the whole plan (horizontal AND
 *  vertical simultaneously), returning the conflict or null. Exported so the
 *  advisory can verify a candidate maneuver clears traffic including level
 *  changes, where horizontal separation alone stays tight. */
export function pairConflict(
  A: PlanFlight,
  B: PlanFlight,
  cfg: CdrConfig,
  stepSec = 15,
): PlanConflict | null {
  return scanPair(A, B, cfg, stepSec);
}

/** Scan one pair over their overlapping airborne window. */
function scanPair(
  A: PlanFlight,
  B: PlanFlight,
  cfg: CdrConfig,
  stepSec: number,
): PlanConflict | null {
  const start = Math.max(A.offsetSec, B.offsetSec);
  const end = Math.min(A.offsetSec + A.durationSec, B.offsetSec + B.durationSec);
  // Guard the scan bounds: a non-finite duration (e.g. a corrupt timestamp from
  // a maneuvered trajectory) would make `end` Infinity and spin this loop
  // forever — a synchronous tab freeze. A non-positive step would too.
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 1) return null;
  const step = stepSec > 0 ? stepSec : 15;

  // A local frame near the pair's positions at the overlap start keeps the
  // planar geometry accurate over the (bounded) encounter.
  const a0 = aircraftAt(A.samples, start - A.offsetSec);
  const b0 = aircraftAt(B.samples, start - B.offsetSec);
  if (!a0 || !b0) return null;
  const frame = frameFor([a0, b0]);

  let minH = Infinity;
  let tCpaAbs = start;
  let vAtMinH = 0;
  let cpaA: AircraftState = a0;
  let cpaB: AircraftState = b0;

  // Pass 1 (cheap — pure geometry, NO airspace lookups): find the CPA.
  let guard = 0;
  for (let t = start; t <= end; t += step) {
    if (++guard > MAX_SCAN_STEPS) break; // hard stop — never spin the main thread
    const acA = aircraftAt(A.samples, t - A.offsetSec);
    const acB = aircraftAt(B.samples, t - B.offsetSec);
    if (!acA || !acB || acA.altitudeFt == null || acB.altitudeFt == null) continue;
    const h = mag(sub(toEnu(frame, acB.lat, acB.lon), toEnu(frame, acA.lat, acA.lon)));
    if (h < minH) {
      minH = h;
      tCpaAbs = t;
      vAtMinH = Math.abs(acB.altitudeFt - acA.altitudeFt);
      cpaA = acA;
      cpaB = acB;
    }
  }

  // Position-dependent horizontal minimum, evaluated ONCE at the CPA (where the
  // encounter is tightest — the point the separation standard actually governs).
  // Calling the airspace resolver PER STEP made this O(steps × polygons): inside
  // the advisory's hundreds of candidate re-checks it cost ~10 s per conflict and
  // froze the tab. One lookup per pair here is ~360× cheaper.
  const shAtCpa = sepMinNmForPair(
    cfg,
    cpaA.lat, cpaA.lon, cpaA.altitudeFt,
    cpaB.lat, cpaB.lon, cpaB.altitudeFt,
  );
  const shBuf = shAtCpa + cfg.buffer.horizontalNm;

  // Pass 2 (cheap): breach + first hard loss of separation, using the CPA
  // minimum (sv stays per-step — it's a plain comparison, not a polygon test).
  let losStart: number | null = null;
  let bufferedBreach = false;
  guard = 0;
  for (let t = start; t <= end; t += step) {
    if (++guard > MAX_SCAN_STEPS) break;
    const acA = aircraftAt(A.samples, t - A.offsetSec);
    const acB = aircraftAt(B.samples, t - B.offsetSec);
    if (!acA || !acB || acA.altitudeFt == null || acB.altitudeFt == null) continue;
    const h = mag(sub(toEnu(frame, acB.lat, acB.lon), toEnu(frame, acA.lat, acA.lon)));
    const v = Math.abs(acB.altitudeFt - acA.altitudeFt);
    const sv = verticalMinimumFt(cfg, acA.altitudeFt, acB.altitudeFt);
    if (h < shBuf && v < sv + cfg.buffer.verticalFt) {
      bufferedBreach = true;
      if (losStart == null && h < shAtCpa && v < sv) losStart = t;
    }
  }

  if (!bufferedBreach) return null;

  const [a, b, aCs, bCs] =
    A.id < B.id
      ? [A.id, B.id, A.callsign, B.callsign]
      : [B.id, A.id, B.callsign, A.callsign];
  // svFt reported at CPA altitudes (governing minimum there).
  const acAcpa = aircraftAt(A.samples, tCpaAbs - A.offsetSec);
  const acBcpa = aircraftAt(B.samples, tCpaAbs - B.offsetSec);
  const svFt =
    acAcpa?.altitudeFt != null && acBcpa?.altitudeFt != null
      ? verticalMinimumFt(cfg, acAcpa.altitudeFt, acBcpa.altitudeFt)
      : cfg.vertical.belowRvsmTopFt;

  return {
    id: `${a}|${b}`,
    a,
    b,
    aCallsign: aCs,
    bCallsign: bCs,
    losStartAbsSec: losStart,
    tCpaAbsSec: tCpaAbs,
    dCpaNm: minH,
    vSepAtCpaFt: vAtMinH,
    shNm: shAtCpa,
    svFt,
    definite: losStart != null,
  };
}

/**
 * Every conflict in the filed plans, sorted so the ones that lose separation
 * soonest come first (definite losses before sub-buffer passes).
 */
export function scanFlightPlanConflicts(
  flights: PlanFlight[],
  cfg: CdrConfig,
  stepSec = 15,
): PlanConflict[] {
  const out: PlanConflict[] = [];
  for (let i = 0; i < flights.length; i++) {
    for (let j = i + 1; j < flights.length; j++) {
      const c = scanPair(flights[i], flights[j], cfg, stepSec);
      if (c) out.push(c);
    }
  }
  out.sort((x, y) => {
    if (x.definite !== y.definite) return x.definite ? -1 : 1;
    const tx = x.losStartAbsSec ?? x.tCpaAbsSec;
    const ty = y.losStartAbsSec ?? y.tCpaAbsSec;
    return tx - ty;
  });
  return out;
}
