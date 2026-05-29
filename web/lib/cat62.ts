/**
 * cat62 — client helpers for flight-time validation of candidate routes.
 *
 * Fetches the reference table once (GET /api/cat62_reference) and exposes
 * a cheap distance→time predictor so the route picker can tag each
 * candidate PASS/FAIL against the city-pair reference without running the
 * full server timeline per route.
 */

import { API_BASE } from "@/lib/api";

export interface Cat62Table {
  thresholdMin: number;
  /** "ADEP-ADES" → reference minutes (direction-agnostic on lookup). */
  routes: Record<string, number>;
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
        }),
      )
      .catch(() => ({ thresholdMin: 5, routes: {} }));
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

// Measured simulated-time (min) vs distance (NM) for a B738 to RFL350 —
// mirrors trajectory_sim.validation._SIM_TIME_TABLE so the client's
// PASS/FAIL prediction matches what the server will actually compute.
// Calibrated against the real BADA 3.16 (ISA+20) model; re-measure if the
// server's BADA dataset/offset changes. A single affine fit overshoots
// short hops that never reach cruise (a 51 NM leg is ~9 min, not ~14), so
// we interpolate this curve.
const SIM_TIME_TABLE: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [20, 3.7], [40, 7.4], [60, 11.0], [80, 14.6], [100, 18.2],
  [130, 23.1], [160, 27.9], [200, 34.0], [260, 42.6], [320, 50.6],
  [400, 61.3], [500, 74.7], [650, 94.7], [800, 114.7], [1000, 141.4],
  [1300, 181.4],
];
const REF_MARGIN_MIN = 3.0;

/** Predicted simulated flight time (minutes) for a route distance —
 *  piecewise-linear interpolation of the measured curve. */
export function estimateSimMin(distanceNm: number): number {
  const t = SIM_TIME_TABLE;
  const d = Math.max(0, distanceNm);
  if (d <= t[0][0]) return t[0][1];
  for (let i = 0; i < t.length - 1; i++) {
    const [d0, t0] = t[i];
    const [d1, t1] = t[i + 1];
    if (d <= d1) return t0 + ((t1 - t0) * (d - d0)) / (d1 - d0);
  }
  const [d0, t0] = t[t.length - 2];
  const [d1, t1] = t[t.length - 1];
  return t1 + ((t1 - t0) / (d1 - d0)) * (d - d1);
}

/** Distance-based reference estimate (minutes) for a pair with no real
 *  CAT62 sample — the predicted sim time plus a small terminal margin. */
export function estimateReferenceMin(distanceNm: number): number {
  return estimateSimMin(distanceNm) + REF_MARGIN_MIN;
}
