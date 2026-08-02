/**
 * Map-drawing geometry for conflicts — derived from each aircraft's REAL future
 * path (the same samples the detector walks), so the predicted tracks and CPA
 * marker the controller sees match what detection actually used, curves and all.
 * Pure and UI-free.
 */

import type { CdrAircraft, Conflict, FutureSample } from "./types";

export interface LatLon {
  lat: number;
  lon: number;
}

/** Position along a future path at time `dt` (s), linearly interpolated between
 *  the bracketing samples. Clamps to the path ends. */
export function positionAt(future: FutureSample[], dt: number): LatLon {
  if (future.length === 0) return { lat: 0, lon: 0 };
  if (dt <= future[0].dt) return { lat: future[0].lat, lon: future[0].lon };
  const last = future[future.length - 1];
  if (dt >= last.dt) return { lat: last.lat, lon: last.lon };
  for (let i = 1; i < future.length; i++) {
    if (dt <= future[i].dt) {
      const a = future[i - 1];
      const b = future[i];
      const f = (dt - a.dt) / (b.dt - a.dt || 1);
      return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
    }
  }
  return { lat: last.lat, lon: last.lon };
}

/** The future path up to `horizonSec`, as a lat/lon polyline. */
export function trackUpTo(future: FutureSample[], horizonSec: number): LatLon[] {
  const out: LatLon[] = future
    .filter((s) => s.dt <= horizonSec)
    .map((s) => ({ lat: s.lat, lon: s.lon }));
  if (out.length === 0 && future.length) {
    out.push({ lat: future[0].lat, lon: future[0].lon });
  }
  // Include the exact horizon endpoint for a clean line end.
  const endpoint = positionAt(future, horizonSec);
  const lastDrawn = out[out.length - 1];
  if (!lastDrawn || lastDrawn.lat !== endpoint.lat || lastDrawn.lon !== endpoint.lon) {
    out.push(endpoint);
  }
  return out;
}

export interface ConflictGeometry {
  aId: string;
  bId: string;
  aNow: LatLon;
  bNow: LatLon;
  aTrack: LatLon[];
  bTrack: LatLon[];
  aCpa: LatLon;
  bCpa: LatLon;
  cpaMid: LatLon;
  tCpa: number;
}

/** Full drawable geometry for one conflict from the two aircraft's real futures,
 *  or null if either has left the traffic snapshot. Tracks extend a little past
 *  CPA so the crossing is visible. */
export function conflictGeometry(
  c: Conflict,
  byId: Map<string, CdrAircraft>,
): ConflictGeometry | null {
  const a = byId.get(c.a);
  const b = byId.get(c.b);
  if (!a || !b) return null;

  const horizon = Math.max(30, (c.tCpa > 0 ? c.tCpa : 0) + 45);
  const tCpaDraw = Math.max(0, c.tCpa);
  const aCpa = positionAt(a.future, tCpaDraw);
  const bCpa = positionAt(b.future, tCpaDraw);

  return {
    aId: c.a,
    bId: c.b,
    aNow: { lat: a.lat, lon: a.lon },
    bNow: { lat: b.lat, lon: b.lon },
    aTrack: trackUpTo(a.future, horizon),
    bTrack: trackUpTo(b.future, horizon),
    aCpa,
    bCpa,
    cpaMid: { lat: (aCpa.lat + bCpa.lat) / 2, lon: (aCpa.lon + bCpa.lon) / 2 },
    tCpa: c.tCpa,
  };
}
