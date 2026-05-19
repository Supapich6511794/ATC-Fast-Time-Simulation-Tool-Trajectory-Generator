/**
 * Loader for the ONE real source file: `public/data/airway_waypoint.geojson`
 * (a copy of the user-provided `airway waypoint.geojson`).
 *
 * Nothing here is fabricated. Airways are returned exactly as they appear in
 * the file. Waypoints are *derived* — we read the real lat/lon already stored
 * in each segment's properties (`waypoint_*` and `waypoint_*_2`) and
 * de-duplicate by identifier. No coordinate is invented or guessed.
 */

import type { AirwayCollection, FirCollection, Waypoint } from "./types";

const SOURCE_URL = "/data/airway_waypoint.geojson";
const FIR_URL = "/data/fir.geojson";

/**
 * Fetch worldwide FIR boundaries. This file is large (~15 MB), so callers
 * should only invoke it lazily (when the user enables the FIR layer), not
 * on initial page load.
 */
export async function fetchFir(): Promise<FirCollection> {
  const res = await fetch(FIR_URL, { cache: "force-cache" });
  if (!res.ok) {
    throw new Error(
      `Failed to load ${FIR_URL}: ${res.status} ${res.statusText}`,
    );
  }
  return (await res.json()) as FirCollection;
}

/** Fetch the raw airway-segment FeatureCollection from the source file. */
export async function fetchAirways(): Promise<AirwayCollection> {
  const res = await fetch(SOURCE_URL, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(
      `Failed to load ${SOURCE_URL}: ${res.status} ${res.statusText}`,
    );
  }
  return (await res.json()) as AirwayCollection;
}

/**
 * Build the unique waypoint list straight from the file's own coordinates.
 *
 * Each segment names two endpoints; we collect both, keyed by identifier,
 * and record which airways each waypoint lies on. The first coordinate seen
 * for an identifier wins (the file is internally consistent for a given
 * fix, so duplicates carry the same lat/lon).
 */
export function deriveWaypoints(airways: AirwayCollection): Waypoint[] {
  const byIdent = new Map<string, Waypoint>();

  for (const feature of airways.features) {
    const p = feature.properties;

    // Two endpoints per segment, both with real coords from the file.
    const endpoints: Array<[string, number, number]> = [
      [p.waypoint_identifier, p.waypoint_latitude, p.waypoint_longitude],
      [p.waypoint_identifier_2, p.waypoint_latitude_2, p.waypoint_longitude_2],
    ];

    for (const [ident, lat, lon] of endpoints) {
      if (!ident || lat == null || lon == null) continue;
      const existing = byIdent.get(ident);
      if (existing) {
        if (!existing.airways.includes(p.route_identifier)) {
          existing.airways.push(p.route_identifier);
        }
      } else {
        byIdent.set(ident, {
          ident,
          lat,
          lon,
          airways: [p.route_identifier],
        });
      }
    }
  }

  return [...byIdent.values()].sort((a, b) => a.ident.localeCompare(b.ident));
}
