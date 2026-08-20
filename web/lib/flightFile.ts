/**
 * flightFile — parse an uploaded flight-plan file into editable fields.
 *
 * The web does NO trajectory math; this only turns a .csv / .json /
 * .geojson upload into a plain record so the form can be pre-filled and
 * the user can still adjust everything before generating. Best-effort and
 * forgiving: unknown columns/keys are ignored, missing ones stay blank.
 *
 * Accepted shapes
 *   CSV      header row: callsign,actype,adep,ades,eobt,rfl,route,sid,star
 *            (sid/star optional — spliced at ADEP/ADES when present)
 *   JSON     one object, or an array of objects, with those keys
 *   GeoJSON  FeatureCollection — ordered waypoint idents are read from
 *            feature properties and joined into an Item-15 string
 *
 * It also round-trips the files THIS tool exports, so a downloaded
 * trajectory can be re-imported as an editable plan:
 *   CSV      the ATC-style export (ROUTE/DEP/DEST/ACTYPE/FL/ATD header +
 *            the Timestamp,UTC,Callsign,… table). The combined export
 *            (several stacked blocks) yields one plan per block.
 *   GeoJSON  the per-point trajectory export — callsign/actype/adep/ades
 *            are recovered from the point properties (the route string
 *            can't be rebuilt from sampled points; re-type it if needed).
 */

import type { RouteWaypoint, TrajectoryPoint } from "@/lib/trajectory/types";

/** A full 4D trajectory recovered from an uploaded export, so it can be shown
 *  AS-IS (no regeneration). Present only when the file carried per-point samples
 *  (this tool's trajectory CSV / GeoJSON export); absent for plain plan files. */
export interface ImportedTrajectory {
  points: TrajectoryPoint[];
  /** Filed-route waypoints with coordinates (GeoJSON only; empty for CSV). */
  route: RouteWaypoint[];
}

export interface FlightRecord {
  callsign?: string;
  actype?: string;
  adep?: string;
  ades?: string;
  /** datetime-local value: "YYYY-MM-DDTHH:mm" (any trailing Z stripped). */
  eobt?: string;
  /** Flight level in hundreds of feet, e.g. 350. */
  rfl?: number;
  /** Planned cruise ground speed (kt). The panel has always had the field; it
   *  is read back so a filed speed survives the round trip — and because the
   *  departure-separation check compares filed speeds (Doc 4444 §5.6.2). */
  gsKt?: number;
  /** Item-15 style route string. */
  route?: string;
  /** SID name spliced at ADEP / STAR name spliced at ADES (optional). */
  sid?: string;
  star?: string;
  /** PBN instrument approach (IAP) at ADES, e.g. "R09-Z" (optional). */
  approach?: string;
  /** Departure runway at ADEP / arrival runway at ADES, as the RW… transition
   *  identifier (e.g. "RW03L") so it matches the runway picker options. */
  depRwy?: string;
  arrRwy?: string;
  /** Several Item-15 routes flown by ONE flight (the multi-route export).
   *  Set instead of `route` when a flight has more than one route, so the
   *  re-import rebuilds a single plan with a route queue rather than one
   *  tab per route. */
  routes?: string[];
  /** Full 4D samples when the upload was a trajectory export — lets the app
   *  load a previously-downloaded (e.g. post-CD&R-fix) path exactly as saved,
   *  bypassing regeneration. */
  trajectory?: ImportedTrajectory;
}

/** Coerce a phase string to the Phase union (defaults to cruise). */
function asPhase(raw: unknown): TrajectoryPoint["phase"] {
  const s = String(raw ?? "").toLowerCase();
  return s === "climb" || s === "descent" ? s : "cruise";
}

/** Normalise an EOBT to the datetime-local input format. */
function normEobt(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  const s = String(raw).trim();
  if (!s) return undefined;
  // "2026-05-19T08:15:00Z" / "...Z" / "...:15" → "2026-05-19T08:15"
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  return m ? `${m[1]}T${m[2]}` : s.replace(/Z$/i, "");
}

