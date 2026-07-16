/**
 * Airspace membership — which controlled volume an aircraft occupies.
 *
 * Pure, dependency-free point-in-polygon (the project ships no turf) over the
 * Bangkok airspace GeoJSON already loaded by `fetchSector` (web/lib/geojson.ts):
 * BACC sectors + subsectors, Control Zones (CTR), Terminal Areas (TMA) and
 * Prohibited/Danger/Restricted areas (PDR). The test is ALTITUDE-AWARE — a plane
 * at FL196 is not "in" a CTR that tops at 2000 ft — so each layer's vertical band
 * is parsed (their formats differ: numeric FL on bacc, numeric ft on tma, and
 * strings like "GND"/"ALT 2000"/"FL 120"/"UNL" on ctr/pdr).
 */

import type { Geometry, Position } from "geojson";

import type { SectorCollection, SectorKey } from "./geojson";

export interface AirspaceMembership {
  bacc?: string; // BACC sector, e.g. "4S"
  subsector?: string; // BACC subsector, e.g. "7N"
  ctr?: string; // e.g. "BANGKOK CTR"
  tma?: string; // e.g. "BANGKOK TMA"
  pdr?: string[]; // e.g. ["VTD16 RATCHABURI"] — can overlap, so a list
}

// --- point-in-polygon (ray casting, lon/lat) -------------------------------

