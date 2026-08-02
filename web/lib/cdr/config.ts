/**
 * CD&R configuration — every ICAO separation minimum, detection buffer,
 * look-ahead horizon and resolution-cost weight in ONE place, each cited to
 * its source document. Nothing in the engine hard-codes a threshold; it all
 * flows from here so an operator can retune the tool for a different airspace
 * without touching the geometry.
 *
 * Sources:
 *  - ICAO Doc 4444 (PANS-ATM), Ch.5 "Separation Methods and Minima":
 *      · §5.4.1.2  horizontal (lateral/longitudinal) 5 NM en-route where radar
 *        permits; 3 NM in terminal areas with suitable radar/sensor coverage.
 *      · §5.3.2    vertical 1000 ft below FL290; 1000 ft FL290–FL410 in RVSM
 *        airspace; 2000 ft above FL410 (and non-RVSM above FL290).
 *  - ICAO Doc 4444 Ch.8 "ATS Surveillance Services" — STCA (Short-Term Conflict
 *    Alert) and MTCD (Medium-Term Conflict Detection) alerting concepts and the
 *    typical look-ahead split (STCA ~short/tactical; MTCD out to ~10–20 min).
 *  - ICAO Annex 2, Appendix 3 "Table of Cruising Levels" (semicircular rule):
 *    eastbound (track 000–179°) → odd thousands; westbound (180–359°) → even.
 *    Applied by the resolution engine's flight-level candidates.
 *
 * All distances are NAUTICAL MILES, altitudes/heights FEET, times SECONDS,
 * speeds KNOTS unless a field name says otherwise.
 */

/** RVSM band: 1000 ft vertical minimum applies between these levels inclusive;
 *  2000 ft applies above the top (Doc 4444 §5.3.2). Below the floor the minimum
 *  is likewise 1000 ft, so only the upper boundary changes the number. */
export const RVSM_TOP_FT = 41000; // FL410

/** Horizontal separation minima (NM), selectable per operating environment
 *  (Doc 4444 §5.4.1.2). "enroute" is the default for this Thai-FIR tool. */
export interface HorizontalMinima {
  enrouteNm: number;
  terminalNm: number;
}

/** Vertical separation minima (ft), split at the RVSM top (Doc 4444 §5.3.2). */
export interface VerticalMinima {
  belowRvsmTopFt: number; // ≤ FL410
  aboveRvsmTopFt: number; // > FL410
}

/** How much tighter than the hard minima an *advisory* fires (so controllers
 *  are warned, and resolutions are aimed, before the legal minimum is broken).
 *  Doc 4444 Ch.8 leaves the exact STCA/MTCD parameters to the ANSP; +1 NM /
 *  +300 ft is a common, conservative buffer and is fully configurable here. */
export interface DetectionBuffer {
  horizontalNm: number;
  verticalFt: number;
}

/** Severity look-ahead horizons (seconds). A predicted loss of separation is
 *  classified by how soon it happens (Doc 4444 Ch.8 alerting concept).
 *
 *  Doc 4444 does NOT fix a "resolve N minutes before CPA" number — real ATC
 *  acts proactively, and how early depends on speed, level, the maneuver type,
 *  traffic density, radar update rate and controller workload. A fast-time sim
 *  must therefore pick its OWN thresholds; this tool models the standard two
 *  proactive tiers plus the breached state:
 *   - LOS  : separation already lost now (t ≤ 0)              → too late; act
 *   - STCA : CPA within `stcaSec`  — the RESOLUTION tier      → issue the fix
 *   - MTCD : CPA within `mtcdSec`  — the PREDICTION tier      → start planning
 *  So a conflict first SURFACES with a suggested fix up to `mtcdSec` ahead
 *  (the tool never waits for the minimum to break), and ESCALATES to the
 *  urgent "issue the clearance now" alert once inside `stcaSec`.
 *  `mtcdSec` is also the overall detection window — pairs that cannot conflict
 *  within it are ignored. */
