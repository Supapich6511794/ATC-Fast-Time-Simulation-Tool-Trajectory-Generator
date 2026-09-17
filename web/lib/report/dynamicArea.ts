/**
 * Dynamic sector AREA — moving a boundary, not just pairing sectors up.
 *
 * Band-boxing (see ./dynamicSectors) answers the quiet half of the problem:
 * two neighbouring sectors are empty, so one controller works both. This module
 * answers the busy half. When a sector carries more traffic than a position can
 * hold, the airspace itself is re-cut: a slice of the overloaded sector is
 * handed to an adjacent sector that has room, so the load moves without opening
 * a position that does not exist.
 *
 * The cut
 * -------
 * A straight line, because a controller has to be able to say where the
 * boundary is. It is oriented from the overloaded sector toward the receiving
 * one — the slice ceded is the part of the airspace nearest the sector taking
 * it, which is the only cut that leaves both pieces contiguous and both
 * handovers sane. Its position along that axis is chosen so that exactly the
 * number of aircraft that must leave are on the far side of it.
 *
 * Everything is done in a local flat frame in nautical miles, centred on the
 * overloaded sector. Over a sector a few hundred miles across the error from
 * ignoring the Earth's curvature is far below the precision anyone acts on, and
 * it makes "how far did we cede" a number in the unit controllers use.
 *
 * What can refuse a cut
 * ---------------------
 * A boundary change is an operational act, so the constraints are as real as
 * the arithmetic:
 *
 *   * **It must actually help.** If the receiving sector would itself go over
 *     capacity, the overload has been moved rather than solved.
 *   * **Restricted airspace.** A slice containing an active prohibited or
 *     restricted area is refused: re-cutting airspace around live military
 *     activity is not a decision a traffic count gets to make.
 *   * **Reach.** Airspace far from the receiving sector is refused, as a proxy
 *     for the surveillance and radio coverage that a real boundary change
 *     depends on. It IS a proxy — this dataset carries no radar coverage — so
 *     the limit is a stated assumption, not a measurement.
 *
 * Each refusal comes back with its reason rather than as a silent absence,
 * because "the system did not move the boundary" and "the system found no
 * boundary it was allowed to move" are different things to a reader.
 */

export interface LatLon {
  lat: number;
  lon: number;
}

/** One sector's outline: the outer ring of each of its polygons. */
export type Rings = LatLon[][];

const NM_PER_DEG = 60;

/** Local flat frame in NM, centred on `origin`. */
export function toLocalNm(origin: LatLon, p: LatLon): [number, number] {
  const k = Math.cos((origin.lat * Math.PI) / 180);
  return [(p.lon - origin.lon) * NM_PER_DEG * k, (p.lat - origin.lat) * NM_PER_DEG];
}

export function fromLocalNm(origin: LatLon, xy: [number, number]): LatLon {
  const k = Math.cos((origin.lat * Math.PI) / 180);
  return {
    lon: origin.lon + xy[0] / (NM_PER_DEG * k),
    lat: origin.lat + xy[1] / NM_PER_DEG,
  };
}

/** Signed area of a ring in the local frame, in NM². */
function shoelace(ring: [number, number][]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return a / 2;
}

export function ringAreaNm2(origin: LatLon, ring: LatLon[]): number {
  return Math.abs(shoelace(ring.map((p) => toLocalNm(origin, p))));
}

/** Area-weighted centroid over every ring. Falls back to the vertex mean for a
 *  degenerate outline, so a malformed polygon yields a usable point rather than
 *  a NaN that spreads. */
export function centroidOf(rings: Rings): LatLon {
  let lat = 0;
  let lon = 0;
  let n = 0;
  for (const ring of rings)
    for (const p of ring) {
      lat += p.lat;
      lon += p.lon;
      n++;
    }
  if (n === 0) return { lat: 0, lon: 0 };
  const mean = { lat: lat / n, lon: lon / n };

  let wx = 0;
  let wy = 0;
  let wsum = 0;
  for (const ring of rings) {
    const local = ring.map((p) => toLocalNm(mean, p));
    const a = shoelace(local);
    if (a === 0) continue;
    let cx = 0;
    let cy = 0;
    for (let i = 0, j = local.length - 1; i < local.length; j = i++) {
      const cross = local[j][0] * local[i][1] - local[i][0] * local[j][1];
      cx += (local[j][0] + local[i][0]) * cross;
      cy += (local[j][1] + local[i][1]) * cross;
    }
    wx += cx / (6 * a) * Math.abs(a);
    wy += cy / (6 * a) * Math.abs(a);
    wsum += Math.abs(a);
  }
  return wsum === 0 ? mean : fromLocalNm(mean, [wx / wsum, wy / wsum]);
}

/**
 * Sutherland–Hodgman clip of one ring against the half-plane `x·d >= t`.
 *
 * Exact for this case whatever the shape of the ring: the CLIP region is a
 * half-plane, which is convex, and that is the condition the algorithm needs —
 * not convexity of the polygon being clipped.
 */
export function clipHalfPlane(
  ring: [number, number][],
  d: [number, number],
  t: number,
): [number, number][] {
  if (ring.length === 0) return [];
  const side = (p: [number, number]) => p[0] * d[0] + p[1] * d[1] - t;
  const out: [number, number][] = [];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j];
    const b = ring[i];
    const sa = side(a);
    const sb = side(b);
    if (sb >= 0) {
      if (sa < 0) {
        const f = sa / (sa - sb);
        out.push([a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])]);
      }
      out.push(b);
    } else if (sa >= 0) {
      const f = sa / (sa - sb);
      out.push([a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])]);
    }
  }
  return out;
}

