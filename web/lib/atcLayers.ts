/**
 * Loaders for the extra ATC map layers re-added under /public/data:
 *   - Gates    (airports/gateway.geojson)
 *   - PBN      (pbn/pbn_leg.geojson + pbn/true pbn wp.geojson)
 *   - ILS      (ils/ils_leg.geojson + ils/ils_wp.geojson)
 *   - Airports (airports/Airport_with_AP_Main.csv — carries the Main flag)
 *   - Runways  (airports/runway.csv — threshold points)
 *
 * PBN/ILS share the SID/STAR DFD line + waypoint schema, so they reuse
 * `ProcedureLineCollection` / `ProcedureWaypointCollection`.
 */

import type {
  FeatureCollection,
  MultiPoint,
  Point,
} from "geojson";

import type {
  ProcedureLineCollection,
  ProcedureWaypointCollection,
} from "./types";

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(encodeURI(url), { cache: "force-cache" });
  if (!res.ok) {
    throw new Error(`Failed to load ${url}: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(encodeURI(url), { cache: "force-cache" });
  if (!res.ok) {
    throw new Error(`Failed to load ${url}: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

/** Minimal CSV → row objects (these files have no quoted/embedded commas). */
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/^﻿/, "").trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}

/* --- Gates ---------------------------------------------------------------- */

export interface GateProperties {
  airport_identifier: string;
  gate_identifier: string;
  name?: string;
  gate_latitude: number;
  gate_longitude: number;
}
export type GateCollection = FeatureCollection<
  Point | MultiPoint,
  GateProperties
>;

export const fetchGates = (): Promise<GateCollection> =>
  fetchJson<GateCollection>("/data/airports/gateway.geojson");

/* --- PBN / ILS (same schema as SID/STAR) ---------------------------------- */

export const fetchPbnLines = (): Promise<ProcedureLineCollection> =>
  fetchJson<ProcedureLineCollection>("/data/pbn/pbn_leg.geojson");
export const fetchPbnWaypoints = (): Promise<ProcedureWaypointCollection> =>
  fetchJson<ProcedureWaypointCollection>("/data/pbn/true pbn wp.geojson");
export const fetchIlsLines = (): Promise<ProcedureLineCollection> =>
  fetchJson<ProcedureLineCollection>("/data/ils/ils_leg.geojson");
export const fetchIlsWaypoints = (): Promise<ProcedureWaypointCollection> =>
  fetchJson<ProcedureWaypointCollection>("/data/ils/ils_wp.geojson");

/* --- Airports (CSV, with Main flag) --------------------------------------- */

export interface PanelAirport {
  code: string;
  name: string;
  lat: number;
  lon: number;
  /** True for the AIP "Main" aerodromes (VTBS/VTBD) — grouped separately. */
  main: boolean;
}

export async function fetchPanelAirports(): Promise<PanelAirport[]> {
  const rows = parseCsv(
    await fetchText("/data/airports/Airport_with_AP_Main.csv"),
  );
  return rows
    .map((r) => ({
      code: (r.airport_identifier || "").trim(),
      name: (r.airport_name || r.airport_identifier || "").trim(),
      lat: Number(r.airport_ref_latitude),
      lon: Number(r.airport_ref_longitude),
      main: (r.Main || "").trim().toUpperCase() === "Y",
    }))
    .filter(
      (a) => a.code && Number.isFinite(a.lat) && Number.isFinite(a.lon),
    )
    .sort((a, b) => a.code.localeCompare(b.code));
}

/* --- Runways (CSV, threshold points) -------------------------------------- */

export interface RunwayPoint {
  airport: string;
  ident: string;
  lat: number;
  lon: number;
}

export async function fetchRunways(): Promise<RunwayPoint[]> {
  const rows = parseCsv(await fetchText("/data/airports/runway.csv"));
  return rows
    .map((r) => ({
      airport: (r.airport_identifier || "").trim(),
      ident: (r.runway_identifier || "").trim(),
      lat: Number(r.runway_latitude),
      lon: Number(r.runway_longitude),
    }))
    .filter(
      (r) => r.airport && Number.isFinite(r.lat) && Number.isFinite(r.lon),
    );
}
