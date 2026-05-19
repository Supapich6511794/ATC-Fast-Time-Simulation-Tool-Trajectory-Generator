/**
 * flightFile — parse an uploaded flight-plan file into editable fields.
 *
 * The web does NO trajectory math; this only turns a .csv / .json /
 * .geojson upload into a plain record so the form can be pre-filled and
 * the user can still adjust everything before generating. Best-effort and
 * forgiving: unknown columns/keys are ignored, missing ones stay blank.
 *
 * Accepted shapes
 *   CSV      header row: callsign,actype,adep,ades,eobt,rfl,route
 *   JSON     one object, or an array of objects, with those keys
 *   GeoJSON  FeatureCollection — ordered waypoint idents are read from
 *            feature properties and joined into an Item-15 string
 */

export interface FlightRecord {
  callsign?: string;
  actype?: string;
  adep?: string;
  ades?: string;
  /** datetime-local value: "YYYY-MM-DDTHH:mm" (any trailing Z stripped). */
  eobt?: string;
  /** Flight level in hundreds of feet, e.g. 350. */
  rfl?: number;
  /** Item-15 style route string. */
  route?: string;
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
    actype: get("actype", "aircraft", "type")?.toUpperCase(),
    adep: get("adep", "dep", "origin")?.toUpperCase(),
    ades: get("ades", "des", "dest", "destination")?.toUpperCase(),
    eobt: normEobt(get("eobt", "etd", "departure_time")),
    rfl: numOrUndef(get("rfl", "fl", "level")),
    route: get("route", "route_string", "item15"),
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

/** GeoJSON: pull ordered idents from feature properties → Item-15 string. */
function parseGeojson(obj: unknown): FlightRecord[] {
  const fc = obj as {
    features?: { properties?: Record<string, unknown> }[];
    properties?: Record<string, unknown>;
  };
  if (!Array.isArray(fc.features)) return [];
  const idents: string[] = [];
  for (const f of fc.features) {
    const p = f.properties ?? {};
    const id =
      p["waypoint_identifier"] ??
      p["ident"] ??
      p["name"] ??
      p["id"] ??
      p["fix"];
    if (id != null && String(id).trim()) idents.push(String(id).trim());
  }
  const base = fc.properties ? fromObject(fc.properties) : {};
  const route = idents.length
    ? `DCT ${idents.join(" DCT ")} DCT`
    : base.route;
  return [{ ...base, route }];
}

/**
 * Parse one uploaded file. Resolves to every flight record found (CSV/JSON
 * arrays may hold many; GeoJSON yields one route).
 */
export async function parseFlightFile(file: File): Promise<FlightRecord[]> {
  const text = await file.text();
  const name = file.name.toLowerCase();

  if (name.endsWith(".csv")) return parseCsv(text);

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