function numOrUndef(raw: unknown): number | undefined {
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function fromObject(o: Record<string, unknown>): FlightRecord {
  const get = (...keys: string[]) => {
    for (const k of keys) {
      const hit = Object.keys(o).find((kk) => kk.toLowerCase() === k);
      if (hit != null && o[hit] !== "" && o[hit] != null)
        return String(o[hit]).trim();
    }
    return undefined;
  };
  return {
    callsign: get("callsign", "acid", "flight")?.toUpperCase(),
    actype: get("actype", "aircraft_type", "aircraft", "type")?.toUpperCase(),
    adep: get("adep", "dep", "origin")?.toUpperCase(),
    ades: get("ades", "des", "dest", "destination")?.toUpperCase(),
    eobt: normEobt(get("eobt", "etd", "departure_time")),
    rfl: numOrUndef(get("rfl", "fl", "level")),
    gsKt: numOrUndef(get("gs", "gs_kt", "ground_speed", "speed_kt")),
    route: get("route", "route_string", "item15"),
    sid: get("sid", "sid_name")?.toUpperCase(),
    star: get("star", "star_name")?.toUpperCase(),
    approach: get("approach", "iap", "approach_name")?.toUpperCase(),
    depRwy: get("dep_rwy", "departure_runway", "dep_runway", "sid_runway")
      ?.toUpperCase(),
    arrRwy: get("arr_rwy", "arrival_runway", "arr_runway", "star_runway")
      ?.toUpperCase(),
  };
}

/** Minimal RFC-ish CSV: comma-separated, optional double-quoted cells. */
function parseCsv(text: string): FlightRecord[] {
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .filter((l) => l.trim() !== "");
  if (lines.length < 2) return [];
  const split = (l: string) =>
    l
      .match(/("([^"]*)"|[^,]*)(,|$)/g)!
      .slice(0, -1)
      .map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").trim());
  const headers = split(lines[0]).map((h) => h.toLowerCase());
  return lines.slice(1).map((line) => {
    const cells = split(line);
    const o: Record<string, unknown> = {};
    headers.forEach((h, i) => (o[h] = cells[i]));
    return fromObject(o);
  });
}

/**
 * Parse the tool's own ATC-style trajectory CSV export back into plan(s).
 *
 * Each flight is a header block —
 *   ROUTE: …   DEP: …   DEST: …   ACTYPE: …   FL: F###   ATD: <ts>
 * — followed by a `Timestamp,UTC,Callsign,Lat,Lon,…` data table. The
 * combined export stacks several such blocks (each behind a `=== FLIGHT n
 * ===` banner); we split on the `ROUTE:` marker so single- and multi-flight
 * exports both yield one record per block.
 */
function parseTrajectoryCsv(text: string): FlightRecord[] {
  const norm = text.replace(/\r/g, "");
  const starts: number[] = [];
  const re = /^ROUTE:/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(norm)) !== null) starts.push(m.index);
  if (starts.length === 0) return [];
  const blocks = starts
    .map((s, i) =>
      norm.slice(s, i + 1 < starts.length ? starts[i + 1] : norm.length),
    )
    .map(parseTrajectoryBlock)
    .filter((r): r is FlightRecord => r != null);
  return mergeSameFlightRoutes(blocks);
}

/**
 * Collapse blocks belonging to the SAME flight into one record carrying
 * every route. The multi-route export writes one block per route (all with
 * the same callsign / EOBT / city pair); without this, re-import would open
 * a separate tab per route even though it's a single flight. Identity is
 * (callsign, EOBT, ADEP, ADES, ACTYPE, RFL); a group with >1 distinct route
 * yields `routes`, otherwise a plain `route`. Group order is preserved.
 */
function mergeSameFlightRoutes(records: FlightRecord[]): FlightRecord[] {
  const groups = new Map<string, FlightRecord[]>();
  const order: string[] = [];
  for (const r of records) {
    const key = [r.callsign, r.eobt, r.adep, r.ades, r.actype, r.rfl]
      .map((x) => x ?? "")
      .join("|");
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(r);
  }
  return order.map((key) => {
    const g = groups.get(key)!;
    const routes = Array.from(
      new Set(
        g.map((r) => r.route?.trim()).filter((x): x is string => !!x),
      ),
    );
    return routes.length > 1
      ? { ...g[0], route: undefined, routes }
      : { ...g[0], route: routes[0] ?? g[0].route };
  });
}

