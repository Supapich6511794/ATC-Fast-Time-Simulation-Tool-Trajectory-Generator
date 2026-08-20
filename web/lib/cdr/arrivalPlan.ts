/**
 * Stream-wide arrival sequencing — resolving the WHOLE landing order, not one
 * pair at a time.
 *
 * `planArrivalFix` answers "what do I do about this pair?". On its own that is
 * a trap: delaying an aircraft to open a gap in front of it closes the gap
 * behind it. In a bank where several consecutive pairs are tight, fixing each
 * one independently produces a set of instructions that cannot all be flown —
 * the second one was computed against a leader that the first instruction
 * already moved.
 *
 *     ...  #4 ──2.0── #5 ──2.2── #6  ...        both pairs short
 *     fix #5 alone:   #4 ────5.0──── #5 ──0.?── #6      #6 now worse
 *
 * Note which way the coupling runs. Spacing is measured as the follower's
 * remaining distance when the leader touches down, so delaying an aircraft
 * OPENS the gap in front of it and CLOSES the gap behind it — the aircraft
 * following has that much longer to catch up. Fixing a pair therefore always
 * pushes the problem backwards down the stream, never forwards.
 *
 * The resolution is the standard arrival-manager recursion over scheduled
 * landing times:
 *
 *     T₁ = t₁
 *     Tᵢ = max(tᵢ, Tᵢ₋₁ + required separation between i-1 and i)
 *
 * Each aircraft lands at the later of its own unimpeded ETA and the earliest
 * its leader's slot allows. Delay accumulates automatically: pushing #5 back
 * pushes #6 back too if #6 can no longer fit behind it. For a single isolated
 * pair this reduces exactly to the pairwise deficit.
 *
 * The result is a per-aircraft delay in track miles, which is what the fix is
 * expressed in: seconds of delay × approach speed. Feed it to
 * `planArrivalFix` (or straight to the generator's `extend_downwind_nm`).
 */

import { planArrivalFix, type ArrivalContext, type ArrivalFix } from "./arrivalFix";
import type {
  ArrivalPairSpacing,
  RunwayStream,
  SequencedArrival,
} from "./arrivalSequence";
import type { CdrConfig } from "./config";

/** One aircraft's place in the resolved sequence. */
export interface PlannedArrival {
  arrival: SequencedArrival;
  /** Spacing to the aircraft ahead, as things stand now. Null for the first. */
  pair: ArrivalPairSpacing | null;
  /** Track miles this aircraft must absorb so the WHOLE stream works —
   *  its own shortfall plus everything pushed onto it from upstream. 0 when it
   *  needs no action. */
  delayNm: number;
  /** Delay in seconds, at its approach speed. */
  delaySec: number;
  /** How much of `delayNm` is inherited from aircraft ahead rather than caused
   *  by this pair. Non-zero means a fix upstream created work here — the thing
   *  a pairwise planner cannot see. */
  inheritedNm: number;
  /** Ranked instructions, best first. Empty when nothing is needed. */
  fixes: ArrivalFix[];
}

export interface ArrivalPlan {
  ades: string;
  runway: string;
  order: PlannedArrival[];
  /** Aircraft needing an instruction, worst delay first. */
  actions: PlannedArrival[];
  /** Total delay the bank has to absorb (NM) — the cost of the arrival rush. */
  totalDelayNm: number;
}

/** Context per aircraft id: is it on an open STAR, and on what heading. */
export type ArrivalContexts = (id: string) => ArrivalContext;

/**
 * Resolve one runway's stream, accumulating delay down the order.
 *
 * `contexts` says whether each aircraft can be vectored at all (an open STAR
 * with a published heading); without it every aircraft is treated as closed,
 * so only speed and holding are offered.
 */
export function planArrivalStream(
  cfg: CdrConfig,
  stream: RunwayStream,
  contexts: ArrivalContexts = () => ({ openStar: false }),
): ArrivalPlan {
  const order: PlannedArrival[] = [];
  //  Tᵢ = max(tᵢ, Tᵢ₋₁ + required separation), in seconds from now.
  let prevScheduled: number | null = null;

  for (let i = 0; i < stream.arrivals.length; i++) {
    const arrival = stream.arrivals[i];
    const pair = i === 0 ? null : stream.pairs[i - 1] ?? null;
    const gs = arrival.finalGsKt > 1 ? arrival.finalGsKt : 1;
    const toSec = (nm: number) => (nm / gs) * 3600;

    // Earliest this aircraft may land behind the one in front, given where
    // that one is now SCHEDULED (not where it was originally due).
    const earliest =
      pair && prevScheduled !== null
        ? prevScheduled + toSec(pair.requiredNm)
        : -Infinity;
    const scheduled = Math.max(arrival.etaSec, earliest);
    const delaySec = Math.max(0, scheduled - arrival.etaSec);
    const delayNm = (delaySec / 3600) * gs;
    prevScheduled = scheduled;

    // How much of this delay is NOT explained by this pair's own shortfall —
    // i.e. work handed down from a fix applied further up the stream. This is
    // precisely what a pair-at-a-time planner cannot see.
    const ownNeedNm = pair ? pair.deficitNm : 0;
    const inheritedNm = Math.max(0, delayNm - ownNeedNm);

    let fixes: ArrivalFix[] = [];
    if (pair && delayNm > 0) {
      // Plan against the delay the STREAM needs, which can exceed this pair's
      // own deficit once upstream pushes are carried in.
      fixes = planArrivalFix(
        cfg,
        { ...pair, deficitNm: delayNm },
        contexts(arrival.id),
      ).fixes;
    }

    order.push({ arrival, pair, delayNm, delaySec, inheritedNm, fixes });
  }

  const actions = order
    .filter((p) => p.delayNm > 0)
    .sort((a, b) => b.delayNm - a.delayNm);
  return {
    ades: stream.ades,
    runway: stream.runway,
    order,
    actions,
    totalDelayNm: order.reduce((s, p) => s + p.delayNm, 0),
  };
}

/** Resolve every runway stream. */
export function planArrivals(
  cfg: CdrConfig,
  streams: RunwayStream[],
  contexts?: ArrivalContexts,
): ArrivalPlan[] {
  return streams.map((s) => planArrivalStream(cfg, s, contexts));
}
