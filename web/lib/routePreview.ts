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
import type { Fix } from "./aip";

export interface PreviewPoint {
  ident: string;
  lat: number;
  lon: number;
  /** True if the ident came directly from the user's text/picks; false
   *  if it was filled in by airway expansion (so the UI can render it
   *  slightly fainter as an inferred — not user-typed — fix). */
  fromUser: boolean;
}

/** Airway-designator pattern: Y8, A1, M300, UL637 etc. Matched against
 *  the supplied airways map; anything not a known airway is treated as a
 *  plain connector. */
const AIRWAY_RE = /^[A-Z]{1,2}\d+[A-Z]?$/;

/** Parse a route string into preview points. Any `<fix> <airway> <fix>`
 *  span is expanded along that airway (mirrors the server's
 *  `_expand_airways`), so the live preview matches what the generator
 *  will actually fly. Airports are intentionally not added.
 *
 *  @param fixes    all known significant points (ident + coords)
 *  @param airways  designator → ordered ident sequence (all AIP airways)
 */
export function resolveRoutePreview(
  routeStr: string,
  fixes: Fix[],
  airways: Record<string, string[]> = {},
): PreviewPoint[] {
  const lookup = new Map<string, { lat: number; lon: number }>();
  for (const f of fixes) lookup.set(f.ident, { lat: f.lat, lon: f.lon });

  // Per-airway index: designator → (ident → position) for O(1) span fill.
  const awIndex = new Map<string, Map<string, number>>();
  for (const [desig, seq] of Object.entries(airways)) {
    const m = new Map<string, number>();
    seq.forEach((id, i) => m.set(id, i));
    awIndex.set(desig, m);
  }

  const out: PreviewPoint[] = [];
  const push = (ident: string, fromUser: boolean) => {
    const ll = lookup.get(ident);
    if (!ll) return;
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
    // A token is an airway only if it's in the map (and not a known fix).
    if (AIRWAY_RE.test(t) && awIndex.has(t) && !lookup.has(t)) {
      pendingAirway = t;
      continue;
    }
    if (lookup.has(t)) {
      // Expand a "<fix> <airway> <fix>" span into all intervening fixes.
      const idx = pendingAirway ? awIndex.get(pendingAirway) : undefined;
      if (idx && prevIdent && idx.has(prevIdent) && idx.has(t)) {
        const seq = airways[pendingAirway as string];
        const i = idx.get(prevIdent)!;
        const j = idx.get(t)!;
        const step = i < j ? 1 : -1;
        for (let k = i + step; k !== j; k += step) {
          push(seq[k], false);
        }
      }
      push(t, true);
      prevIdent = t;
      pendingAirway = null;
    } else {
      // Unknown token — likely an ident still being typed. Skip.
      pendingAirway = null;
    }
  }

  return out;
}

/** Convenience: turn an ordered list of idents (RouteBuilder output)
 *  into preview points. No airway expansion — the user already picked
 *  the fixes they want. */
export function resolvePreviewFromIdents(
  idents: string[],
  fixes: Fix[],
): PreviewPoint[] {
  if (idents.length === 0) return [];
  return resolveRoutePreview(idents.join(" DCT "), fixes);
}

/** Convenience: full Y8 between its termini (for the legacy Airway-CSV
 *  route mode, VTBS↔VTSP only). ADEP decides which end to start from. */
export function resolvePreviewFullY8(
  fixes: Fix[],
  airways: Record<string, string[]>,
  adep: string,
): PreviewPoint[] {
  const y8 = airways.Y8 ?? [];
  if (y8.length < 2) return [];
  const A = adep.trim().toUpperCase();
  const ordered = A === "VTSP" ? [...y8].reverse() : y8;
  return resolveRoutePreview(
    `${ordered[0]} Y8 ${ordered[ordered.length - 1]}`,
    fixes,
    airways,
  );
}
