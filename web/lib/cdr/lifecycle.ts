/**
 * Conflict lifecycle — turns the stateless per-tick detection output into
 * stable, tracked conflicts with a state machine and notification events.
 *
 *   NEW → ACTIVE → UPDATED → RESOLVED
 *
 * A conflict is keyed by its stable pair id, so the same encounter is tracked
 * across ticks even as its geometry evolves. Two behaviours the raw detector
 * can't provide on its own live here:
 *
 *  - Notify only on what matters. A `new` event fires the first time a pair is
 *    seen; an `escalated` event fires only when severity worsens past what we
 *    last alerted on (MTCD→STCA→LOS). Ordinary value drift (d_cpa 6.1→6.0 NM)
 *    updates the record silently — no toast, no sound. This is the dedup the
 *    brief asks for, keyed by conflict id.
 *
 *  - Hysteresis on clearing. A pair that drops out of detection isn't resolved
 *    immediately; it must stay clear for `resolveHysteresisTicks` consecutive
 *    ticks first. That stops a pair hovering right at the buffer from flapping
 *    RESOLVED/NEW every second.
 *
 * Pure and deterministic (lifecycle.test.ts): (previous tracked set, new
 * detections, tick) → (next tracked set, events). The React hook owns the
 * persistence and side effects.
 */

import type { CdrConfig } from "./config";
import { SEVERITY_ORDER, type Conflict, type Severity } from "./types";

export type ConflictStatus = "NEW" | "ACTIVE" | "UPDATED" | "RESOLVED";

/** A conflict enriched with lifecycle bookkeeping, persisted across ticks. */
export interface TrackedConflict extends Conflict {
  status: ConflictStatus;
  /** Tick at which the pair was first detected, and the most recent one. */
  firstSeenTick: number;
  lastSeenTick: number;
  /** Consecutive ticks the pair has been undetected (drives hysteresis). */
  clearTicks: number;
  /** Most severe level ever reached — so a dip then re-escalation still reads
   *  as an escalation only when it passes the level we last notified on. */
  notifiedSeverity: Severity;
}

/** Something worth telling the user about. `new` and `escalated` fire a toast +
 *  sound; `resolved` clears the badge/entry (a quiet, positive event). */
export interface CdrEvent {
  kind: "new" | "escalated" | "resolved";
  conflict: TrackedConflict;
}

export interface ReconcileResult {
  tracked: TrackedConflict[];
  events: CdrEvent[];
}

/** True when severity `next` is strictly worse (more urgent) than `prev`. */
function isEscalation(prev: Severity, next: Severity): boolean {
  return SEVERITY_ORDER[next] < SEVERITY_ORDER[prev];
}

/**
 * Advance the lifecycle by one detection pass.
 *
 * @param previous  tracked conflicts from the last tick (RESOLVED ones already
 *                  dropped by the caller, or kept one tick to render the clear)
 * @param detected  raw conflicts from `detectConflicts` this tick
 * @param cfg       supplies the resolve hysteresis count
 * @param tick      monotonically increasing tick counter (e.g. sim second)
 */
export function reconcileConflicts(
  previous: TrackedConflict[],
  detected: Conflict[],
  cfg: CdrConfig,
  tick: number,
): ReconcileResult {
  const prevById = new Map(previous.map((t) => [t.id, t]));
  const detectedById = new Map(detected.map((c) => [c.id, c]));
  const events: CdrEvent[] = [];
  const tracked: TrackedConflict[] = [];

  // 1. Every currently-detected conflict: create or update its tracked record.
  for (const c of detected) {
    const prev = prevById.get(c.id);
    if (!prev) {
      const t: TrackedConflict = {
        ...c,
        status: "NEW",
        firstSeenTick: tick,
        lastSeenTick: tick,
        clearTicks: 0,
        notifiedSeverity: c.severity,
      };
      tracked.push(t);
      events.push({ kind: "new", conflict: t });
      continue;
    }
    const escalated = isEscalation(prev.notifiedSeverity, c.severity);
    const t: TrackedConflict = {
      ...c, // refresh geometry from this tick
      status: escalated ? "UPDATED" : prev.status === "NEW" ? "ACTIVE" : "ACTIVE",
      firstSeenTick: prev.firstSeenTick,
      lastSeenTick: tick,
      clearTicks: 0, // re-detected → clear counter resets
      notifiedSeverity: escalated ? c.severity : prev.notifiedSeverity,
    };
    tracked.push(t);
    if (escalated) events.push({ kind: "escalated", conflict: t });
  }

  // 2. Previously-tracked conflicts no longer detected: age them toward
  //    RESOLVED under hysteresis; keep rendering them as clearing until then.
  for (const prev of previous) {
    if (detectedById.has(prev.id)) continue;
    const clearTicks = prev.clearTicks + 1;
    if (clearTicks >= cfg.resolveHysteresisTicks) {
      const t: TrackedConflict = { ...prev, status: "RESOLVED", clearTicks };
      events.push({ kind: "resolved", conflict: t });
      // Not pushed into `tracked` — a RESOLVED conflict leaves the active set.
    } else {
      tracked.push({ ...prev, status: "ACTIVE", clearTicks });
    }
  }

  return { tracked, events };
}