/** Parse one header block of the trajectory CSV into a FlightRecord. */
function parseTrajectoryBlock(block: string): FlightRecord | null {
  const field = (label: string) => {
    const m = block.match(new RegExp(`^${label}:\\s*(.*)$`, "m"));
    return m ? m[1].trim() : undefined;
  };
  const route = field("ROUTE");
  const adep = field("DEP")?.toUpperCase();
  const ades = field("DEST")?.toUpperCase();
  const actype = field("ACTYPE")?.toUpperCase();
  const fl = field("FL"); // "F330"
  const rfl = fl ? numOrUndef(fl.replace(/^F/i, "")) : undefined;
  const eobt = normEobt(field("ATD"));
  const sid = field("SID")?.toUpperCase();
  const star = field("STAR")?.toUpperCase();
  const approach = field("APPROACH")?.toUpperCase();
  const depRwy = field("DEP RWY")?.toUpperCase();
  const arrRwy = field("ARR RWY")?.toUpperCase();

  // Callsign lives in column 3 of the first data row under the table header.
  let callsign: string | undefined;
  const hdr = block.search(/^Timestamp,UTC,Callsign/m);
  if (hdr !== -1) {
    const firstData = block
      .slice(hdr)
      .split("\n")
      .slice(1)
      .find((l) => l.includes(","));
    const cells = firstData?.split(",");
    if (cells && cells[2]?.trim()) callsign = cells[2].trim().toUpperCase();
  }

  // Skip a block that yielded nothing identifiable.
  if (!route && !adep && !ades && !actype) return null;
  const trajectory = pointsFromCsvBlock(block);
  return {
    callsign, actype, adep, ades, eobt, rfl, route, sid, star, approach,
    depRwy, arrRwy,
    ...(trajectory ? { trajectory } : {}),
  };
}

/** Split one CSV line, honouring double-quoted fields (the Sector column may be
 *  a comma-joined list wrapped in quotes). */
