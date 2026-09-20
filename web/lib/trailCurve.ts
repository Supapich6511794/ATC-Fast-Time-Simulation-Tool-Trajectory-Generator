/**
 * Drawing a sampled track as a curve instead of a run of chords.
 *
 * A 4D track is a list of positions at the surveillance rate, and a polyline
 * through them is a sequence of straight chords. On a gentle en-route turn that
 * is invisible — the engine's own turns move about 4.7° between 5-second
 * samples. In a standard-rate turn it is not: 3°/s over 5 s is 15° of heading
 * per sample, and at close zoom the arc reads as a row of corners.
 *
 * This inserts intermediate points along a Catmull–Rom spline through the
 * samples. Two things about that are deliberate:
 *
 *   * **It passes THROUGH every sample.** A Bézier or a B-spline would pull the
 *     line off the measured positions to smooth it, which on a track display is
 *     drawing an aircraft where it was not. Catmull–Rom interpolates: every
 *     original point is still on the line, and only the space between them is
 *     filled in.
 *
 *   * **Nothing here touches the data.** The samples, the exports and every
 *     distance the CD&R engine computes are unchanged; this is how the line is
 *     STROKED. The alternative — emitting more samples — would mean a track
 *     that claims a finer radar rate than the one it was generated at.
 *
 * Centripetal parameterisation (alpha = 0.5) rather than uniform: uniform
 * Catmull–Rom overshoots into a cusp when three samples bunch up, which happens
 * at every phase boundary where the generator snaps a short interval.
 */

export interface LatLonPoint {
  lat: number;
  lon: number;
}

/** Catmull–Rom at parameter `t` in [0,1] on the segment p1→p2, centripetal. */
function crAt(
  p0: number, p1: number, p2: number, p3: number,
  t0: number, t1: number, t2: number, t3: number,
  t: number,
): number {
  // Barry–Goldman pyramidal formulation: stable when knots are close together,
  // which a naive basis-matrix form is not.
  const u = t1 + (t2 - t1) * t;
  const a1 = ((t1 - u) * p0 + (u - t0) * p1) / (t1 - t0 || 1);
  const a2 = ((t2 - u) * p1 + (u - t1) * p2) / (t2 - t1 || 1);
  const a3 = ((t3 - u) * p2 + (u - t2) * p3) / (t3 - t2 || 1);
  const b1 = ((t2 - u) * a1 + (u - t0) * a2) / (t2 - t0 || 1);
  const b2 = ((t3 - u) * a2 + (u - t1) * a3) / (t3 - t1 || 1);
  return ((t2 - u) * b1 + (u - t1) * b2) / (t2 - t1 || 1);
}

/** Knot spacing for centripetal Catmull–Rom: the square root of the chord.
 *  Floored, because every knot interval appears in a denominator. */
function knot(prev: number, a: LatLonPoint, b: LatLonPoint): number {
  const dy = b.lat - a.lat;
  // Longitude is compressed by latitude; without this the curve is skewed the
  // further from the equator it is drawn.
  const dx = (b.lon - a.lon) * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return prev + Math.max(Math.sqrt(Math.hypot(dx, dy)), 1e-9);
}

/**
 * The phantom point beyond an end, so the first and last real segments have a
 * neighbour to be curved against.
 *
 * Not a duplicate of the end point: that is zero chord from its neighbour,
 * hence a zero knot interval, which is the division the centripetal
 * parameterisation exists to avoid. Not a straight reflection either — that
 * says the track was running straight before it was first seen, so the two end
 * segments of a turn flatten out. Measured against a true 2 NM arc sampled
 * every 15°: chords are 31.9 m off at mid-chord, a reflected end leaves the
 * curve 19.0 m off, and the quadratic below leaves it 1.3 m off.
 *
 * The quadratic through the three end samples, continued one step: it carries
 * the local curvature out past the end, and still extrapolates a straight leg
 * to a straight line.
 */
function phantom(a: LatLonPoint, b: LatLonPoint, c: LatLonPoint): LatLonPoint {
  return {
    lat: 3 * a.lat - 3 * b.lat + c.lat,
    lon: 3 * a.lon - 3 * b.lon + c.lon,
  };
}

/**
 * `points` with `perSeg - 1` extra points inserted along each chord, following
 * a curve through the samples.
 *
 * `perSeg` of 1 (or fewer than 3 points) returns the input untouched, so a
 * caller with no spare budget pays nothing.
 */
export function smoothTrack<T extends LatLonPoint>(
  points: T[],
  perSeg: number,
): LatLonPoint[] {
  if (perSeg <= 1 || points.length < 3) return points;

  // A Catmull–Rom segment needs a point either side of it, so the ends get one.
  const n = points.length;
  const p: LatLonPoint[] = [
    phantom(points[0], points[1], points[2]),
    ...points,
    phantom(points[n - 1], points[n - 2], points[n - 3]),
  ];
  const t: number[] = [0];
  for (let i = 1; i < p.length; i++) t.push(knot(t[i - 1], p[i - 1], p[i]));

  const out: LatLonPoint[] = [points[0]];
  for (let i = 1; i < p.length - 2; i++) {
    for (let s = 1; s <= perSeg; s++) {
      const u = s / perSeg;
      out.push({
        lat: crAt(p[i - 1].lat, p[i].lat, p[i + 1].lat, p[i + 2].lat,
                 t[i - 1], t[i], t[i + 1], t[i + 2], u),
        lon: crAt(p[i - 1].lon, p[i].lon, p[i + 1].lon, p[i + 2].lon,
                 t[i - 1], t[i], t[i + 1], t[i + 2], u),
      });
    }
  }
  return out;
}

/**
 * How finely to subdivide, given how many points there are and how many the
 * caller can afford.
 *
 * Self-balancing on purpose: a short trail with the whole budget to itself gets
 * the smoothest curve, and a trail already at its cap is left as chords. So
 * smoothing never costs more than the budget that was there for it, and it is
 * spent where the chords are longest, which is where corners show.
 */
export function subdivisionFor(pointCount: number, budget: number): number {
  if (pointCount < 3) return 1;
  const segs = pointCount - 1;
  return Math.max(1, Math.min(MAX_SUBDIVISION, Math.floor(budget / segs)));
}

/** Past about this, the extra points are inside a pixel. */
export const MAX_SUBDIVISION = 6;
