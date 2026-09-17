/** Shared UI-preference types for the map (theme + basemap). */

export type Theme = "dark" | "light";
export type Basemap = "dark" | "light" | "streets" | "satellite";

export interface TileSource {
  url: string;
  attribution: string;
  /** Optional second layer drawn over the base. Esri splits its canvas
   *  basemaps into a label-free base and a separate reference layer of place
   *  names. Left unset on the dark basemap on purpose — see ESRI_DARK — but
   *  kept on the type, since a source that needs an overlay is a normal thing
   *  for a tile provider to want. */
  labelUrl?: string;
  /** CSS classes put on the tile containers, so a source can be colour-graded
   *  in `globals.css`. Used to darken Esri's Dark Gray canvas down to the
   *  CARTO Dark Matter tone the map is built around; CARTO itself needs no
   *  grading and leaves these unset. */
  className?: string;
  labelClassName?: string;
}

/**
 * Dark basemap: Esri Dark Gray Canvas BASE, and nothing else.
 *
 * Surveyed tiles, so the coastline matches the real world at every zoom — a
 * generalised vector coastline does not, which is why this is a tile and not a
 * polygon set.
 *
 * The BASE alone, never the matching reference layer. Measured over Thailand at
 * z7: 13.6% of this tile's pixels differ from the land/water fill and every one
 * is within +/-2 grey of it, i.e. anti-aliasing rather than features. CARTO's
 * `dark_nolabels` came to 21.5% at distinctly separate greys — its road,
 * province and river network, which is exactly the city-level detail this map
 * must not show. Esri keeps all of that, and the place names, in the reference
 * layer, so its base can be used bare and CARTO's cannot.
 *
 * Country borders are not in the base either, and are deliberately not added:
 * the dark map shows land, sea and the traffic on them, and nothing else.
 *
 * Esri's canvas is much lighter than a night-radar map wants (land #414143), so
 * `.basemap-dark-base` grades it down; see the measured values in globals.css.
 */
const ESRI_DARK: TileSource = {
  url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
  attribution: "Tiles &copy; Esri — Esri, DeLorme, NAVTEQ",
  className: "basemap-dark-base",
};

/**
 * Light basemap: Esri Light Gray Canvas, the surveyed sibling of the dark
 * canvas above — same coastline, same generalisation, inverted tone. Its
 * reference layer IS kept here, unlike the dark map's: a pale map with no
 * place names reads as blank paper, and the overlays are dark on it, so the
 * labels do not fight them.
 */
const ESRI_LIGHT: TileSource = {
  url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
  labelUrl:
    "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
  attribution: "Tiles &copy; Esri — Esri, DeLorme, NAVTEQ",
};

/** Tile sources per basemap. `dark` follows the dark UI theme. */
export const BASEMAPS: Record<Basemap, TileSource> = {
  streets: {
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  },
  satellite: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution:
      "Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics",
  },
  dark: ESRI_DARK,
  light: ESRI_LIGHT,
};
