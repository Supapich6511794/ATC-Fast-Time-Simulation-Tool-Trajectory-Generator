/**
 * Loss-of-separation marks for the trajectory EXPORT.
 *
 * A downloaded trajectory is a flight's 4D record; if that flight still has an
 * unresolved conflict, the file has to say so — and say WHEN. This turns the
 * strategic plan scan into per-flight, per-timestamp marks: for every conflict
 * the controller has NOT fixed, both aircraft get the UTC window in which they
 * are below minima, plus who they lose it against and by how much.
 *
 * Only unresolved conflicts are marked. Once a resolution is applied the pair's
 * trajectory changes and the conflict is gone from the plan scan, so a re-export
 * carries no window for it — the file and the Dashboard always agree.
 *
 * Times are converted off the shared absolute clock (seconds from the earliest
 * departure) into real UTC timestamps, which is what the exported track rows
 * are keyed by.
 */

import type { CdrConfig } from "./config";
import { losWindows, type PlanConflict, type PlanFlight } from "./planScan";

/** One LOS window as sent to the API, in the export's own units. */
export interface LosSpan {
  /** The other aircraft in the pair. */
  with_callsign: string;
  with_flight_key: string;
  /** Inclusive UTC bounds of the breach ("YYYY-MM-DDTHH:MM:SSZ"). */
  start_ts: string;
  end_ts: string;
  /** Tightest gap reached inside the window. */
  min_sep_nm: number;
  min_vert_ft: number;
  /** The minima that were breached. */
  sep_min_nm: number;
  sep_min_ft: number;
}

/** Every LOS window one flight is involved in. */
export interface FlightLosMarks {
  flight_key: string;
  spans: LosSpan[];
}

/** Absolute clock seconds → UTC timestamp string, matching the export's
 *  `YYYY-MM-DDTHH:MM:SSZ` column format. */
function absToIso(originMs: number, absSec: number): string {
  return new Date(originMs + absSec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Build the per-flight LOS marks for `flightKeys` (every selected download).
 *
 * Flights with no unresolved conflict are still returned, with an empty span
 * list — that's what clears a stale mark from a file exported before the fix
 * was applied.
 */
export function buildLosMarks(
  flightKeys: string[],
  flights: PlanFlight[],
  conflicts: PlanConflict[],
  cfg: CdrConfig,
  originMs: number,
): FlightLosMarks[] {
  const byId = new Map(flights.map((f) => [f.id, f]));
  const spansByKey = new Map<string, LosSpan[]>(
    flightKeys.map((k) => [k, [] as LosSpan[]]),
  );

  for (const c of conflicts) {
    // Only pairs where at least one side is being exported are worth scanning —
    // the window computation walks the whole encounter.
    if (!spansByKey.has(c.a) && !spansByKey.has(c.b)) continue;
    const A = byId.get(c.a);
    const B = byId.get(c.b);
    if (!A || !B) continue;
    for (const w of losWindows(A, B, cfg)) {
      const start = absToIso(originMs, w.startAbsSec);
      const end = absToIso(originMs, w.endAbsSec);
      const common = {
        start_ts: start,
        end_ts: end,
        min_sep_nm: Math.round(w.minHNm * 100) / 100,
        min_vert_ft: Math.round(w.minVFt),
        sep_min_nm: w.shNm,
        sep_min_ft: w.svFt,
      };
      spansByKey
        .get(c.a)
        ?.push({ ...common, with_callsign: c.bCallsign, with_flight_key: c.b });
      spansByKey
        .get(c.b)
        ?.push({ ...common, with_callsign: c.aCallsign, with_flight_key: c.a });
    }
  }

  return flightKeys.map((k) => ({
    flight_key: k,
    spans: (spansByKey.get(k) ?? []).sort((x, y) =>
      x.start_ts.localeCompare(y.start_ts),
    ),
  }));
}
