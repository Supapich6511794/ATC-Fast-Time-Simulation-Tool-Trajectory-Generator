/**
 * routePreview — turn the in-progress route input into a list of map
 * coordinates so the LeafletMap can show a faint live highlight as the
 * user types or picks waypoints (before they press Generate).
 *
 * Only EXACT ident matches contribute a point — partially-typed tokens
 * (e.g. "VANK" before "VANKO") are ignored so the preview appears the
 * moment a full waypoint name is recognised, not for every keystroke.
 *
 * If two consecutive matched fixes are both on the Y8 airway and the
 * route uses "Y8" between them, the intermediate Y8 fixes are filled in
 * so the preview matches what the generator would actually fly.
 *
 * The ADEP/ADES airports are deliberately NOT added as preview points —
 * the user composes the en-route portion (BKK Y8 PUT) and the airport
 * legs are implicit, so showing extra VTBS/VTSP dots next to BKK/PUT
 * would just clutter the same spot.
 */
import type { Y8Fix } from "./y8Routes";

export interface PreviewPoint {
  ident: string;
  lat: number;
  lon: number;
  /** True if the ident came directly from the user's text/picks; false
   *  if it was filled in by Y8 expansion (so the UI can render it
   *  slightly fainter as an inferred — not user-typed — fix). */
  fromUser: boolean;
}

/** Airway-designator pattern: Y8, Y8A, M300 etc. Only Y8 is expanded; the
 *  rest are treated as plain connectors (skipped, no fix lookup). */
const AIRWAY_RE = /^[A-Z]\d+[A-Z]?$/;

/** Parse a route string into preview points. Only fixes the user typed
 *  (or that fall between two typed fixes on Y8) are emitted — airports
 *  are intentionally not added so the preview matches what the user
 *  actually picked. */
export function resolveRoutePreview(
  routeStr: string,
  y8Fixes: Y8Fix[],
): PreviewPoint[] {
  const lookup = new Map<string, { lat: number; lon: number }>();
  for (const f of y8Fixes) lookup.set(f.ident, { lat: f.lat, lon: f.lon });

  const y8Index = new Map<string, number>();
  y8Fixes.forEach((f, i) => y8Index.set(f.ident, i));

  const out: PreviewPoint[] = [];
  const push = (ident: string, fromUser: boolean) => {
    const ll = lookup.get(ident);
    if (!ll) return;
    // Skip consecutive duplicates — a route like "BKK Y8 BKK" shouldn't
    // double-mark BKK, but a legitimate fix repeated far apart still can.
    if (out.length && out[out.length - 1].ident === ident) return;
    out.push({ ident, lat: ll.lat, lon: ll.lon, fromUser });
  };

  const tokens = routeStr.trim().toUpperCase().split(/\s+/).filter(Boolean);
  let prevIdent: string | null = null;
  let pendingAirway: string | null = null;

  for (const t of tokens) {
    if (t === "DCT") {
      pendingAirway = null;
      continue;
    }
    if (AIRWAY_RE.test(t) && !lookup.has(t)) {
      pendingAirway = t;
      continue;
    }
    if (lookup.has(t)) {
      // Expand a "<fix> Y8 <fix>" span into all Y8 fixes between them.
      if (
        pendingAirway === "Y8" &&
        prevIdent &&
        y8Index.has(prevIdent) &&
        y8Index.has(t)
      ) {
        const i = y8Index.get(prevIdent)!;
        const j = y8Index.get(t)!;
        const step = i < j ? 1 : -1;
        for (let k = i + step; k !== j; k += step) {
          push(y8Fixes[k].ident, false);
        }
      }
      push(t, true);
      prevIdent = t;
      pendingAirway = null;
    } else {
      // Unknown token — likely an ident still being typed. Just skip;
      // it'll be picked up once the user finishes the name.
      pendingAirway = null;
    }
  }

  return out;
}

/** Convenience: turn an ordered list of idents (RouteBuilder output)
 *  into preview points. No Y8 expansion — the user already picked the
 *  fixes they want. */
export function resolvePreviewFromIdents(
  idents: string[],
  y8Fixes: Y8Fix[],
): PreviewPoint[] {
  if (idents.length === 0) return [];
  return resolveRoutePreview(idents.join(" DCT "), y8Fixes);
}

/** Convenience: full Y8 between ADEP and ADES (for the Airway-CSV
 *  route mode, where the route is implicit). ADEP only decides which
 *  end of the airway to start from; the airport itself is not drawn. */
export function resolvePreviewFullY8(
  y8Fixes: Y8Fix[],
  adep: string,
): PreviewPoint[] {
  if (y8Fixes.length < 2) return [];
  const A = adep.trim().toUpperCase();
  const ordered = A === "VTSP" ? [...y8Fixes].reverse() : y8Fixes;
  const first = ordered[0].ident;
  const last = ordered[ordered.length - 1].ident;
  return resolveRoutePreview(`${first} Y8 ${last}`, y8Fixes);
}
