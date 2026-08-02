import { describe, expect, it } from "vitest";

import { collisionCone } from "./collisionCone";
import { horizontalSepAt } from "./cpa";
import { rotate, velocityFromGsTrack, type Vec2 } from "./geo";

/** Re-run the horizontal closest approach after applying `turnDeg` (compass:
 *  + = right) to the ownship velocity, to confirm a proposed turn actually
 *  clears the minimum. */
function missAfterTurn(
  pOwn: Vec2,
  vOwn: Vec2,
  pIntr: Vec2,
  vIntr: Vec2,
  turnDeg: number,
): number {
  // Compass right turn = clockwise = negative math rotation.
  const vNew = rotate(vOwn, -turnDeg);
  const p: Vec2 = { x: pIntr.x - pOwn.x, y: pIntr.y - pOwn.y };
  const v: Vec2 = { x: vIntr.x - vNew.x, y: vIntr.y - vNew.y };
  // Minimum over the approach: sample densely (pure check, cheap).
  let min = Infinity;
  for (let t = 0; t <= 600; t += 1) {
    min = Math.min(min, horizontalSepAt(p, v, t));
  }
  return min;
}

describe("collisionCone", () => {
  it("head-on: predicts a collision and offers symmetric left/right escapes", () => {
    const pOwn: Vec2 = { x: 0, y: 0 };
    const vOwn = velocityFromGsTrack(450, 90); // east
    const pIntr: Vec2 = { x: 20, y: 0 }; // 20 NM dead ahead
    const vIntr = velocityFromGsTrack(450, 270); // west, head-on
    const r = collisionCone(pOwn, vOwn, pIntr, vIntr, 5);

    expect(r.inCone).toBe(true);
    expect(r.leftTurnDeg).not.toBeNull();
    expect(r.rightTurnDeg).not.toBeNull();
    // Perfect head-on is symmetric.
    expect(r.leftTurnDeg!).toBeCloseTo(r.rightTurnDeg!, 3);
    // α = asin(5/20) ≈ 14.48°.
    expect(r.alphaDeg).toBeCloseTo((Math.asin(5 / 20) * 180) / Math.PI, 6);
  });

  it("head-on: the computed right turn clears the horizontal minimum", () => {
    const pOwn: Vec2 = { x: 0, y: 0 };
    const vOwn = velocityFromGsTrack(450, 90);
    const pIntr: Vec2 = { x: 20, y: 0 };
    const vIntr = velocityFromGsTrack(450, 270);
    const r = collisionCone(pOwn, vOwn, pIntr, vIntr, 5);

    // Turning exactly to the tangent grazes 5 NM; nudge past it and expect ≥5.
    const miss = missAfterTurn(pOwn, vOwn, pIntr, vIntr, r.rightTurnDeg! + 1);
    expect(miss).toBeGreaterThanOrEqual(5 - 1e-2);
  });

  it("90° crossing: predicts a collision and a finite minimum turn", () => {
    const pOwn: Vec2 = { x: 0, y: 0 };
    const vOwn = velocityFromGsTrack(400, 90); // east
    const pIntr: Vec2 = { x: 10, y: -10 }; // ahead and to the right, north-bound
    const vIntr = velocityFromGsTrack(400, 0); // north
    const r = collisionCone(pOwn, vOwn, pIntr, vIntr, 5);

    expect(r.inCone).toBe(true);
    const best = Math.min(r.leftTurnDeg ?? Infinity, r.rightTurnDeg ?? Infinity);
    expect(best).toBeGreaterThan(0);
    expect(best).toBeLessThan(180);
    // Whichever escape is smaller, turning slightly past it must clear 5 NM.
    const turn =
      (r.rightTurnDeg ?? Infinity) <= (r.leftTurnDeg ?? Infinity)
        ? r.rightTurnDeg! + 1
        : -(r.leftTurnDeg! + 1);
    expect(missAfterTurn(pOwn, vOwn, pIntr, vIntr, turn)).toBeGreaterThanOrEqual(
      5 - 1e-2,
    );
  });

  it("diverging traffic: not in cone (no collision predicted)", () => {
    const pOwn: Vec2 = { x: 0, y: 0 };
    const vOwn = velocityFromGsTrack(400, 270); // west
    const pIntr: Vec2 = { x: 20, y: 0 }; // to the east
    const vIntr = velocityFromGsTrack(400, 90); // east — flying apart
    const r = collisionCone(pOwn, vOwn, pIntr, vIntr, 5);
    expect(r.inCone).toBe(false);
  });

  it("intruder already within minima: no clean heading solution", () => {
    const pOwn: Vec2 = { x: 0, y: 0 };
    const vOwn = velocityFromGsTrack(400, 90);
    const pIntr: Vec2 = { x: 3, y: 0 }; // 3 NM < 5 NM minimum
    const vIntr = velocityFromGsTrack(400, 270);
    const r = collisionCone(pOwn, vOwn, pIntr, vIntr, 5);
    expect(r.leftTurnDeg).toBeNull();
    expect(r.rightTurnDeg).toBeNull();
  });
});
