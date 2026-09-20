/**
 * The curve a track is stroked as.
 *
 * The property that matters is that smoothing does not MOVE the aircraft: every
 * sample has to stay on the line, because the line is a claim about where the
 * aircraft was. The rest is about not introducing artefacts that look like
 * data — a cusp where the generator snapped a short interval, or a curve that
 * bulges away from a straight leg.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_SUBDIVISION,
  smoothTrack,
  subdivisionFor,
  type LatLonPoint,
} from "./trailCurve";

/** Metres-ish, good enough to compare two nearby points. */
const gap = (a: LatLonPoint, b: LatLonPoint) =>
  Math.hypot(a.lat - b.lat, (a.lon - b.lon) * Math.cos((a.lat * Math.PI) / 180)) *
  60 *
  1852;

/** A quarter circle of radius r NM about (lat0, lon0), sampled every `stepDeg`. */
function arc(stepDeg: number, r = 2, lat0 = 13.9, lon0 = 100.6): LatLonPoint[] {
  const out: LatLonPoint[] = [];
  for (let a = 0; a <= 90; a += stepDeg) {
    const rad = (a * Math.PI) / 180;
    out.push({
      lat: lat0 + (r * Math.sin(rad)) / 60,
      lon: lon0 + (r * Math.cos(rad)) / (60 * Math.cos((lat0 * Math.PI) / 180)),
    });
  }
  return out;
}

describe("smoothTrack", () => {
  const samples = arc(15); // a standard-rate turn at 5 s sampling

  it("keeps every original sample on the line", () => {
    const curve = smoothTrack(samples, 4);
    for (const s of samples) {
      const nearest = Math.min(...curve.map((c) => gap(c, s)));
      // Within a metre: the sample IS a point of the curve, not near one.
      expect(nearest).toBeLessThan(1);
    }
  });

  it("keeps them in order, and keeps the ends", () => {
    const curve = smoothTrack(samples, 4);
    expect(gap(curve[0], samples[0])).toBeLessThan(1);
    expect(gap(curve[curve.length - 1], samples[samples.length - 1])).toBeLessThan(1);
  });

  it("bends the chords towards the real arc", () => {
    // A 15° chord of a 2 NM arc misses the arc by ~32 m at its midpoint. The
    // curve should recover nearly all of that — the measured figure is ~1.3 m,
    // so a factor of ten is a floor, not a target, and catches the endpoint
    // handling regressing to a straight reflection (which gives ~19 m).
    const curve = smoothTrack(samples, 6);
    const centre = { lat: 13.9, lon: 100.6 };
    const radii = curve.map((c) => gap(c, centre));
    const want = radii[0];
    const worstCurve = Math.max(...radii.map((r) => Math.abs(r - want)));

    const chordMids: LatLonPoint[] = [];
    for (let i = 1; i < samples.length; i++) {
      chordMids.push({
        lat: (samples[i - 1].lat + samples[i].lat) / 2,
        lon: (samples[i - 1].lon + samples[i].lon) / 2,
      });
    }
    const worstChord = Math.max(
      ...chordMids.map((m) => Math.abs(gap(m, centre) - want)),
    );
    expect(worstCurve).toBeLessThan(worstChord / 10);
  });

  it("leaves a straight leg straight", () => {
    const line: LatLonPoint[] = [
      { lat: 13.0, lon: 100.0 },
      { lat: 14.0, lon: 100.0 },
      { lat: 15.0, lon: 100.0 },
      { lat: 16.0, lon: 100.0 },
    ];
    for (const p of smoothTrack(line, 5)) {
      expect(Math.abs(p.lon - 100.0)).toBeLessThan(1e-9);
    }
  });

  it("does not cusp where the generator snapped a short interval", () => {
    // Two samples almost on top of each other: uniform Catmull-Rom overshoots
    // into a loop here, which is why the knots are centripetal.
    const bunched: LatLonPoint[] = [
      { lat: 13.0, lon: 100.0 },
      { lat: 13.5, lon: 100.0 },
      { lat: 13.5001, lon: 100.0 },
      { lat: 14.0, lon: 100.0 },
      { lat: 14.5, lon: 100.0 },
    ];
    const curve = smoothTrack(bunched, 5);
    // Monotone in latitude: no doubling back.
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i].lat).toBeGreaterThanOrEqual(curve[i - 1].lat - 1e-9);
    }
  });

  it("hands back the input when there is nothing to do", () => {
    expect(smoothTrack(samples, 1)).toBe(samples);
    const two = samples.slice(0, 2);
    expect(smoothTrack(two, 4)).toBe(two);
  });
});

describe("subdivisionFor", () => {
  it("spends a spare budget on a short trail", () => {
    expect(subdivisionFor(20, 120)).toBeGreaterThan(1);
  });

  it("spends nothing when the trail already fills the budget", () => {
    expect(subdivisionFor(120, 120)).toBe(1);
    expect(subdivisionFor(400, 120)).toBe(1);
  });

  it("stops subdividing once the extra points are inside a pixel", () => {
    expect(subdivisionFor(3, 100000)).toBe(MAX_SUBDIVISION);
  });

  it("never asks for a curve through fewer than three points", () => {
    expect(subdivisionFor(2, 120)).toBe(1);
  });
});