export interface LookaheadHorizons {
  stcaSec: number;
  mtcdSec: number;
  /** Time resolution (s) at which the real future trajectories are sampled for
   *  detection. Between samples each aircraft is treated as moving linearly, and
   *  the closest approach on that segment is solved exactly — so this trades
   *  turn-fidelity (finer = truer through tight turns) against per-tick cost, not
   *  detection correctness on straight legs. */
  stepSec: number;
}

/** Weights for the resolution-advisory cost function
 *  cost = w1·trackDev + w2·extraDist + w3·altChange + w4·typePenalty.
 *  Enroute type preference (lower is better): Speed < Flight Level < Heading < Route. */
export interface ResolutionWeights {
  trackDeviationPerDeg: number; // w1 — per degree of heading change
  extraDistancePerNm: number; // w2 — per extra NM flown
  altitudeChangePerThousandFt: number; // w3 — per 1000 ft level change
  typePenalty: Record<ManeuverType, number>; // w4 — fixed per maneuver kind
}

export type ManeuverType =
  | "heading"
  | "flightlevel"
  | "route"
  | "speed"
  | "hold";

export interface CdrConfig {
  horizontal: HorizontalMinima;
  vertical: VerticalMinima;
  buffer: DetectionBuffer;
  lookahead: LookaheadHorizons;
  weights: ResolutionWeights;
  /** Operating environment for the horizontal minimum. Overridable at runtime
   *  (e.g. inside a TMA) but defaults to en-route for this FIR-scale tool. */
  environment: "enroute" | "terminal";
  /** OPTIONAL position-dependent horizontal minimum (NM) — supplied at runtime
   *  so the minimum can vary with airspace (e.g. 3 NM inside the Bangkok TMA,
   *  5 NM elsewhere). When set it overrides the flat `environment` minimum.
   *  Not serialisable; injected via `configOverrides` from the map layer. */
  sepMinNmAt?: (lat: number, lon: number, altFt: number | null) => number;
  /** Consecutive clear ticks required before a conflict is declared RESOLVED —
   *  hysteresis that stops alerts flapping when a pair hovers near the buffer.
   *  (Lifecycle parameter; see lib/cdr/lifecycle.ts.) */
  resolveHysteresisTicks: number;
  /** Vertical rate (ft/min) assumed reachable for flight-level resolution
   *  candidates when checking a new level can be gained before the conflict
   *  window opens. Range per the brief; the min is used as the conservative
   *  "can we make it?" test, the max for the optimistic cost estimate. */
  climbDescentFpm: { min: number; max: number };
  /** Nominal bank angle (°) for a resolution turn — mirrors the smooth-turn
   *  model. Sets the turn radius (R = V²/(g·tanφ)) and rate, which in turn
   *  drive WHEN the turn must start so it clears the conflict. Standard ATC
   *  maneuvering bank is 25°. */
  bankAngleDeg: number;
  /** Safety buffer (s) added ahead of the kinematically-computed turn start, so
   *  the aircraft begins turning a little earlier than the theoretical latest
   *  point (10–20 s typical). */
  turnSafetyBufferSec: number;
}

/** The default ICAO Doc 4444 profile for the Bangkok FIR fast-time tool. Every
 *  value is overridable — pass a partial to `resolveConfig` to retune. */
export const DEFAULT_CDR_CONFIG: CdrConfig = {
  horizontal: { enrouteNm: 5, terminalNm: 3 }, // Doc 4444 §5.4.1.2
  vertical: { belowRvsmTopFt: 1000, aboveRvsmTopFt: 2000 }, // §5.3.2
  buffer: { horizontalNm: 1, verticalFt: 300 }, // Ch.8 advisory buffer (ANSP-set)
  // Resolution tier (STCA) ≤ 5 min, Prediction tier (MTCD) ≤ 10 min: the
  // proactive fast-time thresholds — surface a fix by 10 min, escalate to
  // "issue now" by 5 min. Doc 4444 Ch.8 leaves the exact numbers to the ANSP.
  lookahead: { stcaSec: 300, mtcdSec: 600, stepSec: 10 }, // 5 min / 10 min
  weights: {
    trackDeviationPerDeg: 1,
    extraDistancePerNm: 2,
    altitudeChangePerThousandFt: 3,
    // ENROUTE resolution priority: Speed > Level > Heading (> Route). Speed
    // control is least disruptive (keeps the aircraft on its route AND level,
    // just re-times it), a level change keeps the route, and a heading/direct
    // vector takes it off route — so speed is cheapest and lateral vectoring
    // dearest. (This drives the auto-suggestion order.)
    // A HOLD is a big, disruptive delay — offered mainly for arrival-merge
    // sequencing where speed/level/heading can't clear, so it's the dearest.
    typePenalty: { speed: 0, flightlevel: 10, heading: 20, route: 30, hold: 40 },
  },
  environment: "enroute",
  resolveHysteresisTicks: 5,
  climbDescentFpm: { min: 1000, max: 1500 },
  bankAngleDeg: 25,
  turnSafetyBufferSec: 15,
};

