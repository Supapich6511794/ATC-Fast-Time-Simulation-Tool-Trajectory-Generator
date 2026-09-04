"use client";

/**
 * usePdrCheck — the React seam for the PDR check.
 *
 * Loads the four AIRAC datasets the analysis needs (PDR polygons, their AIXM
 * activity times, the ENR 1.10 route table and the navdata cache) once per
 * page, then runs `analysePdr` over the supplied flights. The engine itself
 * stays pure and DOM-free in ./detect; this file exists only to feed it.
 *
 * The PDR overlay is fetched here rather than taken from the map's `sectorData`
 * because that collection is loaded lazily when the user toggles the layer on.
 * A safety check that silently reports "no conflicts" because a map layer
 * happened to be switched off would be worse than useless, so this owns its own
 * copy; `fetchSector` hits the same HTTP cache, so nothing is downloaded twice.
 */

import { useEffect, useMemo, useState } from "react";

import { fetchAip, type Fix } from "@/lib/aip";
import { fetchAipRoutes, type AipRoute } from "@/lib/aipRoutes";
import { fetchSector, type SectorCollection } from "@/lib/geojson";

import { buildPdrAreas, fetchPdrActivity } from "./areas";
import { analysePdr, type PdrReport } from "./detect";
import { decimatePath } from "./penetration";
import type { PdrActivityFile, PdrArea, TimedPoint } from "./types";

/** One flight to check, as the map already knows it. */
export interface PdrFlight {
  flightKey: string;
  callsign: string;
  adep: string;
  ades: string;
  actype?: string | null;
  /** The en-route string as filed. */
  filedRoute: string;
  /** Off-blocks, UTC epoch ms. */
  eobtMs: number;
  rflFt: number;
  gsKt: number;
  /** The generated trajectory, absolute-timed. */
  path: TimedPoint[];
  rnav?: boolean;
}

interface Loaded {
  areas: PdrArea[];
  routes: AipRoute[];
  fixes: Fix[];
  airways: Record<string, string[]>;
  activity: PdrActivityFile;
}

export interface PdrCheckState {
  loading: boolean;
  error: string | null;
  /** flightKey -> its report. Empty until the data has loaded. */
  reports: Map<string, PdrReport>;
  areas: PdrArea[];
  /** The AIRAC window the activity data is valid for, for the staleness note. */
  validFrom: string | null;
  validTo: string | null;
}

/** Convert a generated trajectory into the absolute-timed path the check wants. */
export function pathFromTrajectory(
  points: ReadonlyArray<{
    lat: number;
    lon: number;
    altitude_ft: number | null;
    epoch_ts: string;
  }>,
): TimedPoint[] {
  const out: TimedPoint[] = [];
  for (const p of points) {
    const timeMs = Date.parse(p.epoch_ts);
    if (!Number.isFinite(timeMs)) continue;
    out.push({ lat: p.lat, lon: p.lon, altFt: p.altitude_ft ?? 0, timeMs });
  }
  return decimatePath(out);
}

export function usePdrCheck(
  flights: PdrFlight[],
  enabled = true,
): PdrCheckState {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || loaded || error) return;
    let cancelled = false;
    Promise.all([
      fetchSector("pdr"),
      fetchPdrActivity(),
      fetchAipRoutes(),
      fetchAip(),
    ])
      .then(([sector, activity, routes, aip]) => {
        if (cancelled) return;
        const fixes: Fix[] = Object.entries(aip.waypoints ?? {})
          .filter(([, w]) => Number.isFinite(w.lat) && Number.isFinite(w.lon))
          .map(([ident, w]) => ({ ident, lat: w.lat, lon: w.lon }));
        setLoaded({
          areas: buildPdrAreas(sector as SectorCollection, activity),
          routes,
          fixes,
          airways: aip.airways ?? {},
          activity,
        });
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, loaded, error]);

  const reports = useMemo(() => {
    const m = new Map<string, PdrReport>();
    if (!loaded) return m;
    for (const f of flights) {
      m.set(
        f.flightKey,
        analysePdr({
          adep: f.adep,
          ades: f.ades,
          filedRoute: f.filedRoute,
          actype: f.actype,
          rflFt: f.rflFt,
          gsKt: f.gsKt,
          eobtMs: f.eobtMs,
          path: f.path,
          areas: loaded.areas,
          publishedRoutes: loaded.routes,
          fixes: loaded.fixes,
          airways: loaded.airways,
          rnav: f.rnav,
        }),
      );
    }
    return m;
  }, [loaded, flights]);

  return {
    loading: enabled && !loaded && !error,
    error,
    reports,
    areas: loaded?.areas ?? [],
    validFrom: loaded?.activity.validFrom ?? null,
    validTo: loaded?.activity.validTo ?? null,
  };
}
