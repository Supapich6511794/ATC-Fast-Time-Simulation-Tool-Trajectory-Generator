/**
 * flightStatus — a single, correct source of truth for a flight's live
 * status (scheduled / en route / arrived) on the shared playback clock.
 *
 * In "all" mode the map runs an ABSOLUTE timeline: the shared `simT` counts
 * from the earliest departure across every route, and each flight animates at
 * its own EOBT offset. A flight's status therefore has to be read on its own
 * route-local clock (`simT − offset`), NOT against the absolute `simT` — doing
 * the latter is what made every row read "Arrived" the moment the absolute
 * clock passed any single flight's (relative) duration.
 */

import type { TrajectoryResult } from "@/lib/trajectory/types";
import { totalSeconds } from "@/lib/useSimPlayback";

export type FlightStatus = "scheduled" | "enroute" | "arrived";

/** Departure offset (seconds) of each route from the earliest departure across
 *  the set — the same absolute timeline the map uses in "all" mode. Index-aligned
 *  with `trajectories`. */
export function departureOffsets(trajectories: TrajectoryResult[]): number[] {
  let origin = Infinity;
  for (const t of trajectories) {
    const p = t.points?.[0];
    if (p) origin = Math.min(origin, new Date(p.epoch_ts).getTime());
  }
  if (!Number.isFinite(origin)) origin = 0;
  return trajectories.map((t) => {
    const p = t.points?.[0];
    return p ? (new Date(p.epoch_ts).getTime() - origin) / 1000 : 0;
  });
}

/** Status from a route-local clock (seconds since this flight's own departure):
 *  before 0 = not yet taken off (scheduled), within the flight = en route,
 *  at/after the end = arrived. The 1 s slack matches the map's arrival check. */
export function statusFromLocalT(localT: number, durationSec: number): FlightStatus {
  if (localT < 0) return "scheduled";
  if (localT >= durationSec - 1) return "arrived";
  return "enroute";
}

/** Route-local clock for flight `i` given the shared playback state. In "all"
 *  mode every route runs on the absolute clock offset by its EOBT; in
 *  single-route mode only the active route has a live clock (others are parked
 *  at their start, i.e. not departed). */
export function localClock(
  i: number,
  simT: number,
  offsets: number[],
  playbackIdx: number | "all",
): number {
  if (playbackIdx === "all") return simT - (offsets[i] ?? 0);
  return i === playbackIdx ? simT : -1;
}

/** Convenience: the status of flight `i` on the shared clock. */
export function flightStatusAt(
  i: number,
  traj: TrajectoryResult,
  simT: number,
  offsets: number[],
  playbackIdx: number | "all",
): FlightStatus {
  return statusFromLocalT(
    localClock(i, simT, offsets, playbackIdx),
    totalSeconds(traj.points),
  );
}
