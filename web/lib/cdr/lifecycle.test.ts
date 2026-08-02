import { describe, expect, it } from "vitest";

import { resolveConfig } from "./config";
import { reconcileConflicts, type TrackedConflict } from "./lifecycle";
import type { Conflict, Severity } from "./types";

const cfg = resolveConfig({ resolveHysteresisTicks: 3 });

/** Minimal Conflict with a given id/severity; geometry fields are placeholders
 *  (lifecycle only cares about id + severity). */
function conflict(id: string, severity: Severity): Conflict {
  const [a, b] = id.split("|");
  return {
    id,
    a,
    b,
    severity,
    tCpa: 100,
    dCpa: 3,
    vSepAtCpaFt: 0,
    hSepNowNm: 10,
    vSepNowFt: 0,
    tToLosSec: 100,
    losWindow: { t0: 100, t1: 200 },
    shNm: 5,
    svFt: 1000,
    pctOfMinima: 60,
  };
}

describe("reconcileConflicts", () => {
  it("first sighting emits a `new` event and marks the conflict NEW", () => {
    const { tracked, events } = reconcileConflicts([], [conflict("A|B", "MTCD")], cfg, 0);
    expect(tracked).toHaveLength(1);
    expect(tracked[0].status).toBe("NEW");
    expect(events).toEqual([expect.objectContaining({ kind: "new" })]);
  });

  it("re-detection at the same severity is silent (dedup) and becomes ACTIVE", () => {
    const t0 = reconcileConflicts([], [conflict("A|B", "MTCD")], cfg, 0);
    const t1 = reconcileConflicts(t0.tracked, [conflict("A|B", "MTCD")], cfg, 1);
    expect(t1.events).toHaveLength(0); // no toast for minor drift
    expect(t1.tracked[0].status).toBe("ACTIVE");
  });

  it("severity escalation emits `escalated` and flips status to UPDATED", () => {
    const t0 = reconcileConflicts([], [conflict("A|B", "MTCD")], cfg, 0);
    const t1 = reconcileConflicts(t0.tracked, [conflict("A|B", "STCA")], cfg, 1);
    expect(t1.events).toEqual([expect.objectContaining({ kind: "escalated" })]);
    expect(t1.tracked[0].status).toBe("UPDATED");
    expect(t1.tracked[0].notifiedSeverity).toBe("STCA");

    // Further escalation to LOS also notifies.
    const t2 = reconcileConflicts(t1.tracked, [conflict("A|B", "LOS")], cfg, 2);
    expect(t2.events).toEqual([expect.objectContaining({ kind: "escalated" })]);
  });

  it("de-escalation does NOT emit an event (only worsening notifies)", () => {
    const t0 = reconcileConflicts([], [conflict("A|B", "STCA")], cfg, 0);
    const t1 = reconcileConflicts(t0.tracked, [conflict("A|B", "MTCD")], cfg, 1);
    expect(t1.events).toHaveLength(0);
    // Still remembers it was notified at STCA, so a bounce back up is silent.
    const t2 = reconcileConflicts(t1.tracked, [conflict("A|B", "STCA")], cfg, 2);
    expect(t2.events).toHaveLength(0);
  });

  it("applies hysteresis: RESOLVED only after N consecutive clear ticks", () => {
    let state = reconcileConflicts([], [conflict("A|B", "STCA")], cfg, 0);
    // Ticks 1, 2: undetected but still held (clearing), no resolve event yet.
    state = reconcileConflicts(state.tracked, [], cfg, 1);
    expect(state.events).toHaveLength(0);
    expect(state.tracked[0].clearTicks).toBe(1);
    state = reconcileConflicts(state.tracked, [], cfg, 2);
    expect(state.events).toHaveLength(0);
    expect(state.tracked[0].clearTicks).toBe(2);
    // Tick 3: hits the threshold → RESOLVED event, leaves the active set.
    state = reconcileConflicts(state.tracked, [], cfg, 3);
    expect(state.events).toEqual([expect.objectContaining({ kind: "resolved" })]);
    expect(state.tracked).toHaveLength(0);
  });

  it("a clear tick then re-detection resets the hysteresis counter", () => {
    let state = reconcileConflicts([], [conflict("A|B", "STCA")], cfg, 0);
    state = reconcileConflicts(state.tracked, [], cfg, 1); // clearTicks → 1
    expect(state.tracked[0].clearTicks).toBe(1);
    state = reconcileConflicts(state.tracked, [conflict("A|B", "STCA")], cfg, 2);
    expect(state.tracked[0].clearTicks).toBe(0); // reset, no resolve
    expect(state.events).toHaveLength(0);
  });

  it("tracks multiple conflicts independently", () => {
    const prev: TrackedConflict[] = reconcileConflicts(
      [],
      [conflict("A|B", "MTCD"), conflict("C|D", "STCA")],
      cfg,
      0,
    ).tracked;
    // A|B escalates, C|D drops out.
    const { tracked, events } = reconcileConflicts(
      prev,
      [conflict("A|B", "STCA")],
      cfg,
      1,
    );
    expect(events).toEqual([expect.objectContaining({ kind: "escalated" })]);
    expect(tracked.find((t) => t.id === "A|B")!.status).toBe("UPDATED");
    expect(tracked.find((t) => t.id === "C|D")!.clearTicks).toBe(1);
  });
});
