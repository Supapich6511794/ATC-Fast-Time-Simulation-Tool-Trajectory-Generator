/**
 * Live arrival sequencing — the bridge from the app's precomputed trajectories
 * to the runway streams the panel shows.
 *
 * Mirrors `useCdr`: sample the airborne traffic at the current sim clock,
 * project each arrival's remaining path, then order and space them. Only
 * flights that are actually landing somewhere with a known runway threshold
 * take part; everything else (departures, overflights, an arrival whose runway
 * the server could not resolve) is simply not an arrival to sequence.
 *
 * The heavy lifting is pure — `sequenceArrivals` measures, `planArrivalStream`
 * resolves the whole order including cascade. This file only gathers inputs.
 */

import { useMemo } from "react";

import { statusFromLocalT } from "@/lib/flightStatus";
import { holdLegSec, holdLoopSec, type Holding } from "@/lib/holdings";
import type { TrajectoryResult } from "@/lib/trajectory/types";
import { aircraftAt, totalSeconds, type AircraftState } from "@/lib/useSimPlayback";

import { planArrivals, type ArrivalPlan } from "./arrivalPlan";
import type { ArrivalContext, ArrivalHold } from "./arrivalFix";
import { sequenceArrivals, type ArrivalInput } from "./arrivalSequence";
import { resolveConfig, type CdrConfig, type DeepPartial } from "./config";
import type { FutureSample } from "./types";

/** Cap on projected samples per arrival. At the 10 s detector step this covers
 *  a 2.5 h leg exactly; anything longer is sampled more coarsely rather than
 *  cut short, so the path still reaches the runway. */
const MAX_SAMPLES_PER_FLIGHT = 900;

interface Sample extends AircraftState {
  t: number;
}

/** A hold has to be joined AT the fix, so one that the aircraft is about to
 *  cross is no use — by the time the instruction is read it is behind. */
const HOLD_MIN_LEAD_SEC = 60;

/**
 * The next published holding pattern on this arrival's route that it has not
 * yet passed, or null.
 *
 * The EARLIEST one ahead is the one to offer: it is the only one the aircraft
 * reaches next, and holding early is the whole point of offering this before
 * the approach runs out of room. Fixes already behind cannot be flown to, and
 * a hold entered after touchdown time is meaningless.
 */
export function nextHoldOnRoute(
  traj: TrajectoryResult,
  samples: Sample[],
  localT: number,
  holdings: Map<string, Holding>,
): ArrivalHold | null {
  if (!holdings.size || samples.length < 2) return null;
  const duration = samples[samples.length - 1].t;
  let best: ArrivalHold | null = null;

  for (const w of traj.route) {
    const h = holdings.get(w.ident);
    if (!h) continue;
    // Time the aircraft passes the fix — the sample closest to it, as the
    // conflict-side hold planner does.
    let tAt = 0;
    let bestD = Infinity;
    for (const s of samples) {
      const d = (s.lat - w.lat) ** 2 + (s.lon - w.lon) ** 2;
      if (d < bestD) {
        bestD = d;
        tAt = s.t;
      }
    }
    if (tAt <= localT + HOLD_MIN_LEAD_SEC || tAt >= duration) continue;
    if (best && tAt >= best.tManSec) continue;
    const at = aircraftAt(samples, tAt);
    const gsKt = h.speedKt ?? at?.gsKt ?? 230;
    best = {
      ident: h.ident,
      lat: h.lat,
      lon: h.lon,
      inboundCourseDeg: h.inboundCourseDeg,
      turn: h.turn,
      legSec: holdLegSec(h, gsKt),
      gsKt,
      loopSec: holdLoopSec(h, gsKt),
      tManSec: tAt,
    };
  }
  return best;
}

export interface UseArrivalsArgs {
  trajectories: TrajectoryResult[];
  samplesByIdx: Sample[][];
  offsets: number[];
  /** Absolute sim clock (s). */
  simSec: number;
  /** Only the shared "all" timeline is real traffic to sequence. */
  enabled: boolean;
  configOverrides?: DeepPartial<CdrConfig>;
  /** Cap on projected samples per arrival. The projection always runs to
   *  touchdown; this only sets how finely. */
  maxSamplesPerFlight?: number;
  /** Published holdings by fix ident. Without them a hold can be described but
   *  not flown, so the panel offers it only as a last-resort advisory. */
  holdings?: Map<string, Holding>;
}

export interface UseArrivalsResult {
  plans: ArrivalPlan[];
  /** Every aircraft needing an instruction, across all runways, worst first. */
  actions: ArrivalPlan["actions"];
  config: CdrConfig;
  /** What the panel needs to rebuild an instruction at a different size. */
  contextOf: (id: string) => ArrivalContext;
}