function splitCsvLine(line: string): string[] {
  return (line.match(/("([^"]*)"|[^,]*)(,|$)/g) ?? [])
    .slice(0, -1)
    .map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").trim());
}

/** Recover the 4D samples from the `Timestamp,UTC,Callsign,Lat,Lon,Altitude,
 *  Speed,Direction,Phase,Sector,Event,Waypoint,Conflict` data table of one trajectory-CSV
 *  block, plus the filed route from the `Waypoint` marker column. Returns
 *  undefined when there aren't enough rows to form a path (a plan-only block). */
function pointsFromCsvBlock(block: string): ImportedTrajectory | undefined {
  const hdrIdx = block.search(/^Timestamp,UTC,Callsign/m);
  if (hdrIdx === -1) return undefined;
  const lines = block.slice(hdrIdx).split("\n");
  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const wpIdx = header.indexOf("waypoint");
  const points: TrajectoryPoint[] = [];
  const route: RouteWaypoint[] = [];
  for (const line of lines.slice(1)) {
    if (!line.includes(",")) continue;
    const c = splitCsvLine(line);
    if (c.length < 9) continue;
    const lat = Number(c[3]);
    const lon = Number(c[4]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const alt = Number(c[5]);
    const gs = Number(c[6]);
    const trk = Number(c[7]);
    // Column 1 is the ISO-8601 UTC timestamp ("…Z"); fall back to epoch seconds.
    const iso = c[1];
    const epoch_ts =
      iso && /\d{4}-\d{2}-\d{2}/.test(iso)
        ? (normEobtIso(iso) as string)
        : new Date(Number(c[0]) * 1000).toISOString();
    points.push({
      lat,
      lon,
      epoch_ts,
      altitude_ft: Number.isFinite(alt) ? alt : null,
      gs_kt: Number.isFinite(gs) ? gs : 0,
      track_deg: Number.isFinite(trk) ? trk : 0,
      phase: asPhase(c[8]),
    });
    // A named fix marker → a route waypoint at this sample's position, so the
    // re-imported flight's summary lists the same waypoints as when generated.
    const wp = wpIdx >= 0 ? c[wpIdx] : "";
    if (wp) route.push({ ident: wp, lat, lon });
  }
  return points.length >= 2 ? { points, route } : undefined;
}

/** True when the text is one of the tool's trajectory CSV exports rather
 *  than a plain `callsign,actype,…` plan table. */
function isTrajectoryCsv(text: string): boolean {
  return /^ROUTE:/m.test(text) || /^Timestamp,UTC,Callsign/m.test(text);
}

/**
 * GeoJSON → plan. Three shapes are handled, in priority order:
 *   1. This tool's enriched trajectory export — a `route` LineString
 *      feature (and a top-level `route` member) carries the exact Item-15
 *      string + plan metadata, so the selected route round-trips intact.
 *   2. Plain navdata GeoJSON — ordered waypoint idents in feature
 *      properties are joined into a `DCT … DCT` route.
 *   3. The legacy point-only export — only metadata is recoverable; the
 *      route stays blank (it can't be rebuilt from sampled points).
 */
type GeoFeature = {
  properties?: Record<string, unknown>;
  geometry?: { type?: string; coordinates?: unknown };
};

/** Recover one FlightRecord from the features of a single flight. */
function recordFromFeatures(
  features: GeoFeature[],
  base: FlightRecord,
  fallbackRoute: string | undefined,
): FlightRecord {
  let explicitRoute = fallbackRoute;
  let routeProps: Record<string, unknown> | undefined;
  let firstPointProps: Record<string, unknown> | undefined;
  const idents: string[] = [];
  const samples: TrajectoryPoint[] = [];
  const wpMarks: { ident: string; lat: number; lon: number; ts: string }[] = [];
  let routeLine: RouteWaypoint[] = [];

  for (const f of features) {
    const p = f.properties ?? {};
    // (1) The embedded route feature — most reliable source.
    if (
      (p["feature_type"] === "route" || f.geometry?.type === "LineString") &&
      typeof p["route"] === "string" &&
      String(p["route"]).trim()
    ) {
      if (!explicitRoute) explicitRoute = String(p["route"]).trim();
      routeProps = p;
      routeLine = routeWaypointsFrom(f);
      continue;
    }
    // (2) A trajectory sample point (this tool's per-point export): a Point with
    //     a timestamp. Collected for an as-is (no-regen) load.
    if (f.geometry?.type === "Point" && p["epoch_ts"] != null) {
      const coords = f.geometry.coordinates;
      const pt = trajectoryPointFrom(p, Array.isArray(coords) ? coords : []);
      if (pt) {
        samples.push(pt);
        // A named fix marker (the export's `waypoint` column) → a route
        // waypoint at this sample, so the re-import's summary lists them.
        const wp = p["waypoint"];
        if (typeof wp === "string" && wp.trim()) {
          wpMarks.push({ ident: wp.trim(), lat: pt.lat, lon: pt.lon, ts: pt.epoch_ts });
        }
        if (!firstPointProps) firstPointProps = p;
        continue;
      }
    }
    // (3) Ordered waypoint idents (plain navdata geojson).
    const id =
      p["waypoint_identifier"] ??
      p["ident"] ??
      p["name"] ??
      p["id"] ??
      p["fix"];
    if (id != null && String(id).trim()) {
      idents.push(String(id).trim());
    } else if (!firstPointProps) {
      firstPointProps = p; // (4) trajectory sample → metadata fallback
    }
  }

  const metaProps = routeProps ?? firstPointProps;
  const meta = metaProps ? fromObject(metaProps) : {};
  if (!meta.eobt && metaProps?.["epoch_ts"] != null) {
    meta.eobt = normEobt(metaProps["epoch_ts"]);
  }

  const route =
    explicitRoute ??
    (idents.length ? `DCT ${idents.join(" DCT ")} DCT` : undefined) ??
    base.route ??
    meta.route;

  let trajectory: ImportedTrajectory | undefined;
  if (samples.length >= 2) {
    samples.sort((a, b) => a.epoch_ts.localeCompare(b.epoch_ts));
    // Prefer the `waypoint` markers (named fixes along the flown path, in order)
    // for the route; fall back to the filed LineString when none are present.
    wpMarks.sort((a, b) => a.ts.localeCompare(b.ts));
    const wpRoute: RouteWaypoint[] = wpMarks.map((m) => ({
      ident: m.ident,
      lat: m.lat,
      lon: m.lon,
    }));
    trajectory = { points: samples, route: wpRoute.length ? wpRoute : routeLine };
  }

  return { ...meta, ...base, route, ...(trajectory ? { trajectory } : {}) };
}

/** One trajectory sample from a GeoJSON Point feature (`coords` = [lon,lat,alt_m]). */
function trajectoryPointFrom(
  p: Record<string, unknown>,
  coords: unknown[],
): TrajectoryPoint | null {
  const lon = Number(coords[0] ?? p["lon"]);
  const lat = Number(coords[1] ?? p["lat"]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const ts = p["epoch_ts"];
  const epoch_ts = normEobtIso(ts);
  if (!epoch_ts) return null;
  const alt = numOrUndef(p["altitude_ft"]);
  return {
    lat,
    lon,
    epoch_ts,
    altitude_ft: alt ?? null,
    gs_kt: numOrUndef(p["gs_kt"]) ?? 0,
    tas_kt: numOrUndef(p["tas_kt"]) ?? null,
    track_deg: numOrUndef(p["track_deg"]) ?? 0,
    phase: asPhase(p["phase"]),
  };
}

/** Filed-route waypoints from a route LineString feature: zip its coordinates
 *  with the `idents` property (falls back to blank idents when absent). */
function routeWaypointsFrom(f: GeoFeature): RouteWaypoint[] {
  const coords = f.geometry?.coordinates;
  if (!Array.isArray(coords)) return [];
  const idents = f.properties?.["idents"];
  const names = Array.isArray(idents) ? idents.map((x) => String(x)) : [];
  const out: RouteWaypoint[] = [];
  coords.forEach((c, i) => {
    if (Array.isArray(c) && Number.isFinite(Number(c[0])) && Number.isFinite(Number(c[1]))) {
      out.push({ ident: names[i] ?? "", lat: Number(c[1]), lon: Number(c[0]) });
    }
  });
  return out;
}

/** Normalise a timestamp to strict ISO-8601 so `new Date()` parses it
 *  identically across browsers. The GeoJSON export uses a space between the
 *  date and time ("2025-12-23 00:00:00+00:00"); turn it into a "T". */
function normEobtIso(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  const s = String(raw).trim();
  if (!s) return undefined;
  return s.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/, "$1T$2");
}

function parseGeojson(obj: unknown): FlightRecord[] {
  const fc = obj as {
    features?: GeoFeature[];
    properties?: Record<string, unknown>;
    route?: unknown;
  };
  if (!Array.isArray(fc.features)) return [];

  // Split features by flight_key so a combined multi-flight export rebuilds
  // one record per flight (matching the CSV round-trip). Features with no
  // flight_key share a single group (single-flight / plain navdata geojson).
  const groups = new Map<string, GeoFeature[]>();
  const order: string[] = [];
  const SINGLE = "__single__";
  for (const f of fc.features) {
    const fkRaw = f.properties?.["flight_key"];
    const fk = fkRaw != null && String(fkRaw).trim() ? String(fkRaw) : SINGLE;
    if (!groups.has(fk)) {
      groups.set(fk, []);
      order.push(fk);
    }
    groups.get(fk)!.push(f);
  }

  const base = fc.properties ? fromObject(fc.properties) : {};
  // The top-level `route` member only applies to a single-flight file.
  const topRoute =
    typeof fc.route === "string" && fc.route.trim()
      ? fc.route.trim()
      : undefined;

  const records = order.map((fk) =>
    recordFromFeatures(
      groups.get(fk)!,
      base,
      fk === SINGLE ? topRoute : undefined,
    ),
  );
  // Fold a flight's several routes (R1/R2/…) back into one plan, exactly
  // as the multi-route CSV import does.
  return mergeSameFlightRoutes(records);
}

/**
 * Parse one uploaded file. Resolves to every flight record found (CSV/JSON
 * arrays may hold many; GeoJSON yields one route).
 */
export async function parseFlightFile(file: File): Promise<FlightRecord[]> {
  const text = await file.text();
  const name = file.name.toLowerCase();

  if (name.endsWith(".csv")) {
    return isTrajectoryCsv(text) ? parseTrajectoryCsv(text) : parseCsv(text);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${file.name}: not valid JSON/GeoJSON.`);
  }

  if (
    json &&
    typeof json === "object" &&
    (json as { type?: string }).type === "FeatureCollection"
  ) {
    return parseGeojson(json);
  }
  const arr = Array.isArray(json) ? json : [json];
  return arr.map((o) => fromObject(o as Record<string, unknown>));
}