/** Merge a partial override onto the default profile (shallow-by-section, so
 *  callers can override just `environment` or just one minima block). */
export function resolveConfig(overrides?: DeepPartial<CdrConfig>): CdrConfig {
  const d = DEFAULT_CDR_CONFIG;
  if (!overrides) return d;
  return {
    horizontal: { ...d.horizontal, ...overrides.horizontal },
    vertical: { ...d.vertical, ...overrides.vertical },
    buffer: { ...d.buffer, ...overrides.buffer },
    lookahead: { ...d.lookahead, ...overrides.lookahead },
    weights: {
      ...d.weights,
      ...overrides.weights,
      typePenalty: {
        ...d.weights.typePenalty,
        ...overrides.weights?.typePenalty,
      },
    },
    environment: overrides.environment ?? d.environment,
    sepMinNmAt: overrides.sepMinNmAt ?? d.sepMinNmAt,
    resolveHysteresisTicks:
      overrides.resolveHysteresisTicks ?? d.resolveHysteresisTicks,
    climbDescentFpm: { ...d.climbDescentFpm, ...overrides.climbDescentFpm },
    bankAngleDeg: overrides.bankAngleDeg ?? d.bankAngleDeg,
    turnSafetyBufferSec: overrides.turnSafetyBufferSec ?? d.turnSafetyBufferSec,
  };
}

/** Horizontal minimum for the current environment (NM). */
export function horizontalMinimumNm(cfg: CdrConfig): number {
  return cfg.environment === "terminal"
    ? cfg.horizontal.terminalNm
    : cfg.horizontal.enrouteNm;
}

/** Horizontal minimum (NM) at a position — the runtime `sepMinNmAt` resolver
 *  when present (e.g. 3 NM in the Bangkok TMA), else the flat environment one. */
export function sepMinNmAtPos(
  cfg: CdrConfig,
  lat: number,
  lon: number,
  altFt: number | null,
): number {
  return cfg.sepMinNmAt
    ? cfg.sepMinNmAt(lat, lon, altFt)
    : horizontalMinimumNm(cfg);
}

/** Horizontal minimum (NM) for a PAIR at their two positions — the smaller of
 *  the two applies (if EITHER aircraft is in the tighter-minimum airspace, e.g.
 *  the Bangkok TMA, the 3 NM standard governs the encounter). */
export function sepMinNmForPair(
  cfg: CdrConfig,
  aLat: number,
  aLon: number,
  aAlt: number | null,
  bLat: number,
  bLon: number,
  bAlt: number | null,
): number {
  if (!cfg.sepMinNmAt) return horizontalMinimumNm(cfg);
  return Math.min(
    cfg.sepMinNmAt(aLat, aLon, aAlt),
    cfg.sepMinNmAt(bLat, bLon, bAlt),
  );
}

/** Vertical minimum (ft) for a conflict pair — chosen from the HIGHER of the
 *  two aircraft, since that is the level whose RVSM status governs (Doc 4444
 *  §5.3.2: 2000 ft only applies above FL410). */
export function verticalMinimumFt(cfg: CdrConfig, altAFt: number, altBFt: number): number {
  const governing = Math.max(altAFt, altBFt);
  return governing > RVSM_TOP_FT
    ? cfg.vertical.aboveRvsmTopFt
    : cfg.vertical.belowRvsmTopFt;
}

/** A deep-partial helper for `resolveConfig` overrides. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};
