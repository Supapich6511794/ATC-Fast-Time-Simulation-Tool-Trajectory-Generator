/**
 * Future-path helpers. The real future comes from sampling an aircraft's
 * precomputed trajectory (see traffic.ts); this module provides the pure
 * straight-line fallback used where no trajectory is available — the resolution
 * what-if's maneuvered leg, and the unit tests — and the shared sampling grid.
 */

import { makeFrame, toLatLon, velocityFromGsTrack } from "./geo";
import type { CdrAircraft, FutureSample } from "./types";

/** The dt grid (seconds from now) both aircraft of a pair are sampled on, so
 *  their futures align index-for-index. Always starts at 0 (now). */
export function futureGrid(windowSec: number, stepSec: number): number[] {
  const grid: number[] = [];
  for (let dt = 0; dt <= windowSec + 1e-6; dt += stepSec) grid.push(dt);
  return grid;
}

/**
 * Constant-velocity future for an instantaneous state — the straight-line path
 * the aircraft would fly if it held its current heading, speed and vertical
 * rate. Used as the maneuvered leg in the what-if (a new heading IS a straight
 * leg) and to synthesise test traffic.
 */
export function straightFuture(
  ac: Pick<CdrAircraft, "lat" | "lon" | "altFt" | "gsKt" | "trackDeg" | "vsFpm">,
  windowSec: number,
  stepSec: number,
): FutureSample[] {
  const frame = makeFrame(ac.lat, ac.lon);
  const v = velocityFromGsTrack(ac.gsKt, ac.trackDeg); // NM/s
  const vzFps = ac.vsFpm / 60;
  return futureGrid(windowSec, stepSec).map((dt) => {
    const { lat, lon } = toLatLon(frame, { x: v.x * dt, y: v.y * dt });
    return { dt, lat, lon, altFt: ac.altFt + vzFps * dt };
  });
}
