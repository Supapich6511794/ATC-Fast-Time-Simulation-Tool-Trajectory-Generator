/** Shared types for the in-browser Phase 1 trajectory generator. */

/** Flight phase along the vertical profile (mirrors performance.Phase). */
export type Phase = "climb" | "cruise" | "descent";

/** One ordered point on a resolved route (lat/lon in WGS-84 degrees). */
export interface RouteWaypoint {
  ident: string;
  lat: number;
  lon: number;
}

/** One emitted trajectory sample (matches the Python output schema). */
export interface TrajectoryPoint {
  lat: number;
  lon: number;
  /** ISO-8601 UTC timestamp. */
  epoch_ts: string;
  /** Altitude in feet (Phase 2). Null when no vertical profile applied. */
  altitude_ft: number | null;
  gs_kt: number;
  track_deg: number;
  phase: Phase;
}

/** Summary metrics shown to the user after generation. */
export interface TrajectoryStats {
  waypointCount: number;
  pointCount: number;
  distanceNm: number;
  timeMinutes: number;
  /** Cruise altitude actually reached (feet). May be less than the
   *  requested FL when the leg is too short to climb that high. */
  cruiseAltFt: number | null;
  /** Requested Flight Level expressed in feet (FL330 → 33000). */
  rflFt: number;
}

/** Top-of-Climb or Top-of-Descent marker — null when the flight never
 *  reaches cruise altitude (too-short leg). */
export interface ProfilePoint {
  lat: number;
  lon: number;
  altitudeFt: number;
  epochTs: string;
}

/** Vertical-profile waypoints surfaced for map markers + chart. */
export interface VerticalProfileMeta {
  toc: ProfilePoint | null;
  tod: ProfilePoint | null;
}

/** Full result of a generation run. */
export interface TrajectoryResult {
  /** Resolved route used (for map markers + listing). */
  route: RouteWaypoint[];
  /** Interpolated samples. */
  points: TrajectoryPoint[];
  stats: TrajectoryStats;
  /** Vertical-profile waypoints (TOC/TOD), null until a profile is built. */
  profile: VerticalProfileMeta;
  /** Metadata echoed into exports. */
  meta: {
    flightKey: string;
    callsign: string;
    aircraftType: string;
    adep: string;
    ades: string;
    eobtIso: string;
  };
}