/**
 * Build the arrival inputs for the current instant. Exported for testing —
 * it is the part with all the conditions in it.
 */
export function collectArrivals(
  trajectories: TrajectoryResult[],
  samplesByIdx: Sample[][],
  offsets: number[],
  simSec: number,
  stepSec: number,
  maxSamplesPerFlight = MAX_SAMPLES_PER_FLIGHT,
  holdings?: Map<string, Holding>,
): { inputs: ArrivalInput[]; contexts: Map<string, ArrivalContext> } {
  const inputs: ArrivalInput[] = [];
  const contexts = new Map<string, ArrivalContext>();

  for (let i = 0; i < trajectories.length; i++) {
    const t = trajectories[i];
    const meta = t.meta;
    // No landing runway on record -> nothing to sequence against.
    if (!meta.arrRwy || !meta.arrThreshold) continue;

    const samples = samplesByIdx[i];
    if (!samples || samples.length < 2) continue;
    const duration = totalSeconds(t.points);
    const localT = simSec - (offsets[i] ?? 0);
    if (statusFromLocalT(localT, duration) !== "enroute") continue;
    const now = aircraftAt(samples, localT);
    if (!now || now.altitudeFt == null) continue;

    // Remaining path ALL THE WAY to touchdown. This is where arrival
    // sequencing parts company with conflict detection: the detector only
    // needs a look-ahead, but the landing order and the in-trail spacing are
    // both decided AT THE THRESHOLD. Stopping at a fixed window would leave
    // every arrival more than that far out with an extrapolated ETA — a
    // straight-line guess at current ground speed, ignoring the descent and
    // the STAR — and the order itself could then come out wrong.
    //
    // The step is stretched rather than the path truncated when a flight is
    // long enough to exceed the sample cap: a coarser path still ends at the
    // threshold, whereas a shorter one puts the ETA back to a guess.
    const remaining = duration - localT;
    const count = Math.min(
      maxSamplesPerFlight,
      Math.max(2, Math.ceil(remaining / stepSec) + 1),
    );
    const step = remaining / (count - 1);
    const future: FutureSample[] = [];
    for (let k = 0; k < count; k++) {
      const dt = k === count - 1 ? remaining : k * step;
      const f = aircraftAt(samples, localT + dt);
      if (!f || f.altitudeFt == null) break;
      future.push({ dt, lat: f.lat, lon: f.lon, altFt: f.altitudeFt });
    }
    if (future.length < 2) continue;

    // Approach speed straight from the trajectory's own last sample, rather
    // than derived from positions — the two can disagree on the descent.
    const atLanding = aircraftAt(samples, duration);

    inputs.push({
      id: meta.flightKey,
      callsign: meta.callsign,
      type: meta.aircraftType,
      adep: meta.adep,
      ades: meta.ades,
      star: meta.star,
      arrRwy: meta.arrRwy,
      threshold: meta.arrThreshold,
      future,
      gsKt: now.gsKt,
      trackDeg: now.track,
      finalGsKt: atLanding?.gsKt,
    });
    contexts.set(meta.flightKey, {
      openStar: !!meta.starOpen,
      vectorHeadingDeg: meta.vectorHeadingDeg,
      vectorHeadingMagDeg: meta.vectorHeadingMagDeg,
      hold:
        (holdings && nextHoldOnRoute(t, samples, localT, holdings)) || undefined,
    });
  }
  return { inputs, contexts };
}

/** Sequence the arrivals at the current sim clock. */
export function useArrivals({
  trajectories,
  samplesByIdx,
  offsets,
  simSec,
  enabled,
  configOverrides,
  maxSamplesPerFlight,
  holdings,
}: UseArrivalsArgs): UseArrivalsResult {
  const config = useMemo(
    () => resolveConfig(configOverrides),
    [configOverrides],
  );

  return useMemo(() => {
    const none = { openStar: false };
    const empty = { plans: [], actions: [], config, contextOf: () => none };
    if (!enabled) return empty;
    const { inputs, contexts } = collectArrivals(
      trajectories,
      samplesByIdx,
      offsets,
      simSec,
      config.lookahead.stepSec,
      maxSamplesPerFlight,
      holdings,
    );
    if (inputs.length < 2) return empty;

    const contextOf = (id: string) => contexts.get(id) ?? none;
    const plans = planArrivals(config, sequenceArrivals(config, inputs), contextOf);
    const actions = plans
      .flatMap((p) => p.actions)
      .sort((a, b) => b.delayNm - a.delayNm);
    return { plans, actions, config, contextOf };
  }, [
    enabled,
    trajectories,
    samplesByIdx,
    offsets,
    simSec,
    maxSamplesPerFlight,
    holdings,
    config,
  ]);
}
