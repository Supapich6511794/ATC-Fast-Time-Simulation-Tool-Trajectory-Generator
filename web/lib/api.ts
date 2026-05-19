/**
 * Client for the Python FastAPI server (the REAL trajectory_sim engine).
 *
 * The web no longer computes trajectories itself — it POSTs the form inputs
 * here and the Python package does route parsing, pyproj/WGS-84 geodesy and
 * GeoPackage/CSV export. One engine, no duplicated logic.
 *
 * Base URL is overridable via NEXT_PUBLIC_API_BASE (defaults to the local
 * uvicorn dev server).
 */

import type {
  Phase,
  RouteWaypoint,
  TrajectoryResult,
} from "@/lib/trajectory/types";

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

export interface GenerateInput {
  source: "csv" | "fpl";
  vtsp_to_vtbs: boolean;
  /** Departure / destination ICAO — drive direction + meta server-side. */
  adep: string;
  ades: string;
  route: string;
  callsign: string;
  /** ISO local string from the datetime-local input (treated as UTC). */
  eobt: string;
  gs_kt: number;
  /** Requested Flight Level in hundreds of feet (FL330 → 330). */
  rfl: number;
}

export interface GenerateResponse {
  result: TrajectoryResult;
  warnings: string[];
  /** Absolute URLs to the Python-written export files. */
  downloads: { gpkg: string; csv: string; geojson: string };
}

/** Raw JSON shape returned by POST /api/generate. */
interface ApiPayload {
  flight_key: string;
  meta: {
    callsign: string;
    aircraft_type: string;
    adep: string;
    ades: string;
    eobt: string;
    engine: string;
  };
  stats: {
    waypoint_count: number;
    point_count: number;
    distance_nm: number;
    time_minutes: number;
  };
  route: RouteWaypoint[];
  points: {
    lat: number;
    lon: number;
    epoch_ts: string;
    altitude_ft: number | null;
    gs_kt: number;
    track_deg: number;
    phase: Phase;
  }[];
  warnings: string[];
  downloads: { gpkg: string; csv: string; geojson: string };
}

export async function generateTrajectory(
  input: GenerateInput,
): Promise<GenerateResponse> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch {
    throw new Error(
      `Cannot reach the Python API at ${API_BASE}. Is the FastAPI server ` +
        `running? (uvicorn api.server:app --port 8000)`,
    );
  }

  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j?.detail) detail = String(j.detail);
    } catch {
      /* keep status text */
    }
    throw new Error(detail);
  }

  const p = (await res.json()) as ApiPayload;

  // Map the Python payload onto the shared TrajectoryResult shape so the
  // map components are unchanged.
  const result: TrajectoryResult = {
    route: p.route,
    points: p.points,
    stats: {
      waypointCount: p.stats.waypoint_count,
      pointCount: p.stats.point_count,
      distanceNm: p.stats.distance_nm,
      timeMinutes: p.stats.time_minutes,
    },
    meta: {
      flightKey: p.flight_key,
      callsign: p.meta.callsign,
      aircraftType: p.meta.aircraft_type,
      adep: p.meta.adep,
      ades: p.meta.ades,
      eobtIso: p.meta.eobt,
    },
  };

  const abs = (u: string) => `${API_BASE}${u}`;
  return {
    result,
    warnings: p.warnings,
    downloads: {
      gpkg: abs(p.downloads.gpkg),
      csv: abs(p.downloads.csv),
      geojson: abs(p.downloads.geojson),
    },
  };
}
