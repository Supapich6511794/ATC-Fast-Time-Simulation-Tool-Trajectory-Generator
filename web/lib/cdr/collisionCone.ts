/**
 * Velocity-obstacle (collision-cone) minimum-turn solver — the geometric seed
 * for heading resolutions. Pure and unit-tested (collisionCone.test.ts).
 *
 * The collision cone at the ownship, apex at its position, opens toward the
 * intruder with half-angle α = asin(S_h / R), where R is the line-of-sight
 * range and S_h the (buffered) horizontal minimum. A collision is predicted
 * when the RELATIVE velocity v_rel = v_own − v_intruder points into that cone
 * while closing. To clear it by heading alone we keep the ownship SPEED fixed
 * and rotate its velocity until v_rel lands on a cone edge — the smallest such
 * rotation, left and right, is the minimum avoidance turn.
 *
 * Rotating the ownship velocity by θ sweeps the tip of v_rel around a circle of
 * radius |v_own| centred at −v_intruder. Intersecting that circle with each
 * cone-edge ray (direction θ_LOS ± α) gives the headings that put v_rel exactly
 * on the boundary; the required turn is the signed heading change to reach one.
 *
 * All vectors are in the ENU frame (NM, NM/s); angles internally are standard
 * math radians (atan2(y,x)), converted to compass turns only at the boundary.
 */

import {
  add,
  dot,
  headingDeltaDeg,
  mag,
  mag2,
  scale,
  sub,
  trackOf,
  type Vec2,
} from "./geo";

export interface ConeResult {
  /** Cone half-angle (degrees). */
  alphaDeg: number;
  /** Line-of-sight range to the intruder (NM). */
  losRangeNm: number;
  /** True when a collision is currently predicted: v_rel is inside the cone and
   *  the pair is closing. */
  inCone: boolean;
  /** Minimum LEFT turn (degrees, positive magnitude) that moves v_rel onto the
   *  cone edge, or null when no speed-preserving heading achieves it (e.g. the
   *  intruder already inside minima, or ownship too slow to reshape v_rel). */
  leftTurnDeg: number | null;
  /** Minimum RIGHT turn (degrees, positive magnitude), or null. */
  rightTurnDeg: number | null;
}

const EPS = 1e-9;

export function collisionCone(
  pOwn: Vec2,
  vOwn: Vec2,
  pIntruder: Vec2,
  vIntruder: Vec2,
  shNm: number,
): ConeResult {
  const r = sub(pIntruder, pOwn); // line of sight, own → intruder
  const R = mag(r);
  const vRel = sub(vOwn, vIntruder);
  const closing = dot(vRel, r) > 0;

  // Degenerate: intruder at (or inside) the horizontal minimum — the cone opens
  // to a half-plane and a pure heading change can't cleanly resolve it. Signal
  // "no heading solution" so the advisory engine falls back to level/speed.
  if (R < EPS || shNm / R >= 1) {
    return {
      alphaDeg: 90,
      losRangeNm: R,
      inCone: closing,
      leftTurnDeg: null,
      rightTurnDeg: null,
    };
  }

  const alpha = Math.asin(shNm / R); // radians
  const thetaR = Math.atan2(r.y, r.x);
  let beta = Math.atan2(vRel.y, vRel.x) - thetaR;
  beta = Math.atan2(Math.sin(beta), Math.cos(beta)); // normalise to −π…π
  const inCone = closing && Math.abs(beta) <= alpha;

  const currentTrack = trackOf(vOwn);
  const sOwn = mag(vOwn);

  // Candidate escape headings: intersect the |v_own|-radius circle (centred at
  // −v_intruder) with each cone-edge ray direction û = (cos e, sin e).
  const turns: number[] = [];
  for (const e of [thetaR + alpha, thetaR - alpha]) {
    const u: Vec2 = { x: Math.cos(e), y: Math.sin(e) };
    const uvi = dot(u, vIntruder);
    const disc = uvi * uvi - (mag2(vIntruder) - sOwn * sOwn);
    if (disc < 0) continue; // circle doesn't reach this ray
    const sq = Math.sqrt(disc);
    for (const L of [-uvi + sq, -uvi - sq]) {
      if (L < -1e-6) continue; // v_rel must lie ALONG the outward ray (L ≥ 0)
      const vOwnNew = add(scale(u, Math.max(0, L)), vIntruder);
      if (mag(vOwnNew) < EPS) continue;
      turns.push(headingDeltaDeg(currentTrack, trackOf(vOwnNew)));
    }
  }

  // headingDeltaDeg: positive = clockwise = right turn, negative = left.
  let leftTurnDeg: number | null = null;
  let rightTurnDeg: number | null = null;
  for (const t of turns) {
    if (t >= 0) {
      if (rightTurnDeg == null || t < rightTurnDeg) rightTurnDeg = t;
    } else {
      const m = -t;
      if (leftTurnDeg == null || m < leftTurnDeg) leftTurnDeg = m;
    }
  }

  return { alphaDeg: (alpha * 180) / Math.PI, losRangeNm: R, inCone, leftTurnDeg, rightTurnDeg };
}
