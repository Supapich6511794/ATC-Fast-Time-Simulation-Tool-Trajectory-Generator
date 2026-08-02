/**
 * Closest-Point-of-Approach geometry and separation-window solving — the pure
 * mathematical core of conflict detection. Every function here is total, side
 * -effect-free and unit-tested (cpa.test.ts) against known geometric cases.
 *
 * Convention: relative vectors are intruder-minus-ownship,
 *   p = p2 − p1   (relative position, NM, in the ENU frame)
 *   v = v2 − v1   (relative velocity, NM/s)
 * so |p + v·t| is the horizontal separation at future time t (seconds).
 * Vertical is handled separately from altitudes + vertical rates.
 */

import { type Vec2, add, dot, mag, mag2, scale } from "./geo";

/** A closed time interval [t0, t1] in seconds; ±Infinity bounds allowed for the
 *  degenerate "separation is constant" cases. `null` means "never within the
 *  threshold". */
export type Interval = { t0: number; t1: number };

const EPS = 1e-9;

/** Closest point of approach for a constant-velocity pair.
 *  t_cpa = −(p·v)/|v|²  (clamped to 0 when there is ~no relative motion),
 *  d_cpa = |p + v·t_cpa|. t_cpa may be negative (CPA already passed). */
export function cpa(p: Vec2, v: Vec2): { tCpa: number; dCpa: number } {
  const vv = mag2(v);
  const tCpa = vv < EPS ? 0 : -dot(p, v) / vv;
  const dCpa = mag(add(p, scale(v, tCpa)));
  return { tCpa, dCpa };
}

/** Horizontal separation at time t (NM). */
export function horizontalSepAt(p: Vec2, v: Vec2, t: number): number {
  return mag(add(p, scale(v, t)));
}

/**
 * Time interval during which horizontal separation is strictly below `sh` NM,
 * by solving |p + v·t|² = sh²  ⇒  |v|²t² + 2(p·v)t + (|p|² − sh²) = 0.
 *
 *  - No relative motion (|v|≈0): separation is the constant |p| → the whole
 *    timeline if already inside sh, else never.
 *  - Discriminant ≤ 0: the paths never close to within sh → never.
 *  - Otherwise the two roots bound the interval the separation is < sh.
 */
export function horizontalWindow(p: Vec2, v: Vec2, sh: number): Interval | null {
  const a = mag2(v);
  const b = 2 * dot(p, v);
  const c = mag2(p) - sh * sh;

  if (a < EPS) {
    // Stationary relative geometry: inside for all time, or never.
    return c < 0 ? { t0: -Infinity, t1: Infinity } : null;
  }
  const disc = b * b - 4 * a * c;
  if (disc <= 0) return null; // tangent or clear — no sustained breach
  const sqrtD = Math.sqrt(disc);
  const t0 = (-b - sqrtD) / (2 * a);
  const t1 = (-b + sqrtD) / (2 * a);
  return { t0: Math.min(t0, t1), t1: Math.max(t0, t1) };
}

/**
 * Time interval during which the vertical gap |Δalt(t)| is strictly below
 * `sv` ft, where Δalt(t) = dz0 + dvz·t.
 *   dz0  = alt2 − alt1                     (ft, current vertical gap, signed)
 *   dvz  = (vs2 − vs1) converted to ft/s   (relative vertical speed)
 *  - dvz≈0: constant gap → whole timeline if |dz0| < sv, else never.
 *  - else the gap crosses ±sv at two times bounding the interval.
 */
export function verticalWindow(dz0: number, dvz: number, sv: number): Interval | null {
  if (Math.abs(dvz) < EPS) {
    return Math.abs(dz0) < sv ? { t0: -Infinity, t1: Infinity } : null;
  }
  // dz0 + dvz·t = +sv  and  = −sv
  const ta = (sv - dz0) / dvz;
  const tb = (-sv - dz0) / dvz;
  return { t0: Math.min(ta, tb), t1: Math.max(ta, tb) };
}

/** Intersection of two intervals, or null if they don't overlap. */
export function intersect(a: Interval | null, b: Interval | null): Interval | null {
  if (!a || !b) return null;
  const t0 = Math.max(a.t0, b.t0);
  const t1 = Math.min(a.t1, b.t1);
  return t0 <= t1 ? { t0, t1 } : null;
}

/**
 * The conflict window: the span during which BOTH horizontal (<sh) and vertical
 * (<sv) separation are simultaneously lost — the correct 3-D criterion. Returns
 * null when the two never coincide (the classic "crossing but well stacked, so
 * no conflict" case that using d_cpa alone would get wrong).
 */
export function conflictWindow(
  p: Vec2,
  v: Vec2,
  dz0: number,
  dvz: number,
  sh: number,
  sv: number,
): Interval | null {
  return intersect(horizontalWindow(p, v, sh), verticalWindow(dz0, dvz, sv));
}
