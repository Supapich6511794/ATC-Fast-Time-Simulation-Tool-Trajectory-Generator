/**
 * Issuing an arrival-spacing instruction — the "Apply" behind the panel.
 *
 * A speed control is the one resolution that can be flown without touching the
 * ground track: the aircraft stays on its path and simply takes longer to get
 * down it. So it is applied here, client-side, the same way the other CD&R
 * maneuvers are — by re-timing the trajectory the app already holds.
 *
 * Only the part of the flight STILL AHEAD of the clock is changed. An
 * instruction cannot alter where the aircraft has already been, and the panel's
 * spacing numbers are measured from the projected path, so re-timing the past
 * would move the very samples the measurement was taken against.
 *
 * A HOLD is applied here too, for the same reason: the racetrack is traced from
 * the published pattern and spliced in at the fix, which the CD&R side already
 * does for conflict holds — so it reuses that, rather than a second geometry.
 *
 * A downwind extension is not done here — it changes the ground track, and that
 * geometry lives in the engine (`trajectory_sim.vectors`). Applying one means a
 * round trip to `/api/generate` with `tactical_extend`.
 */

import type { TrajectoryPoint, TrajectoryResult } from "@/lib/trajectory/types";

import type { ArrivalHold } from "./arrivalFix";
import { applyManeuver } from "./kinematics";

const NM_PER_DEG_LAT = 60;

function nmBetween(a: TrajectoryPoint, b: TrajectoryPoint): number {
  const dLat = (b.lat - a.lat) * NM_PER_DEG_LAT;
  const dLon =
    (b.lon - a.lon) *
    NM_PER_DEG_LAT *
    Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

const epochOf = (p: TrajectoryPoint): number =>
  new Date(p.epoch_ts).getTime() / 1000;

/**
 * Re-fly the remainder of an arrival at a reduced ground speed.
 *
 * @param points   The trajectory as it stands.
 * @param fromSec  Absolute epoch seconds the instruction takes effect at —
 *                 normally the sim clock. Samples before it are untouched.
 * @param newGsKt  The speed to fly. Applied as a CAP: a sample already slower
 *                 (short final, say) keeps its own speed rather than being
 *                 sped up by a reduction instruction.
 * @returns A new points array. The input is not modified.
 */
export function applySpeedReduction(
  points: TrajectoryPoint[],
  fromSec: number,
  newGsKt: number,
): TrajectoryPoint[] {
  if (points.length < 2 || !(newGsKt > 0)) return points;

  const start = points.findIndex((p) => epochOf(p) >= fromSec);
  // Already past the end, or the instruction lands on the very last sample:
  // there is nothing left to re-time.
  if (start < 0 || start >= points.length - 1) return points;

  const out: TrajectoryPoint[] = points.slice(0, start + 1).map((p) => ({ ...p }));
  let clock = epochOf(points[start]);

  for (let i = start + 1; i < points.length; i++) {
    const gs = Math.min(points[i].gs_kt, newGsKt);
    const legNm = nmBetween(points[i - 1], points[i]);
    clock += gs > 0 ? (legNm / gs) * 3600 : 0;
    out.push({
      ...points[i],
      gs_kt: gs,
      // TAS follows the same cap; the sim has no wind model, so GS = TAS.
      tas_kt: points[i].tas_kt == null ? points[i].tas_kt : gs,
      epoch_ts: new Date(clock * 1000).toISOString(),
    });
  }
  return out;
}

/**
 * Fly `loops` racetrack patterns at a published holding fix, then resume the
 * route — everything after the fix is delayed by the time spent in the hold.
 *
 * Each loop is applied separately. `applyManeuver`'s hold traces ONE pattern
 * and returns the aircraft to the fix, so the second loop is simply another
 * hold entered at the moment the first one ends. The re-entry time is measured
 * from the trajectory that comes back rather than assumed to be `loopSec`,
 * so a rounding difference between the coded pattern and the traced one cannot
 * accumulate into a pivot that misses the fix.
 *
 * @returns A new TrajectoryResult. The input is not modified. Returned
 *          unchanged when the fix is already behind the aircraft — a hold
 *          cannot be joined anywhere but at the fix.
 */
export function applyArrivalHold(
  traj: TrajectoryResult,
  hold: ArrivalHold,
  loops: number,
  /** Local time (s) now — the instruction cannot act on the past. */
  nowSec = 0,
): TrajectoryResult {
  const n = Math.max(0, Math.round(loops));
  if (n === 0 || traj.points.length < 2) return traj;
  if (hold.tManSec <= nowSec) return traj;

  const durationOf = (t: TrajectoryResult): number =>
    (new Date(t.points[t.points.length - 1].epoch_ts).getTime() -
      new Date(t.points[0].epoch_ts).getTime()) /
    1000;

  let out = traj;
  let tMan = hold.tManSec;
  for (let i = 0; i < n; i++) {
    const before = durationOf(out);
    const next = applyManeuver(out, { type: "hold", resolution: { hold } }, tMan);
    const flownSec = durationOf(next) - before;
    if (!(flownSec > 0)) return out; // the loop bought nothing — stop here
    out = next;
    tMan += flownSec; // back over the fix, ready to enter the next pattern
  }
  return out;
}

/** Seconds the aircraft is delayed by re-timing — i.e. what the fix bought. */
export function delayFromReduction(
  before: TrajectoryPoint[],
  after: TrajectoryPoint[],
): number {
  if (!before.length || !after.length) return 0;
  return (
    epochOf(after[after.length - 1]) - epochOf(before[before.length - 1])
  );
}
