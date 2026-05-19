"use client";

/**
 * useSimPlayback — drives the aircraft animation along a generated
 * trajectory.
 *
 * The trajectory points carry ISO timestamps every ~4 simulated seconds.
 * This hook converts them to an elapsed-seconds timeline and advances a
 * `simT` clock in real time multiplied by `speed` (x1 = real time, x100 =
 * 100× faster). Position/heading at the current `simT` are linearly
 * interpolated between the two bracketing samples.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { TrajectoryPoint } from "@/lib/trajectory/types";

export type SimSpeed = 1 | 2 | 5 | 20 | 50 | 100;
export const SIM_SPEEDS: SimSpeed[] = [1, 2, 5, 20, 50, 100];

export interface AircraftState {
  lat: number;
  lon: number;
  /** Heading in degrees (for icon rotation). */
  track: number;
  /** Altitude (ft) if present in the data, else null. */
  altitudeFt: number | null;
  /** Ground speed (kt). */
  gsKt: number;
}

interface Sample extends AircraftState {
  /** Seconds since the first point. */
  t: number;
}

export interface SimPlayback {
  aircraft: AircraftState | null;
  /** Current sim clock (seconds since start). */
  simT: number;
  /** Total trajectory duration (seconds). */
  total: number;
  playing: boolean;
  speed: SimSpeed;
  /** Whether a trajectory is loaded and animatable. */
  ready: boolean;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  reset: () => void;
  setSpeed: (s: SimSpeed) => void;
  /** Scrub to an absolute time (seconds). */
  seek: (t: number) => void;
}

export function useSimPlayback(
  points: TrajectoryPoint[] | undefined,
): SimPlayback {
  // Build the elapsed-time sample table once per trajectory.
  const samples = useMemo<Sample[]>(() => {
    if (!points || points.length === 0) return [];
    const t0 = new Date(points[0].epoch_ts).getTime();
    return points.map((p) => ({
      lat: p.lat,
      lon: p.lon,
      track: p.track_deg,
      altitudeFt: p.altitude_ft,
      gsKt: p.gs_kt,
      t: (new Date(p.epoch_ts).getTime() - t0) / 1000,
    }));
  }, [points]);

  const total = samples.length ? samples[samples.length - 1].t : 0;
  const ready = samples.length > 1;

  const [simT, setSimT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<SimSpeed>(1);

  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);

  // Reset the clock whenever a new trajectory is loaded.
  useEffect(() => {
    setSimT(0);
    setPlaying(false);
  }, [samples]);

  useEffect(() => {
    if (!playing) return;

    const step = (ts: number) => {
      if (lastTsRef.current == null) lastTsRef.current = ts;
      const dtReal = (ts - lastTsRef.current) / 1000;
      lastTsRef.current = ts;

      let reachedEnd = false;
      setSimT((prev) => {
        const nextT = prev + dtReal * speed;
        if (nextT >= total) {
          reachedEnd = true;
          return total;
        }
        return nextT;
      });

      if (reachedEnd) {
        setPlaying(false); // stop outside the updater; no reschedule
        return;
      }
      rafRef.current = requestAnimationFrame(step);
    };

    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      lastTsRef.current = null;
    };
  }, [playing, speed, total]);

  // Interpolate aircraft state at the current simT.
  const aircraft = useMemo<AircraftState | null>(() => {
    if (samples.length === 0) return null;
    if (simT <= 0) return samples[0];
    if (simT >= total) return samples[samples.length - 1];

    // Binary search for the bracketing samples.
    let lo = 0;
    let hi = samples.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (samples[mid].t <= simT) lo = mid;
      else hi = mid;
    }
    const a = samples[lo];
    const b = samples[hi];
    const span = b.t - a.t || 1;
    const f = (simT - a.t) / span;
    return {
      lat: a.lat + (b.lat - a.lat) * f,
      lon: a.lon + (b.lon - a.lon) * f,
      track: a.track,
      altitudeFt:
        a.altitudeFt != null && b.altitudeFt != null
          ? a.altitudeFt + (b.altitudeFt - a.altitudeFt) * f
          : a.altitudeFt,
      gsKt: a.gsKt,
    };
  }, [samples, simT, total]);

  const play = useCallback(() => {
    if (!ready) return;
    // Restart if parked at the end.
    setSimT((t) => (t >= total ? 0 : t));
    setPlaying(true);
  }, [ready, total]);
  const pause = useCallback(() => setPlaying(false), []);
  const toggle = useCallback(
    () => (playing ? setPlaying(false) : play()),
    [playing, play],
  );
  const reset = useCallback(() => {
    setPlaying(false);
    setSimT(0);
  }, []);
  const seek = useCallback(
    (t: number) => setSimT(Math.max(0, Math.min(total, t))),
    [total],
  );

  return {
    aircraft,
    simT,
    total,
    playing,
    speed,
    ready,
    play,
    pause,
    toggle,
    reset,
    setSpeed,
    seek,
  };
}
