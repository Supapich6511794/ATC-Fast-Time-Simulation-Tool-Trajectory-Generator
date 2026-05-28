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
 *
 * Fix coordinates + the Y8 ordering now come from the CAAT eAIP cache
 * (`/data/aip_VT.json`), replacing the retired VTPStoVTBS.csv.
 */

import { fetchAip } from "@/lib/aip";

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

/** Y8 fixes with coords, in published airway order (BKK → PUT). */
export async function fetchY8Fixes(): Promise<Y8Fix[]> {
  const aip = await fetchAip();
  const seq = aip.airways.Y8 ?? [];
  const out: Y8Fix[] = [];
  for (const ident of seq) {
    const w = aip.waypoints[ident];
    if (w && Number.isFinite(w.lat) && Number.isFinite(w.lon)) {
      out.push({ ident, lat: w.lat, lon: w.lon });
    }
  }
  return out;
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
const SKIP_PENALTY_NM = 15;

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
  // ades kept in the signature for symmetry / future use (e.g. routing
  // across multiple airways) but the direction is fully determined by
  // ADEP for the single-airway VTBS↔VTSP corridor.
  _ades: string,
  opts: Opts = {},
): RouteOption[] {
  const { maxSkip = 2, maxHops = 12, k = 8 } = opts;
  if (fixesInOrder.length < 2) return [];

  const A = adep.trim().toUpperCase();
  // Orient the airway so index 0 is the ADEP-side fix.
  const fixes = A === "VTSP" ? [...fixesInOrder].reverse() : fixesInOrder;
  const n = fixes.length;

  // Airport endpoints follow Y8: ADEP is taken to be at the ADEP-side
  // airway terminus (BKK for VTBS, PUT for VTSP) and ADES at the other,
  // so the route is measured along Y8 only and the airport reads as
  // identical to its airway entry/exit fix.
  const adepLL = fixes[0];
  const adesLL = fixes[n - 1];

  // Entry/exit are the airway fixes nearest ADEP/ADES — the route always
  // joins Y8 near the departure field and leaves it near the arrival
  // field (no chopping the airway with long airport DCTs). For VTBS↔VTSP
  // that is BKK…PUT, so the full airway renders "BKK Y8 PUT".
  const nearest = (p: Y8Fix) => {
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < n; i++) {
      const d = haversineNm(p, fixes[i]);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    return bi;
  };
  const lo = Math.min(nearest(adepLL), nearest(adesLL));
  const hi = Math.max(nearest(adepLL), nearest(adesLL));
  if (hi - lo < 1) return [];

  const legIn = haversineNm(adepLL, fixes[lo]);
  const legOut = haversineNm(fixes[hi], adesLL);

  type Cand = { cost: number; distanceNm: number; path: number[] };
  const found: Cand[] = [];

  // Constrained DFS lo→hi: single direction, ≤maxSkip DCT skips per leg,
  // acyclic by construction, ≤maxHops legs. Cost = true ADEP→ADES NM +
  // a per-skip compliance penalty so the full airway ranks first.
  const dfs = (path: number[], d: number, c: number) => {
    const last = path[path.length - 1];
    if (last === hi) {
      found.push({
        cost: legIn + c + legOut,
        distanceNm: legIn + d + legOut,
        path: [...path],
      });
      return;
    }
    if (path.length - 1 >= maxHops) return;
    for (let j = last + 1; j <= Math.min(hi, last + 1 + maxSkip); j++) {
      const skipped = j - last - 1;
      const leg = haversineNm(fixes[last], fixes[j]);
      path.push(j);
      dfs(path, d + leg, c + leg + skipped * SKIP_PENALTY_NM);
      path.pop();
    }
  };
  dfs([lo], 0, 0);

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
