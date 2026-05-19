/**
 * y8Routes — suggest the best Item-15 routes along airway Y8.
 *
 * The VTBS↔VTSP corridor is the single airway Y8 (its ordered fixes come
 * from VTPStoVTBS.csv). We model it as a directed graph and enumerate the
 * valid routes under flight-plan-style constraints, then rank them.
 *
 *   Constraints (constrained DFS — items 1–5 of the spec):
 *     1. fixes lie on Y8 only
 *     2. single direction (index i → j with i < j)
 *     3. DCT skips allowed but limited (skip ≤ maxSkip fixes per leg)
 *     4. no loop (strictly increasing index ⇒ acyclic by construction)
 *     5. bounded hops (≤ maxHops legs)
 *
 *   Ranking ("best" = economical + compliant + realistic, not just
 *   reachable): cost = great-circle NM + a penalty per skipped fix, so
 *   shorter *and* more airway-compliant routes sort first. For this small
 *   linear graph, enumerate-then-sort yields exactly the K-shortest set
 *   (the same result Dijkstra + Yen's would produce, without the
 *   bookkeeping).
 */

const CSV_URL = "/data/VTPStoVTBS.csv";

export interface Y8Fix {
  ident: string;
  lat: number;
  lon: number;
}

export interface RouteOption {
  /** Item-15 string, e.g. "BKK Y8 PUT" or "DCT VANKO Y8 PUT". */
  text: string;
  /** Total great-circle distance (NM), for display. */
  distanceNm: number;
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}

/** Y8 fixes with coords, in airway order (chained by seqno). */
export async function fetchY8Fixes(): Promise<Y8Fix[]> {
  const res = await fetch(CSV_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${CSV_URL}: ${res.status}`);
  const rows = parseCsv(await res.text());
  rows.sort((a, b) => Number(a.seqno) - Number(b.seqno));

  const ordered: Y8Fix[] = [];
  const seen = new Set<string>();
  const push = (id: string, la: string, lo: string) => {
    const lat = Number(la);
    const lon = Number(lo);
    if (id && !seen.has(id) && Number.isFinite(lat) && Number.isFinite(lon)) {
      seen.add(id);
      ordered.push({ ident: id, lat, lon });
    }
  };
  for (const r of rows) {
    push(r.waypoint_identifier, r.waypoint_latitude, r.waypoint_longitude);
    push(
      r.waypoint_identifier_2,
      r.waypoint_latitude_2,
      r.waypoint_longitude_2,
    );
  }
  return ordered;
}

const R_NM = 3440.065;

function haversineNm(a: Y8Fix, b: Y8Fix): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) *
      Math.cos(toRad(b.lat)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Penalty (NM-equivalent) added per skipped fix, biasing toward
 *  airway-compliant routes over aggressive DCT shortcuts. */
const SKIP_PENALTY_NM = 6;

interface Opts {
  /** Max fixes that may be skipped in one DCT leg. */
  maxSkip?: number;
  /** Max number of legs in a route. */
  maxHops?: number;
  /** How many ranked routes to return. */
  k?: number;
}

/** Render a chosen index path to an Item-15 string with Y8/DCT spans. */
function toItem15(path: number[], fixes: Y8Fix[], n: number): string {
  const out: string[] = [path[0] === 0 ? "" : "DCT", fixes[path[0]].ident];
  let i = 1;
  while (i < path.length) {
    // Extend an unbroken airway run (consecutive indices) as one "Y8".
    let j = i;
    while (j < path.length && path[j] === path[j - 1] + 1) j++;
    if (j > i) {
      out.push("Y8", fixes[path[j - 1]].ident);
      i = j;
    } else {
      out.push("DCT", fixes[path[i]].ident);
      i += 1;
    }
  }
  if (path[path.length - 1] !== n - 1) out.push("DCT");
  return out.join(" ").trim().replace(/\s+/g, " ");
}

/**
 * K best Y8 routes for the requested direction. `adep` decides direction
 * (VTSP departure ⇒ reversed airway order); the route always runs from
 * the ADEP-side fix to the ADES-side fix.
 */
export function kBestY8Routes(
  fixesInOrder: Y8Fix[],
  adep: string,
  opts: Opts = {},
): RouteOption[] {
  const { maxSkip = 2, maxHops = 12, k = 8 } = opts;
  if (fixesInOrder.length < 2) return [];

  // Orient the airway so index 0 is the ADEP-side fix.
  const fixes =
    adep.trim().toUpperCase() === "VTSP"
      ? [...fixesInOrder].reverse()
      : fixesInOrder;
  const n = fixes.length;

  type Cand = { cost: number; distanceNm: number; path: number[] };
  const found: Cand[] = [];

  // Every (entry, exit) pair on the airway is a candidate start/end; an
  // entry/exit that isn't the airway end becomes a DCT join in toItem15.
  for (let s = 0; s < n - 1; s++) {
    for (let e = s + 1; e < n; e++) {
      // Temporarily treat s..e as the sub-airway.
      const sub = fixes.slice(s, e + 1);
      const subFound: Cand[] = [];
      const dfsSub = (path: number[], d: number, c: number) => {
        const last = path[path.length - 1];
        if (last === sub.length - 1) {
          subFound.push({ cost: c, distanceNm: d, path: [...path] });
          return;
        }
        if (path.length - 1 >= maxHops) return;
        for (
          let j = last + 1;
          j <= Math.min(sub.length - 1, last + 1 + maxSkip);
          j++
        ) {
          const skipped = j - last - 1;
          const leg = haversineNm(sub[last], sub[j]);
          path.push(j);
          dfsSub(path, d + leg, c + leg + skipped * SKIP_PENALTY_NM);
          path.pop();
        }
      };
      dfsSub([0], 0, 0);
      for (const f of subFound) {
        // Map sub indices back to absolute, render with leading/trailing
        // DCT when the entry/exit isn't the airway terminus.
        const abs = f.path.map((p) => p + s);
        found.push({ cost: f.cost, distanceNm: f.distanceNm, path: abs });
      }
    }
  }

  // Rank, dedupe by rendered string, take K.
  found.sort((a, b) => a.cost - b.cost);
  const seen = new Set<string>();
  const out: RouteOption[] = [];
  for (const c of found) {
    const text = toItem15(c.path, fixes, n);
    if (seen.has(text)) continue;
    seen.add(text);
    out.push({ text, distanceNm: Math.round(c.distanceNm * 10) / 10 });
    if (out.length >= k) break;
  }
  return out;
}
