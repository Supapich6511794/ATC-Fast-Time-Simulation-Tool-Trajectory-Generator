/**
 * aip — client loader for the CAAT eAIP navdata cache.
 *
 * The cache (`/data/aip_VT.json`) is produced once per AIRAC cycle by
 * `scripts/ingest_aip.py`. It replaces the old hand-curated
 * `VTPStoVTBS.csv` as the source of waypoint coordinates and airway
 * sequences for the route picker + best-route ranker.
 *
 * Shape:
 *   {
 *     airac: "2026-05-14",
 *     waypoints: { VANKO: { lat, lon }, ... },
 *     airways:   { Y8: ["BKK","MOTNA",...], ... }
 *   }
 */

const AIP_URL = "/data/aip_VT.json";

export interface AipAirport {
  lat: number;
  lon: number;
  elev_ft?: number;
  name?: string;
}

export interface AipData {
  airac: string;
  waypoints: Record<string, { lat: number; lon: number }>;
  airways: Record<string, string[]>;
  airports?: Record<string, AipAirport>;
}

export interface Fix {
  ident: string;
  lat: number;
  lon: number;
}

export interface AirportOption {
  code: string;
  name: string;
  lat: number;
  lon: number;
}

let _cache: Promise<AipData> | null = null;

/** Fetch + memoise the AIP cache for the page's lifetime. */
export function fetchAip(): Promise<AipData> {
  if (!_cache) {
    _cache = fetch(AIP_URL, { cache: "no-store" }).then((res) => {
      if (!res.ok) throw new Error(`Failed to load ${AIP_URL}: ${res.status}`);
      return res.json() as Promise<AipData>;
    });
  }
  return _cache;
}

/** All significant points / navaids with coords (340+ fixes). */
export async function fetchAllFixes(): Promise<Fix[]> {
  const aip = await fetchAip();
  const out: Fix[] = [];
  for (const [ident, w] of Object.entries(aip.waypoints)) {
    if (Number.isFinite(w.lat) && Number.isFinite(w.lon)) {
      out.push({ ident, lat: w.lat, lon: w.lon });
    }
  }
  return out;
}

/** designator → ordered ident sequence, for every published airway. */
export async function fetchAirwaysMap(): Promise<Record<string, string[]>> {
  const aip = await fetchAip();
  return aip.airways ?? {};
}

/** Aerodromes from the AIP AD section, sorted by ICAO. Empty when the
 *  cache predates aerodrome ingestion. */
export async function fetchAirports(): Promise<AirportOption[]> {
  const aip = await fetchAip();
  const airports = aip.airports ?? {};
  return Object.entries(airports)
    .map(([code, a]) => ({
      code,
      name: a.name ?? code,
      lat: a.lat,
      lon: a.lon,
    }))
    .sort((a, b) => a.code.localeCompare(b.code));
}
