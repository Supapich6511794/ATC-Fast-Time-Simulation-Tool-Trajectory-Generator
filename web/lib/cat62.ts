/**
 * cat62 — client helpers for flight-time validation of candidate routes.
 *
 * Two pieces, both served by the API so the client can never disagree with
 * the server about what a flight "should" take:
 *
 *   * the reference table (GET /api/cat62_reference) — real CAT62 times per
 *     city pair, plus the acceptance threshold;
 *   * a distance→time curve for ONE airframe at ONE cruise level
 *     (GET /api/flight_time_curve) — interpolated locally so the route picker
 *     can tag every candidate PASS/FAIL without a round-trip per route.
 *
 * The curve used to be a hard-coded table in this file, measured on a B738
 * to RFL350 and applied to every airframe. That graded turboprops against a
 * 737: a 285 NM ATR 72 leg simulated at 70 min was scored against a 49 min
 * "reference" and reported FAIL although the simulation was correct. The
 * curve now comes from the aircraft's own Thai APM performance, and an
 * airframe with no Thai APM data of its own returns `supported: false`
 * rather than a 737 curve wearing its name — so there is nothing left here
 * to fall back to.
 */

import { API_BASE } from "@/lib/api";

export interface Cat62Table {
  thresholdMin: number;
  /** "ADEP-ADES" → reference minutes (direction-agnostic on lookup). */
  routes: Record<string, number>;
  /** ICAO types a flight-time estimate can be derived for. */
  estimatorTypes: ReadonlySet<string>;
  /** Label of the performance dataset behind those estimates. */
  performanceSource: string;
}

let _cache: Promise<Cat62Table> | null = null;

export function fetchCat62Reference(): Promise<Cat62Table> {
  if (!_cache) {
    _cache = fetch(`${API_BASE}/api/cat62_reference`, { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(`cat62_reference ${r.status}`);
        return r.json();
      })
      .then(
        (j): Cat62Table => ({
          thresholdMin: Number(j.threshold_min ?? 5),
          routes: (j.routes ?? {}) as Record<string, number>,
          estimatorTypes: new Set<string>(
            (j.estimator_types ?? []) as string[],
          ),
          performanceSource: String(j.performance_source ?? ""),
        }),
      )
      .catch(() => ({
        thresholdMin: 5,
        routes: {},
        estimatorTypes: new Set<string>(),
        performanceSource: "",
      }));
  }
  return _cache;
}

/** Reference minutes for a pair (either direction), or null if absent. */
export function lookupReferenceMin(
  table: Cat62Table,
  adep: string,
  ades: string,
): number | null {
  const a = adep.trim().toUpperCase();
  const b = ades.trim().toUpperCase();
  return table.routes[`${a}-${b}`] ?? table.routes[`${b}-${a}`] ?? null;
}

// --- Aircraft-specific flight-time curve ----------------------------------

/** A distance→time curve for one airframe at one cruise level. */
export interface FlightTimeCurve {
  aircraftType: string;
  /** Sampled [distanceNm, minutes] pairs, ascending by distance. */
  points: ReadonlyArray<readonly [number, number]>;
  /** Terminal-area margin the server adds to turn a prediction into a
   *  reference time. */
  marginMin: number;
  /** Performance dataset the curve was derived from. */
  dataset: string;
}

/** Why no curve is available for a type — surfaced instead of guessing. */
export interface UnsupportedCurve {
  aircraftType: string;
  reason: string;
}

export type FlightTimeCurveResult = FlightTimeCurve | UnsupportedCurve;

export function isSupportedCurve(
  c: FlightTimeCurveResult | null,
): c is FlightTimeCurve {
  return c != null && "points" in c && c.points.length > 0;
}

/** Fetch the curve for one airframe + cruise level.
 *
 *  `cruiseAltFt` is the planned level; the server clamps it to the type's
 *  reachable ceiling. Pass null to get the curve at that ceiling.
 */
export function fetchFlightTimeCurve(
  aircraftType: string,
  cruiseAltFt: number | null,
): Promise<FlightTimeCurveResult> {
  const ac = aircraftType.trim().toUpperCase();
  const qs = new URLSearchParams({ actype: ac });
  if (cruiseAltFt != null) qs.set("cruise_alt_ft", String(cruiseAltFt));
  return fetch(`${API_BASE}/api/flight_time_curve?${qs}`, {
    cache: "no-store",
  })
    .then((r) => {
      if (!r.ok) throw new Error(`flight_time_curve ${r.status}`);
      return r.json();
    })
    .then((j): FlightTimeCurveResult => {
      if (!j.supported) {
        return {
          aircraftType: ac,
          reason: String(j.reason ?? "no performance data for this type"),
        };
      }
      return {
        aircraftType: String(j.aircraft_type ?? ac),
        points: (j.points ?? []) as ReadonlyArray<readonly [number, number]>,
        marginMin: Number(j.margin_min ?? 3),
        dataset: String(j.dataset ?? ""),
      };
    })
    .catch((e): UnsupportedCurve => ({ aircraftType: ac, reason: String(e) }));
}

/** Predicted simulated flight time (minutes) for a route distance —
 *  piecewise-linear interpolation of the airframe's own curve, extrapolating
 *  along the final segment beyond the table. */
export function estimateSimMin(
  curve: FlightTimeCurve,
  distanceNm: number,
): number {
  const t = curve.points;
  const d = Math.max(0, distanceNm);
  if (t.length === 0) return 0;
  if (t.length === 1 || d <= t[0][0]) return t[0][1];
  for (let i = 0; i < t.length - 1; i++) {
    const [d0, t0] = t[i];
    const [d1, t1] = t[i + 1];
    if (d <= d1) return t0 + ((t1 - t0) * (d - d0)) / (d1 - d0);
  }
  const [d0, t0] = t[t.length - 2];
  const [d1, t1] = t[t.length - 1];
  return t1 + ((t1 - t0) / (d1 - d0)) * (d - d1);
}

/** Reference estimate (minutes) for a pair with no real CAT62 sample —
 *  the predicted sim time plus the server's terminal margin. */
export function estimateReferenceMin(
  curve: FlightTimeCurve,
  distanceNm: number,
): number {
  return estimateSimMin(curve, distanceNm) + curve.marginMin;
}
