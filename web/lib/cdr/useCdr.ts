"use client";

/**
 * useCdr — the Conflict Detection & Resolution loop, wired to the shared sim
 * clock.
 *
 * The app has no discrete physics tick; it advances one `simT` clock ~60×/s via
 * requestAnimationFrame. Running full O(n²) detection every frame would be
 * wasteful and janky, so — exactly like the existing live-airspace readout —
 * this hook throttles to whole simulation seconds (`simSec`). Each new sim
 * second it samples all airborne traffic, runs `detectConflicts`, folds the
 * result through the lifecycle state machine, and emits notification events for
 * anything new or escalated.
 *
 * CD&R only runs in the "all" playback timeline, where every aircraft is truly
 * airborne at its own EOBT — the one mode with real multi-aircraft geometry.
 *
 * (Detection is O(n²) with a cheap O(n) coarse pre-filter; for the traffic
 * volumes this fast-time tool generates that is comfortably within a frame
 * budget on the main thread. A Web Worker offload is the natural next step if
 * traffic ever grows into the hundreds — the pure engine is worker-ready.)
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { departureOffsets } from "@/lib/flightStatus";
import type { TrajectoryResult } from "@/lib/trajectory/types";
import { toSamples } from "@/lib/useSimPlayback";

import { resolveConfig, type CdrConfig, type DeepPartial } from "./config";
import { detectConflicts } from "./detect";
import { reconcileConflicts, type CdrEvent, type TrackedConflict } from "./lifecycle";
import { sampleTraffic } from "./traffic";
import type { CdrAircraft } from "./types";
import { useCallbacksRef } from "./useCallbacksRef";

export interface UseCdrArgs {
  trajectories: TrajectoryResult[];
  /** Absolute shared clock (seconds) and its whole-second throttle key. */
  simT: number;
  simSec: number;
  playbackIdx: number | "all";
  /** Master on/off (the CD&R toolbar toggle). */
  enabled: boolean;
  /** Optional config overrides (minima/buffers/weights). */
  configOverrides?: DeepPartial<CdrConfig>;
  /** Fired for each NEW / ESCALATED / RESOLVED event (drives toast + sound). */
  onEvent?: (event: CdrEvent) => void;
}

export interface UseCdrResult {
  /** Active tracked conflicts, most-urgent first. */
  conflicts: TrackedConflict[];
  /** The traffic snapshot used for the latest pass (for the overlay/advisory). */
  traffic: CdrAircraft[];
  config: CdrConfig;
}

export function useCdr({
  trajectories,
  simT,
  simSec,
  playbackIdx,
  enabled,
  configOverrides,
  onEvent,
}: UseCdrArgs): UseCdrResult {
  const config = useMemo(() => resolveConfig(configOverrides), [configOverrides]);

  // Elapsed-time sample tables + EOBT offsets — same derivation the map uses,
  // memoised so per-second detection doesn't rebuild them.
  const samplesByIdx = useMemo(
    () => trajectories.map((t) => toSamples(t.points)),
    [trajectories],
  );
  const offsets = useMemo(() => departureOffsets(trajectories), [trajectories]);

  const [conflicts, setConflicts] = useState<TrackedConflict[]>([]);
  const [traffic, setTraffic] = useState<CdrAircraft[]>([]);
  const trackedRef = useRef<TrackedConflict[]>([]);

  // Keep the latest event callback without making it an effect dependency (so a
  // new inline callback each render doesn't retrigger detection).
  const onEventRef = useCallbacksRef(onEvent);

  const active = enabled && playbackIdx === "all" && trajectories.length >= 2;

  // Reset all tracking when CD&R turns off or the traffic set changes, so stale
  // conflicts can't linger against a different flight list.
  useEffect(() => {
    if (!active) {
      trackedRef.current = [];
      setConflicts([]);
      setTraffic([]);
    }
  }, [active]);

  // Real-time throttle for the detection pass. The effect is keyed on `simSec`,
  // which at high sim speed (e.g. x100) ticks ~100×/second — running full O(n²)
  // detection that often saturated the main thread and froze the tab. ~5 Hz of
  // real time is ample for a 10-minute look-ahead. A change to the traffic set
  // (`samplesByIdx`, e.g. after an applied fix) always bypasses the throttle so a
  // new trajectory is re-detected immediately.
  const DETECT_MIN_MS = 200;
  const lastDetectMsRef = useRef(0);
  const lastSamplesRef = useRef(samplesByIdx);

  // The detection pass — throttled to real time (or forced on a traffic change).
  useEffect(() => {
    if (!active) return;
    const trafficChanged = lastSamplesRef.current !== samplesByIdx;
    const nowMs =
      typeof performance !== "undefined" ? performance.now() : lastDetectMsRef.current;
    if (
      !trafficChanged &&
      lastDetectMsRef.current !== 0 &&
      nowMs - lastDetectMsRef.current < DETECT_MIN_MS
    ) {
      return; // too soon since the last pass; next simSec tick will retry
    }
    lastDetectMsRef.current = nowMs;
    lastSamplesRef.current = samplesByIdx;
    const snapshot = sampleTraffic(
      trajectories,
      samplesByIdx,
      simT,
      offsets,
      config.lookahead.mtcdSec,
      config.lookahead.stepSec,
    );
    const detected = detectConflicts(snapshot, config);
    const { tracked, events } = reconcileConflicts(
      trackedRef.current,
      detected,
      config,
      simSec,
    );
    trackedRef.current = tracked;
    setTraffic(snapshot);
    setConflicts(tracked);
    const cb = onEventRef.current;
    if (cb) for (const e of events) cb(e);
    // simT is read at run time; simSec is the throttle key that gates re-runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, simSec, config, samplesByIdx, offsets, trajectories]);

  return { conflicts, traffic, config };
}
