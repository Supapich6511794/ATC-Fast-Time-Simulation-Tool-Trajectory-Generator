/** Shared UI-preference types for the map (theme + basemap). */

export type Theme = "dark" | "light";
export type Basemap = "streets" | "satellite" | "dark";

export interface TileSource {
  url: string;
  attribution: string;
  /** Optional second layer drawn over the base. Esri splits its canvas
   *  basemaps into a label-free base and a separate reference layer (place
   *  names, boundaries), so its dark map needs both to read like the single
   *  CARTO tile. CARTO bakes labels into `dark_all` and leaves this unset. */
  labelUrl?: string;
  /** CSS classes put on the tile containers, so a source can be colour-graded
   *  in `globals.css`. Used to darken Esri's Dark Gray canvas down to the
   *  CARTO Dark Matter tone the map is built around; CARTO itself needs no
   *  grading and leaves these unset. */
  className?: string;
  labelClassName?: string;
}

/**
 * CARTO basemap API key.
 *
 * CARTO moved their basemaps behind an API key: unauthenticated requests to
 * `basemaps.cartocdn.com` still return a tile, but one stamped "API KEY
 * REQUIRED" across it. Set `NEXT_PUBLIC_CARTO_API_KEY` (free key from
 * carto.com) to get the Dark Matter basemap back.
 *
 * `NEXT_PUBLIC_*` is inlined at BUILD time, so this has to be set before
 * `npm run build` / `npm run dev`, not at runtime — same as
 * `NEXT_PUBLIC_API_BASE`. See DEPLOY.md.
 */
const CARTO_API_KEY = process.env.NEXT_PUBLIC_CARTO_API_KEY ?? "";

/** CARTO Dark Matter — the original dark basemap. Only usable with a key.
 *
 *  The parameter is `key`, NOT `api_key` — CARTO's own Leaflet example and the
 *  basemaps FAQ both use `?key=YOUR_KEY`. Getting it wrong fails silently: the
 *  tiles still return 200, just watermarked, exactly as if no key were set.
 *  Host and path follow the documented form (`basemaps.cartocdn.com/rastertiles/
 *  <style>`) rather than the older `{s}.`-sharded one, so there is no chance of
 *  the key being rejected on an undocumented endpoint. */
const CARTO_DARK: TileSource = {
  url:
    "https://basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png?key=" +
    CARTO_API_KEY,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
};

/** Esri Dark Gray Canvas — the keyless fallback, used when no CARTO key is
 *  configured so the map is never served watermarked. Same host as the
 *  satellite basemap, which has always been keyless.
 *
 *  Esri's canvas is much lighter than Dark Matter (land #414143 against CARTO's
 *  #090909), which washes out the cyan/amber airspace overlays this map is
 *  designed around. The `.basemap-dark-*` classes grade it back down — see the
 *  measured values in globals.css. */
const ESRI_DARK: TileSource = {
  url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
  labelUrl:
    "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
  attribution: "Tiles &copy; Esri — Esri, DeLorme, NAVTEQ",
  className: "basemap-dark-base",
  labelClassName: "basemap-dark-labels",
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
  dark: CARTO_API_KEY ? CARTO_DARK : ESRI_DARK,
};

/** True when the dark basemap is the CARTO original rather than the keyless
 *  fallback. Lets the UI point at the missing key instead of leaving someone
 *  wondering why the map looks different. */
export const usingCartoDark = CARTO_API_KEY !== "";