function pointInRing(lon: number, lat: number, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** A GeoJSON Polygon is [outer, ...holes]. Inside the outer ring, not a hole. */
function pointInPolygon(lon: number, lat: number, poly: Position[][]): boolean {
  if (poly.length === 0 || !pointInRing(lon, lat, poly[0])) return false;
  for (let h = 1; h < poly.length; h++) {
    if (pointInRing(lon, lat, poly[h])) return false;
  }
  return true;
}

function pointInMultiPolygon(
  lon: number,
  lat: number,
  mp: Position[][][],
): boolean {
  for (const poly of mp) if (pointInPolygon(lon, lat, poly)) return true;
  return false;
}

// --- vertical bands --------------------------------------------------------

/** Feet from a limit value. `isFL` treats a bare number as a flight level.
 *  Strings: GND/SFC/MSL -> 0, UNL -> Infinity, "FL 120" -> 12000,
 *  "ALT 2000"/bare digits -> that many feet. */
export function parseAltFt(v: unknown, isFL = false): number {
  if (v == null) return NaN;
  if (typeof v === "number") return isFL ? v * 100 : v;
  const s = String(v).trim().toUpperCase();
  if (!s) return NaN;
  if (s === "GND" || s === "SFC" || s === "MSL") return 0;
  if (s.startsWith("UNL")) return Infinity;
  const fl = s.match(/FL\s*(\d+)/);
  if (fl) return Number(fl[1]) * 100;
  const n = s.match(/(\d+)/);
  return n ? Number(n[1]) : NaN;
}

interface Band {
  lo: number;
  hi: number;
}

function layerBand(props: Record<string, unknown>, key: SectorKey): Band {
  switch (key) {
    case "bacc":
      return {
        lo: parseAltFt(props.lower, true),
        hi: parseAltFt(props.upper, true),
      };
    case "subsector":
      return { lo: 0, hi: Infinity }; // no coded band — horizontal only
    case "tma":
      return { lo: parseAltFt(props.lower), hi: parseAltFt(props.upper) };
    case "ctr":
      return {
        lo: parseAltFt(props.lower_1 ?? props.lowerlimit),
        hi: parseAltFt(props.upper_1 ?? props.upperlimit),
      };
    case "pdr":
      return {
        lo: parseAltFt(props.lowerlimit),
        hi: parseAltFt(props.upperlimit),
      };
  }
}

function layerLabel(props: Record<string, unknown>, key: SectorKey): string {
  if (key === "pdr") {
    const ident = String(props.ident ?? "").trim();
    const name = String(props.name ?? "").trim();
    return [ident, name].filter(Boolean).join(" ") || "PDR";
  }
  return String(props.name ?? props.ident ?? "").trim() || key.toUpperCase();
}

// --- prebuilt index (bbox + normalized MultiPolygon per feature) -----------

interface IndexEntry {
  label: string;
  band: Band;
  bbox: [number, number, number, number]; // minLon, minLat, maxLon, maxLat
  mp: Position[][][];
}

export type AirspaceIndex = Partial<Record<SectorKey, IndexEntry[]>>;

function featureMP(geom: Geometry | null | undefined): Position[][][] | null {
  if (!geom) return null;
  if (geom.type === "MultiPolygon") return geom.coordinates as Position[][][];
  if (geom.type === "Polygon") return [geom.coordinates as Position[][]];
  return null;
}

function bboxOf(mp: Position[][][]): [number, number, number, number] {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const poly of mp)
    for (const ring of poly)
      for (const p of ring) {
        const lon = p[0];
        const lat = p[1];
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
  return [minLon, minLat, maxLon, maxLat];
}

/** Build a reusable index from the loaded sector collections (bbox precomputed
 *  once so per-frame membership is a cheap bbox-reject then ray-cast). */
export function buildAirspaceIndex(
  sectorData: Partial<Record<SectorKey, SectorCollection | null>>,
): AirspaceIndex {
  const idx: AirspaceIndex = {};
  for (const key of Object.keys(sectorData) as SectorKey[]) {
    const fc = sectorData[key];
    if (!fc) continue;
    const entries: IndexEntry[] = [];
    for (const f of fc.features) {
      const mp = featureMP(f.geometry);
      if (!mp) continue;
      const props = (f.properties ?? {}) as Record<string, unknown>;
      entries.push({
        label: layerLabel(props, key),
        band: layerBand(props, key),
        bbox: bboxOf(mp),
        mp,
      });
    }
    idx[key] = entries;
  }
  return idx;
}

// --- membership ------------------------------------------------------------

const LAYER_ORDER: SectorKey[] = ["bacc", "subsector", "ctr", "tma", "pdr"];

/** Which airspace volumes contain (lon, lat, altFt). `altFt == null` (no
 *  vertical profile) skips the altitude gate → horizontal-only. */
export function airspaceAt(
  index: AirspaceIndex,
  lon: number,
  lat: number,
  altFt: number | null,
): AirspaceMembership {
  const m: AirspaceMembership = {};
  for (const key of LAYER_ORDER) {
    const entries = index[key];
    if (!entries) continue;
    const hits: string[] = [];
    for (const e of entries) {
      if (lon < e.bbox[0] || lon > e.bbox[2] || lat < e.bbox[1] || lat > e.bbox[3])
        continue;
      if (!pointInMultiPolygon(lon, lat, e.mp)) continue;
      if (altFt != null && key !== "subsector") {
        if (!(altFt >= e.band.lo && altFt <= e.band.hi)) continue;
      }
      hits.push(e.label);
      if (key !== "pdr") break; // a plane is in exactly one of these
    }
    if (hits.length === 0) continue;
    if (key === "pdr") m.pdr = hits;
    else if (key === "bacc") m.bacc = hits[0];
    else if (key === "subsector") m.subsector = hits[0];
    else if (key === "ctr") m.ctr = hits[0];
    else if (key === "tma") m.tma = hits[0];
  }
  return m;
}

export function isEmptyAirspace(m: AirspaceMembership | undefined): boolean {
  return (
    !m ||
    (!m.bacc && !m.subsector && !m.ctr && !m.tma && (!m.pdr || m.pdr.length === 0))
  );
}

// Abbreviations that stay upper-case in a title-cased zone name.
const ZONE_ABBR = new Set([
  "CTR",
  "TMA",
  "FIR",
  "ACC",
  "CTA",
  "ATZ",
  "TCA",
  "MTMA",
  "APP",
]);

/** Title-case a zone name for display, keeping airspace abbreviations
 *  ("CTR"/"TMA") and area idents (anything with a digit, e.g. "VTD16")
 *  as-is: "BANGKOK TMA" → "Bangkok TMA", "VTD16 RATCHABURI" → "VTD16
 *  Ratchaburi", "NAN TMA" → "Nan TMA". */
function titleZone(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => {
      if (/\d/.test(w)) return w;
      if (ZONE_ABBR.has(w.toUpperCase())) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(" ");
}

/** Sector code for display — the raw code, with the lower/upper suffix
 *  underscore turned into a space ("3S_lower" → "3S lower"). */
function sectorLabel(code: string): string {
  return code.replace(/_/g, " ");
}

/** Human string. Both modes now list EVERY volume the aircraft is inside so
 *  overlaps (e.g. a CTR that sits under a TMA) are never hidden.
 *  `compact` (plane label / graph): "3N/7N/Bangkok TMA" — sector/subsector
 *  grouped, each further zone appended, PDR shown by ident. `full`
 *  (Results rows): the same, but PDR spelled out and slightly more verbose. */
export function formatAirspace(
  m: AirspaceMembership | undefined,
  mode: "compact" | "full",
): string {
  if (isEmptyAirspace(m)) return "";
  const mm = m as AirspaceMembership;
  const sect = [mm.bacc, mm.subsector]
    .filter((v): v is string => Boolean(v))
    .map(sectorLabel)
    .join("/");
  if (mode === "compact") {
    const parts: string[] = [];
    if (sect) parts.push(sect);
    if (mm.ctr) parts.push(titleZone(mm.ctr));
    if (mm.tma) parts.push(titleZone(mm.tma));
    if (mm.pdr?.length) parts.push(mm.pdr.map((p) => p.split(" ")[0]).join(","));
    return parts.join("/");
  }
  const parts: string[] = [];
  if (sect) parts.push(sect);
  if (mm.ctr) parts.push(titleZone(mm.ctr));
  if (mm.tma) parts.push(titleZone(mm.tma));
  if (mm.pdr?.length) parts.push(...mm.pdr.map(titleZone));
  return parts.join(" · ");
}
