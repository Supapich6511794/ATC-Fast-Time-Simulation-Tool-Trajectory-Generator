/**
 * Traffic adapter — bridges the app's precomputed trajectories to the pure
 * detection engine's `CdrAircraft` snapshot.
 *
 * The app doesn't integrate aircraft physics per frame; every plane rides a
 * precomputed `points[]` table that `aircraftAt` interpolates. So the engine's
 * instantaneous state (position, ground velocity, vertical rate) is sampled
 * from that interpolation at the current clock. Vertical rate isn't stored, so
 * we derive it by finite-differencing the interpolated altitude over a short
 * window — exactly the instantaneous climb/descent rate the CPA math needs.
 *
 * Only AIRBORNE aircraft in the shared "all" timeline are included: a scheduled
 * (not-yet-departed) or arrived flight isn't real traffic to separate.
 */

import { statusFromLocalT } from "@/lib/flightStatus";
import type { TrajectoryResult } from "@/lib/trajectory/types";
import { aircraftAt, type AircraftState } from "@/lib/useSimPlayback";

import { futureGrid } from "./future";
import type { CdrAircraft, FutureSample } from "./types";

interface Sample extends AircraftState {
  t: number;
}

/** Window (seconds of flight time) over which vertical rate is estimated. */
const VS_DT = 6;

/** Instantaneous vertical rate (ft/min) at local time `t`, from the altitude
 *  interpolation. Central where possible, one-sided near the ends. */
function verticalRateFpm(samples: Sample[], t: number, duration: number): number {
  const dt = Math.min(VS_DT, Math.max(1, duration / 2));
  const lo = Math.max(0, t - dt);
  const hi = Math.min(duration, t + dt);
  const a = aircraftAt(samples, lo);
  const b = aircraftAt(samples, hi);
  if (!a || !b || a.altitudeFt == null || b.altitudeFt == null || hi <= lo) {
    return 0;
  }
  return ((b.altitudeFt - a.altitudeFt) / (hi - lo)) * 60;
}

/**
 * Sample every airborne aircraft into the engine's snapshot type at the given
 * absolute sim clock, INCLUDING its real future path over `windowSec` (sampled
 * from the precomputed trajectory on the `stepSec` grid). `samplesByIdx` and
 * `offsets` are the same tables MapApp already builds; only "all" mode feeds CD&R.
 *
 * The future stops early if the flight lands within the window — a landed
 * aircraft is no longer traffic to separate, so its future simply ends there.
 */
export function sampleTraffic(
  trajectories: TrajectoryResult[],
  samplesByIdx: Sample[][],
  simT: number,
  offsets: number[],
  windowSec: number,
  stepSec: number,
): CdrAircraft[] {
  const grid = futureGrid(windowSec, stepSec);
  const out: CdrAircraft[] = [];
  for (let i = 0; i < trajectories.length; i++) {
    const t = trajectories[i];
    const samples = samplesByIdx[i];
    if (!samples || samples.length < 2) continue;
    // The sample table already carries elapsed seconds, so its last entry IS
    // the flight duration — cheaper than re-parsing two ISO stamps per flight
    // on every pass, which at a full traffic day is thousands of Date parses a
    // second spent mostly on aircraft that aren't even airborne.
    const duration = samples[samples.length - 1].t;
    const localT = simT - (offsets[i] ?? 0);
    if (statusFromLocalT(localT, duration) !== "enroute") continue;
    const ac = aircraftAt(samples, localT);
    if (!ac || ac.altitudeFt == null) continue;

    // Real future path along the actual trajectory, truncated at touchdown.
    const future: FutureSample[] = [];
    for (const dt of grid) {
      const lt = localT + dt;
      if (lt > duration) break; // arrived — no more traffic to project
      const f = aircraftAt(samples, lt);
      if (!f || f.altitudeFt == null) break;
      future.push({ dt, lat: f.lat, lon: f.lon, altFt: f.altitudeFt });
    }
    if (future.length < 1) continue;

    out.push({
      id: t.meta.flightKey,
      callsign: t.meta.callsign,
      type: t.meta.aircraftType,
      lat: ac.lat,
      lon: ac.lon,
      altFt: ac.altitudeFt,
      gsKt: ac.gsKt,
      trackDeg: ac.track,
      vsFpm: verticalRateFpm(samples, localT, duration),
      future,
    });
  }
  return out;
}