/** Is the point inside the ring? Ray cast in the local frame. */
function pointInRing(p: [number, number], ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

const COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];

/** Bearing in degrees true, and the compass name for it. */
export function bearingOf(d: [number, number]): { deg: number; name: string } {
  const deg = (((Math.atan2(d[0], d[1]) * 180) / Math.PI) + 360) % 360;
  return { deg: Math.round(deg), name: COMPASS[Math.round(deg / 45) % 8] };
}

export interface AreaFlight {
  flight: string;
  lat: number;
  lon: number;
}

/** Airspace a ceded slice must not contain — an active P or R area. */
export interface Blocker {
  ident: string;
  rings: Rings;
}

export interface TransferInput {
  from: { sector: string; rings: Rings; flights: AreaFlight[] };
  to: { sector: string; rings: Rings; flightCount: number };
  /** A sector is over capacity at or above this many aircraft in the hour. */
  splitAbove: number;
  blockers?: Blocker[];
  /** How far beyond the receiving sector's own centroid the ceded airspace may
   *  reach, in NM. A stand-in for surveillance and radio coverage. */
  maxCedeNm?: number;
}

export interface AreaTransfer {
  from: string;
  to: string;
  /** The aircraft that move with the airspace. */
  flights: string[];
  /** Counts after the change. */
  fromAfter: number;
  toAfter: number;
  /** Where the ceded slice lies, seen from the overloaded sector. */
  bearingDeg: number;
  quadrant: string;
  areaNm2: number;
  /** The ceded slice, ready to draw. */
  boundary: LatLon[];
}

export type TransferResult =
  | { ok: true; transfer: AreaTransfer }
  | { ok: false; reason: string };

/**
 * Work out the slice of `from` that should pass to `to`, or say why none can.
 *
 * `splitAbove` is read as a ceiling on what one position may hold, so the cut
 * aims to leave the overloaded sector at `splitAbove - 1` — the least airspace
 * that resolves the overload. Moving more would be tidier to compute and worse
 * to work: every mile of boundary moved is a handover to re-brief.
 */
export function planAreaTransfer(input: TransferInput): TransferResult {
  const { from, to, splitAbove } = input;
  const load = from.flights.length;
  if (load < splitAbove) return { ok: false, reason: "not over capacity" };

  const need = load - (splitAbove - 1);
  if (need <= 0) return { ok: false, reason: "nothing to move" };
  if (need > load) return { ok: false, reason: "nothing to move" };

  const after = to.flightCount + need;
  if (after >= splitAbove) {
    return {
      ok: false,
      reason:
        to.sector + " would reach " + after + " — the overload would move, not clear",
    };
  }

  const origin = centroidOf(from.rings);
  const target = centroidOf(to.rings);
  const [tx, ty] = toLocalNm(origin, target);
  const len = Math.hypot(tx, ty);
  if (len === 0) return { ok: false, reason: "sectors share a centroid" };
  const d: [number, number] = [tx / len, ty / len];

  // Project the traffic onto the axis and take the `need` aircraft nearest the
  // receiving sector: those are the ones the slice will contain.
  const projected = from.flights
    .map((f) => ({ f, p: (([x, y]) => x * d[0] + y * d[1])(toLocalNm(origin, f)) }))
    .sort((a, b) => b.p - a.p);
  const moving = projected.slice(0, need);
  const staying = projected.slice(need);

  // The cut sits between the last aircraft that moves and the first that stays,
  // so neither is on a boundary it could drift across.
  const lastMoving = moving[moving.length - 1].p;
  const firstStaying = staying.length > 0 ? staying[0].p : lastMoving - 10;
  const t = (lastMoving + firstStaying) / 2;

  const slices = from.rings
    .map((ring) => clipHalfPlane(ring.map((p) => toLocalNm(origin, p)), d, t))
    .filter((r) => r.length >= 3);
  if (slices.length === 0) return { ok: false, reason: "the cut leaves no area" };

  // The largest piece is the slice; a sector split across islands would cede
  // the main one.
  const slice = slices.reduce((best, r) =>
    Math.abs(shoelace(r)) > Math.abs(shoelace(best)) ? r : best,
  );
  const areaNm2 = Math.abs(shoelace(slice));
  if (areaNm2 < 1) return { ok: false, reason: "the cut leaves no area" };

  const boundary = slice.map((xy) => fromLocalNm(origin, xy));

  // Reach: the far corner of the slice, measured from the receiving sector.
  if (input.maxCedeNm !== undefined) {
    const reach = Math.max(
      ...boundary.map((p) => {
        const [x, y] = toLocalNm(target, p);
        return Math.hypot(x, y);
      }),
    );
    if (reach > input.maxCedeNm) {
      return {
        ok: false,
        reason:
          "the slice reaches " +
          Math.round(reach) +
          " NM from " +
          to.sector +
          ", beyond the " +
          input.maxCedeNm +
          " NM coverage limit",
      };
    }
  }

  // Restricted airspace inside the slice.
  for (const b of input.blockers ?? []) {
    const hit = b.rings.some((ring) =>
      ring.some((p) => pointInRing(toLocalNm(origin, p), slice)),
    );
    if (hit) {
      return {
        ok: false,
        reason: "the slice would contain " + b.ident + ", which is active",
      };
    }
  }

  const bearing = bearingOf(d);
  return {
    ok: true,
    transfer: {
      from: from.sector,
      to: to.sector,
      flights: moving.map((m) => m.f.flight).sort(),
      fromAfter: load - need,
      toAfter: after,
      bearingDeg: bearing.deg,
      quadrant: bearing.name,
      areaNm2: Math.round(areaNm2),
      boundary,
    },
  };
}
