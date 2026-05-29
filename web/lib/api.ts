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
  /** 0-based index when several routes share (callsign, EOBT). Server
   *  suffixes the flight_key/filename with `_R{n+1}` to keep files
   *  distinct without mangling the user's callsign. */
  flight_index?: number;
  /** Optional Phase-3 speed-schedule overrides for tuning toward the
   *  CAT62 reference time. Omitted fields keep the airframe default. */
  climb_cas_kt?: number;
  climb_mach?: number;
  cruise_mach?: number;
  descent_mach?: number;
  descent_cas_kt?: number;
  restrict_cas_kt?: number;
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
    cruise_alt_ft: number | null;
    rfl_ft: number;
  };
  profile: {
    toc: {
      lat: number;
      lon: number;
      altitude_ft: number;
      epoch_ts: string;
    } | null;
    tod: {
      lat: number;
      lon: number;
      altitude_ft: number;
      epoch_ts: string;
    } | null;
    speed_schedule?: {
      climb_cas_kt: number;
      climb_mach: number;
      cruise_mach: number;
      descent_mach: number;
      descent_cas_kt: number;
      crossover_ft: number;
      below_fl100_restriction_kt: number;
    };
    phase_breakdown?: {
      climb: { avg_tas_kt: number | null; avg_gs_kt: number | null; time_min: number | null };
      cruise: { avg_tas_kt: number | null; avg_gs_kt: number | null; time_min: number | null };
      descent: { avg_tas_kt: number | null; avg_gs_kt: number | null; time_min: number | null };
    };
  };
  validation: {
    route: string;
    cat62_min: number;
    simulated_min: number;
    delta_min: number;
    threshold_min: number;
    status: "PASS" | "FAIL";
    passed: boolean;
    source: "cat62" | "estimate";
  } | null;
  route: RouteWaypoint[];
  points: {
    lat: number;
    lon: number;
    epoch_ts: string;
    altitude_ft: number | null;
    gs_kt: number;
    tas_kt?: number | null;
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
      cruiseAltFt: p.stats.cruise_alt_ft,
      rflFt: p.stats.rfl_ft,
    },
    profile: {
      toc: p.profile.toc
        ? {
            lat: p.profile.toc.lat,
            lon: p.profile.toc.lon,
            altitudeFt: p.profile.toc.altitude_ft,
            epochTs: p.profile.toc.epoch_ts,
          }
        : null,
      tod: p.profile.tod
        ? {
            lat: p.profile.tod.lat,
            lon: p.profile.tod.lon,
            altitudeFt: p.profile.tod.altitude_ft,
            epochTs: p.profile.tod.epoch_ts,
          }
        : null,
      speedSchedule: p.profile.speed_schedule
        ? {
            climbCasKt: p.profile.speed_schedule.climb_cas_kt,
            climbMach: p.profile.speed_schedule.climb_mach,
            cruiseMach: p.profile.speed_schedule.cruise_mach,
            descentMach: p.profile.speed_schedule.descent_mach,
            descentCasKt: p.profile.speed_schedule.descent_cas_kt,
            crossoverFt: p.profile.speed_schedule.crossover_ft,
            belowFl100RestrictionKt:
              p.profile.speed_schedule.below_fl100_restriction_kt,
          }
        : undefined,
      phaseBreakdown: p.profile.phase_breakdown
        ? {
            climb: {
              avgTasKt: p.profile.phase_breakdown.climb.avg_tas_kt,
              avgGsKt: p.profile.phase_breakdown.climb.avg_gs_kt,
              timeMin: p.profile.phase_breakdown.climb.time_min,
            },
            cruise: {
              avgTasKt: p.profile.phase_breakdown.cruise.avg_tas_kt,
              avgGsKt: p.profile.phase_breakdown.cruise.avg_gs_kt,
              timeMin: p.profile.phase_breakdown.cruise.time_min,
            },
            descent: {
              avgTasKt: p.profile.phase_breakdown.descent.avg_tas_kt,
              avgGsKt: p.profile.phase_breakdown.descent.avg_gs_kt,
              timeMin: p.profile.phase_breakdown.descent.time_min,
            },
          }
        : undefined,
    },
    validation: p.validation
      ? {
          route: p.validation.route,
          cat62Min: p.validation.cat62_min,
          simulatedMin: p.validation.simulated_min,
          deltaMin: p.validation.delta_min,
          thresholdMin: p.validation.threshold_min,
          status: p.validation.status,
          passed: p.validation.passed,
          source: p.validation.source,
        }
      : null,
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
