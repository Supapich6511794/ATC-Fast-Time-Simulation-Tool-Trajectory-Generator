/**
 * Local planar frame for CD&R geometry.
 *
 * Conflict math (CPA, collision cones) must run in a Cartesian frame, not on
 * raw lat/lon degrees — a degree of longitude is only ~cos(lat) as long as a
 * degree of latitude, so treating them as equal skews every angle and distance.
 * We project onto a local East-North-Up (ENU) tangent plane centred on the
 * traffic, with axes in NAUTICAL MILES: x = East, y = North. Over the ~200 NM /
 * ≤10 min scale a conflict look-ahead covers, the equirectangular tangent plane
 * is accurate to well under the sub-NM detail that matters here.
 *
 * Everything downstream (cpa.ts, detect.ts, collisionCone.ts) works purely in
 * this frame; only the map overlay converts CPA/track points back to lat/lon.
 */

/** One nautical mile per degree of latitude (60 NM/°). */
const NM_PER_DEG_LAT = 60;

/** A 2-D vector in the local ENU frame, NM. */
export interface Vec2 {
  x: number; // East (NM)
  y: number; // North (NM)
}

/** The projection origin — pick it near the traffic so distortion stays tiny. */
export interface EnuFrame {
  lat0: number;
  lon0: number;
  /** cos(lat0), cached: NM per degree of longitude at the origin latitude. */
  nmPerDegLon: number;
}

/** Build an ENU frame anchored at a reference lat/lon (typically the centroid
 *  of the aircraft under test). */
export function makeFrame(lat0: number, lon0: number): EnuFrame {
  return {
    lat0,
    lon0,
    nmPerDegLon: Math.cos((lat0 * Math.PI) / 180) * NM_PER_DEG_LAT,
  };
}

/** Centroid frame for a set of lat/lon points (mean lat, mean lon). Falls back
 *  to (0,0) for an empty set. */
export function frameFor(points: { lat: number; lon: number }[]): EnuFrame {
  if (points.length === 0) return makeFrame(0, 0);
  let sLat = 0;
  let sLon = 0;
  for (const p of points) {
    sLat += p.lat;
    sLon += p.lon;
  }
  return makeFrame(sLat / points.length, sLon / points.length);
}

/** Project lat/lon → ENU (NM). */
export function toEnu(frame: EnuFrame, lat: number, lon: number): Vec2 {
  return {
    x: (lon - frame.lon0) * frame.nmPerDegLon,
    y: (lat - frame.lat0) * NM_PER_DEG_LAT,
  };
}

/** Inverse: ENU (NM) → lat/lon. Used by the map overlay to place CPA markers
 *  and predicted-track points back on the globe. */
export function toLatLon(frame: EnuFrame, v: Vec2): { lat: number; lon: number } {
  return {
    lat: frame.lat0 + v.y / NM_PER_DEG_LAT,
    lon: frame.lon0 + v.x / (frame.nmPerDegLon || 1e-9),
  };
}

/** Ground-velocity vector (NM/s) from ground speed (kt) and track (° clockwise
 *  from north). East = gs·sin(track), North = gs·cos(track); kt → NM/s via /3600. */
export function velocityFromGsTrack(gsKt: number, trackDeg: number): Vec2 {
  const nmPerSec = gsKt / 3600;
  const r = (trackDeg * Math.PI) / 180;
  return { x: nmPerSec * Math.sin(r), y: nmPerSec * Math.cos(r) };
}

/** Track (° clockwise from north, 0–360) of a velocity vector. */
export function trackOf(v: Vec2): number {
  const deg = (Math.atan2(v.x, v.y) * 180) / Math.PI;
  return (deg + 360) % 360;
}

// --- small vector algebra (all NM / NM-per-sec) ---------------------------
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const scale = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const mag = (a: Vec2): number => Math.hypot(a.x, a.y);
export const mag2 = (a: Vec2): number => a.x * a.x + a.y * a.y;

/** Rotate a vector by `deg` (positive = counter-clockwise in the x-y plane). */
export function rotate(v: Vec2, deg: number): Vec2 {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/** Signed smallest angle (deg, −180…180) to rotate heading `fromDeg` onto
 *  `toDeg`. Positive = clockwise (a right turn in compass terms). */
export function headingDeltaDeg(fromDeg: number, toDeg: number): number {
  return ((toDeg - fromDeg + 540) % 360) - 180;
}
