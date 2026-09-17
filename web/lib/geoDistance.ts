/**
 * Great-circle distance between two lat/lon points, in nautical miles.
 *
 * Its own module rather than a helper inside LeafletMap because it is the one
 * piece of real arithmetic behind the Measure tool, and a number a controller
 * reads off the map should be testable without mounting a map to get at it.
 *
 * Spherical, on the same 3440.065 NM radius the map's other geodesy uses
 * (`destPoint` in LeafletMap). An ellipsoidal model would shift a 300 NM leg by
 * well under a tenth of a mile — far below the 0.1 NM the readout shows, and
 * far below the accuracy of the simulated positions being measured.
 */

/** Earth radius in nautical miles. */
const EARTH_R_NM = 3440.065;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

export interface LatLon {
  lat: number;
  lon: number;
}

/**
 * Haversine, not the spherical law of cosines: the two agree to the digit at
 * any distance worth measuring, but cosines loses precision on the short legs
 * — two aircraft a mile apart — which is exactly where this is used.
 */
export function greatCircleNm(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}
