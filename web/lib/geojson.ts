/**
 * Loader for the ONE real source file: `public/data/airway_waypoint.geojson`
 * (a copy of the user-provided `airway waypoint.geojson`).
 *
 * Nothing here is fabricated. Airways are returned exactly as they appear in
 * the file. Waypoints are *derived* — we read the real lat/lon already stored
 * in each segment's properties (`waypoint_*` and `waypoint_*_2`) and
 * de-duplicate by identifier. No coordinate is invented or guessed.
 */

import type {
  AirwayCollection,
  FirCollection,
  ProcedureLineCollection,
  ProcedureWaypointCollection,
  Waypoint,
} from "./types";

const SOURCE_URL = "/data/airway_waypoint.geojson";
const FIR_URL = "/data/fir.geojson";
const SID_LINES_URL = "/data/sid/sid_line_thai.geojson";
const STAR_LINES_URL = "/data/star/star_line.geojson";
const SID_WPTS_URL = "/data/sid/sid_waypoint_thai.geojson";
const STAR_WPTS_URL = "/data/star/star_waypoint.geojson";

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "force-cache" });
  if (!res.ok) {
    throw new Error(`Failed to load ${url}: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

/** Fetch SID procedure waypoints (the coded fixes). Loaded lazily. */
export function fetchSidWaypoints(): Promise<ProcedureWaypointCollection> {
  return fetchJson<ProcedureWaypointCollection>(SID_WPTS_URL);
}

/** Fetch STAR procedure waypoints (the coded fixes). Loaded lazily. */
export function fetchStarWaypoints(): Promise<ProcedureWaypointCollection> {
  return fetchJson<ProcedureWaypointCollection>(STAR_WPTS_URL);
}

// Memoised airport -> distinct SID/STAR procedure names, derived from the
// bundled procedure-waypoint GeoJSON (same source the engine indexes). Built
// once, only when the offline fallback below is first needed.
let _procNameIndex:
  | Promise<Map<string, { SID: Set<string>; STAR: Set<string> }>>
  | null = null;

function buildProcedureNameIndex(): Promise<
  Map<string, { SID: Set<string>; STAR: Set<string> }>
> {
  if (!_procNameIndex) {
    _procNameIndex = Promise.all([fetchSidWaypoints(), fetchStarWaypoints()])
      .then(([sid, star]) => {
        const m = new Map<string, { SID: Set<string>; STAR: Set<string> }>();
        const add = (
          fc: ProcedureWaypointCollection,
          kind: "SID" | "STAR",
        ) => {
          for (const f of fc.features) {
            const a = f.properties.airport_identifier;
            const n = f.properties.procedure_identifier;
            if (!a || !n) continue;
            let e = m.get(a);
            if (!e) {
              e = { SID: new Set(), STAR: new Set() };
              m.set(a, e);
            }
            e[kind].add(n);
          }
        };
        add(sid, "SID");
        add(star, "STAR");
        return m;
      })
      .catch(() => {
        _procNameIndex = null; // let a later call retry the fetch
        return new Map();
      });
  }
  return _procNameIndex;
}

/**
 * Offline fallback for the SID/STAR picker: the procedure NAMES published at
 * an aerodrome, derived from the statically-bundled procedure-waypoint
 * GeoJSON (no backend). Used by `listProcedures` when the engine API is
 * unreachable so the dropdowns still populate; the resolved leg geometry
 * (preview / generate) still needs the API.
 */
export async function staticProcedureNames(
  airport: string,
): Promise<{ SID: string[]; STAR: string[] }> {
  const code = airport.trim().toUpperCase();
  if (!code) return { SID: [], STAR: [] };
  const idx = await buildProcedureNameIndex();
  const e = idx.get(code);
  return {
    SID: e ? [...e.SID].sort() : [],
    STAR: e ? [...e.STAR].sort() : [],
  };
}

/**
 * Fetch the drawn SID (departure) procedure tracks. Loaded lazily when the
 * user enables the SID layer — these are the DFD `*_line` exports, just the
 * polylines (the coded legs + constraints come from the procedures API).
 */
export async function fetchSidLines(): Promise<ProcedureLineCollection> {
  const res = await fetch(SID_LINES_URL, { cache: "force-cache" });
  if (!res.ok) {
    throw new Error(
      `Failed to load ${SID_LINES_URL}: ${res.status} ${res.statusText}`,
    );
  }
  return (await res.json()) as ProcedureLineCollection;
}

/** Fetch the drawn STAR (arrival) procedure tracks. Loaded lazily. */
export async function fetchStarLines(): Promise<ProcedureLineCollection> {
  const res = await fetch(STAR_LINES_URL, { cache: "force-cache" });
  if (!res.ok) {
    throw new Error(
      `Failed to load ${STAR_LINES_URL}: ${res.status} ${res.statusText}`,
    );
  }
  return (await res.json()) as ProcedureLineCollection;
}

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
