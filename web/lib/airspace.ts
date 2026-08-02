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

import { SECTORS, type SectorCollection, type SectorKey } from "./geojson";

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

export function pointInMultiPolygon(
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

export interface Band {
  lo: number;
  hi: number;
}

/** Vertical band (feet) coded on a sector feature, per its layer's schema.
 *  Exposed so the map can colour sectors by altitude. */
export function layerBand(props: Record<string, unknown>, key: SectorKey): Band {
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

// --- whole-route segments (for the altitude profile block colouring) -------

/** Per-layer sector colour (the same palette that styles the map overlays). */
const SECTOR_COLOR = Object.fromEntries(
  SECTORS.map((s) => [s.key, s.color]),
) as Record<SectorKey, string>;

/** The map colour of the ONE airspace that owns the aircraft here — the layer
 *  the hierarchy resolves to (see {@link controllingLayer}). Returned as an
 *  array so the profile's fill helper keeps one shape; [] when in no airspace,
 *  which draws the neutral default. */
export function membershipColors(m: AirspaceMembership | undefined): string[] {
  const key = controllingLayer(m);
  return key === null ? [] : [SECTOR_COLOR[key]];
}

/** One contiguous stretch of a route that stays inside the same set of
 *  airspace volumes. `t0`/`t1` are seconds from the route's first point (the
 *  same clock the altitude chart uses), so the profile can paint the run as a
 *  colour block. Boundaries are stitched so adjacent segments abut exactly. */
export interface AirspaceSegment {
  t0: number;
  t1: number;
  /** Altitude-aware membership — the volumes that actually contain the
   *  aircraft on this stretch. Drives both the label and the colours. */
  membership: AirspaceMembership;
  /** Compact display label, e.g. "8S/Bangkok CTR/VTR1" ("" outside all zones).
   *  Altitude-aware: a TMA the aircraft is above (past its ceiling) is not
   *  listed here. */
  label: string;
  /** Per-layer colours to blend for this block ([] outside all zones) — from
   *  the same altitude-aware membership. */
  colors: string[];
}

interface SegPoint {
  lon: number;
  lat: number;
  altitude_ft: number | null;
  epoch_ts: string;
}

/** Walk a whole trajectory and collapse it into contiguous airspace segments.
 *  Membership is altitude-aware (a climb out of a low CTR drops that zone from
 *  both the label and the tint), so a new block starts wherever the set of
 *  containing volumes changes. Cheap enough to run once per route (the same
 *  bbox-reject + ray-cast as the live label, just over every point). */
export function buildAirspaceSegments(
  index: AirspaceIndex,
  points: ReadonlyArray<SegPoint>,
): AirspaceSegment[] {
  if (points.length === 0 || !index.bacc) return [];
  const base = new Date(points[0].epoch_ts).getTime();
  let cur: AirspaceSegment | null = null;
  const segs: AirspaceSegment[] = [];
  for (const p of points) {
    const t = (new Date(p.epoch_ts).getTime() - base) / 1000;
    const full = airspaceAt(index, p.lon, p.lat, p.altitude_ft ?? null);
    // PDR (prohibited/danger/restricted) is EXCLUDED from the profile blocks:
    // those areas are assumed CLOSED (a flight wouldn't be routed through an
    // active one), so they must not tint or label the altitude chart as a
    // "sector". Only the controlling ATS volume (CTR/TMA/BACC/subsector) counts.
    const m = full.pdr ? { ...full, pdr: undefined } : full;
    const label = formatAirspace(m, "compact");
    if (cur && cur.label === label) {
      cur.t1 = t;
    } else {
      if (cur) cur.t1 = t; // stitch: previous block runs up to this transition
      cur = { t0: t, t1: t, membership: m, label, colors: membershipColors(m) };
      segs.push(cur);
    }
  }
  if (segs.length) segs[0].t0 = 0; // first block anchors at the departure edge
  return segs;
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

/** Sector code for display. 3S and 6S are modelled as two altitude slabs
 *  (``3S_lower`` FL0–270, ``3S_upper`` FL270–460 — the part below 2S vs beside
 *  it), but a target is called just "3S" / "6S" regardless of slab (per BACC
 *  ops): strip the ``_lower``/``_upper`` suffix. The altitude test already put
 *  the aircraft in the right slab; the suffix is a data-modelling detail, not
 *  something a controller says. */
function sectorLabel(code: string): string {
  return code.replace(/_(lower|upper)$/i, "");
}

/** Airspace hierarchy — an aircraft is in exactly ONE airspace at a time, so a
 *  point that falls inside several overlapping volumes resolves to one. Order
 *  (highest first), per the BACC ops structure:
 *
 *    1. **PDR** — prohibited/danger/restricted. Not an ATS unit, but being
 *       inside one is the fact that matters, so it overrides.
 *    2. **CTR** — Control Zone, worked by Aerodrome Control (Tower).
 *    3. **TMA** — Terminal Control Area, worked by Approach Control.
 *       (A CTA would sit here too — none in the Thai dataset.)
 *    4. **BACC sector** — Area Control (ACC). This is the reporting unit; it
 *       carries the vertical limits (2S FL270–460, 3S/6S below).
 *    5. **subsector** — the horizontal controller-split, used only when a
 *       sector is divided. It sits INSIDE its sector, so with the sector
 *       above it a target normally reports the sector; the subsector shows
 *       only where no sector is defined.
 *
 *  Annex 11 airspace/ATS-unit structure, resolved AFTER the lateral and
 *  vertical tests — an aircraft above a CTR's ceiling has already dropped out
 *  of it and falls through to the TMA/ACC below.
 *  Must stay in step with _HIERARCHY in trajectory_sim/airspace.py. */
const HIERARCHY = ["pdr", "ctr", "tma", "bacc", "subsector"] as const;

/** Which layer owns the aircraft here, or null when it is in none. */
export function controllingLayer(
  m: AirspaceMembership | undefined,
): SectorKey | null {
  if (isEmptyAirspace(m)) return null;
  const mm = m as AirspaceMembership;
  for (const key of HIERARCHY) {
    if (key === "pdr" ? mm.pdr?.length : mm[key]) return key;
  }
  return null;
}

/** Human string for the ONE airspace that owns the aircraft (see
 *  {@link HIERARCHY}). `compact` (plane label / graph) shows a PDR by its
 *  ident, `full` (Results rows) spells it out. "" when in no airspace. */
export function formatAirspace(
  m: AirspaceMembership | undefined,
  mode: "compact" | "full",
): string {
  const key = controllingLayer(m);
  if (key === null) return "";
  const mm = m as AirspaceMembership;
  switch (key) {
    case "pdr":
      return mode === "compact"
        ? (mm.pdr as string[]).map((p) => p.split(" ")[0]).join(",")
        : (mm.pdr as string[]).map(titleZone).join(" · ");
    case "ctr":
      return titleZone(mm.ctr as string);
    case "tma":
      return titleZone(mm.tma as string);
    default:
      return sectorLabel(mm[key] as string);
  }
}
