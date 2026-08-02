/**
 * What-if separation simulator — the pure kernel of the resolution engine.
 *
 * A candidate maneuver replaces ONE aircraft's future with a straight leg on the
 * new heading/level/speed (a maneuver IS a new constant-velocity segment); every
 * OTHER aircraft keeps its REAL future path (sampled from its trajectory), so a
 * resolution is validated against where traffic is actually going, not a
 * straight-line guess. A candidate is valid only if, across the whole look-ahead,
 * it stays clear of EVERY other aircraft by the buffered minima — i.e. it
 * neither leaves the original conflict unresolved nor creates a secondary one.
 *
 * Everything works in a single shared ENU frame (NM, ft), on the same dt grid
 * the detector uses. Pure and unit-tested.
 */

import { horizontalMinimumNm, verticalMinimumFt, type CdrConfig } from "./config";
import { add, mag, scale, sub, type Vec2 } from "./geo";

/** A straight-line mover: position p(t) = p0 + v·t, altitude a(t) = alt0 + vs·t. */
export interface Kinematic {
  p0: Vec2; // NM
  v: Vec2; // NM/s
  alt0: number; // ft
  vs: number; // ft/s
}

/** The maneuvered aircraft's future, as time-parameterised closures. */
export interface ManeuverPath {
  pos: (t: number) => Vec2;
  alt: (t: number) => number;
}

/** Straight-line path from a Kinematic. */
export function straightPath(k: Kinematic): ManeuverPath {
  return {
    pos: (t) => add(k.p0, scale(k.v, t)),
    alt: (t) => k.alt0 + k.vs * t,
  };
}

/** One other aircraft's REAL future, projected into the shared frame, on the
 *  detector's dt grid (index i → dt = i·stepSec). */
export interface OtherTraffic {
  id: string;
  samples: { p: Vec2; alt: number }[];
}

export interface SeparationResult {
  /** Minimum horizontal separation, over the window, to the ORIGINAL intruder. */
  minHToIntruderNm: number;
  /** Does the maneuvered aircraft stay clear (buffered minima) of ALL others? */
  clearOfAll: boolean;
  /** Id of the first aircraft it is NOT clear of, or null when clear. */
  offenderId: string | null;
}

/**
 * March the maneuvered path against every other aircraft's real future on the
 * shared grid and report the minimum separation to the original intruder plus
 * whether the maneuver clears all traffic by the buffered minima.
 */
export function simulateSeparation(
  path: ManeuverPath,
  intruderId: string,
  others: OtherTraffic[],
  cfg: CdrConfig,
): SeparationResult {
  const sh = horizontalMinimumNm(cfg) + cfg.buffer.horizontalNm;
  const step = cfg.lookahead.stepSec;

  let minHToIntruder = Infinity;
  let clearOfAll = true;
  let offenderId: string | null = null;

  for (const o of others) {
    let breach = false;
    for (let i = 0; i < o.samples.length; i++) {
      const t = i * step;
      const s = o.samples[i];
      const h = mag(sub(path.pos(t), s.p));
      if (o.id === intruderId && h < minHToIntruder) minHToIntruder = h;
      const altT = path.alt(t);
      const sv = verticalMinimumFt(cfg, altT, s.alt) + cfg.buffer.verticalFt;
      if (h < sh && Math.abs(altT - s.alt) < sv) {
        breach = true;
        break;
      }
    }
    if (breach && clearOfAll) {
      clearOfAll = false;
      offenderId = o.id;
    }
  }

  return { minHToIntruderNm: minHToIntruder, clearOfAll, offenderId };
}
