"use client";

/**
 * MapOverlay — floating controls on top of the map:
 *   - mobile hamburger (toggles the sidebar drawer on small screens)
 *   - theme toggle (dark / light UI)
 *   - basemap selector (streets / satellite / dark)
 *   - Layers button (opens the Layer Options panel directly) + standalone
 *     Airspace menu (airways / waypoints / FIR live in Layer Options → Airway)
 */

import { memo, useState } from "react";

import AirspaceMenu from "@/components/AirspaceMenu";
import type { SectorKey } from "@/lib/geojson";
import type { Basemap, Theme } from "@/lib/mapPrefs";

interface Props {
  theme: Theme;
  onTheme: (t: Theme) => void;
  basemap: Basemap;
  onBasemap: (b: Basemap) => void;
  /** Airspace sector visibility (BACC / subsector / CTR / TMA / PDR) for the
   *  standalone Airspace dropdown. */
  sectorsOn: Record<SectorKey, boolean>;
  onToggleSector: (key: SectorKey) => void;
  /** How sector polygons are coloured: by zone (legend), distinct per sector,
   *  or by altitude. */
  sectorColorMode: "zone" | "sector" | "altitude";
  onSectorColorMode: (mode: "zone" | "sector" | "altitude") => void;
  /** Open the tabbed Layer Options panel (Airports / Airway / SID / …) —
   *  the Layers button goes straight there (no intermediate dropdown). */
  onOpenLayers: () => void;
  onToggleSidebar: () => void;
  /** Custom map zoom drivers — the built-in Leaflet zoom control is
   *  disabled so a matching +/− pair can sit inline with this toolbar. */
  onZoomIn?: () => void;
  onZoomOut?: () => void;
}

// Memoised: stays mounted while the aircraft animates (MapApp re-renders
// ~60×/sec); its props are stable so React can skip it on those frames.
function MapOverlay({
  theme,
  onTheme,
  basemap,
  onBasemap,
  sectorsOn,
  onToggleSector,
  sectorColorMode,
  onSectorColorMode,
  onOpenLayers,
  onToggleSidebar,
  onZoomIn,
  onZoomOut,
}: Props) {
  // The Airspace popover is the only toolbar dropdown left (the Layers button
  // opens the Layer Options panel directly); other controls still close it.
  const [openMenu, setOpenMenu] = useState<"airspace" | null>(null);

  return (
    <>
      {/* Mobile-only: open/close the sidebar drawer. */}
      <button
        className="ov-hamburger"
        onClick={onToggleSidebar}
        aria-label="Toggle menu"
      >
        ☰
      </button>

      <div className="ov-top">
        <div className="ov-group">
          {/* Straight to the tabbed Layer Options panel — every map layer
              (Airports / Gates / Airway / SID / STAR / …) lives there now. */}
          <button
            className="ov-chip"
            onClick={() => {
              onOpenLayers();
              setOpenMenu(null);
            }}
            title="Layer options"
          >
            🗂 Layers
          </button>

          {/* Standalone Airspace dropdown (sector polygons), beside Layers. */}
          <AirspaceMenu
            open={openMenu === "airspace"}
            onOpenChange={(o) => setOpenMenu(o ? "airspace" : null)}
            sectorsOn={sectorsOn}
            onToggleSector={onToggleSector}
            colorMode={sectorColorMode}
            onColorMode={onSectorColorMode}
          />

          <select
            className="ov-select"
            value={basemap}
            // Close BEFORE the native option list opens, so the two
            // dropdowns never overlap.
            onMouseDown={() => setOpenMenu(null)}
            onFocus={() => setOpenMenu(null)}
            onChange={(e) => {
              onBasemap(e.target.value as Basemap);
              setOpenMenu(null);
            }}
            title="Base map"
          >
            <option value="dark">🌑 Dark</option>
            <option value="streets">🗺 Streets</option>
            <option value="satellite">🛰 Satellite</option>
          </select>

          <button
            className="ov-chip"
            onClick={() => {
              onTheme(theme === "dark" ? "light" : "dark");
              setOpenMenu(null); // close any open dropdown
            }}
            title="Toggle light / dark mode"
          >
            {theme === "dark" ? "☀ Light" : "🌙 Dark"}
          </button>

          {(onZoomIn || onZoomOut) && (
            <div
              className="ov-zoom"
              role="group"
              aria-label="Map zoom"
            >
              <button
                type="button"
                className="ov-chip ov-zoom-btn"
                onClick={() => {
                  onZoomIn?.();
                  setOpenMenu(null);
                }}
                title="Zoom in"
                aria-label="Zoom in"
              >
                +
              </button>
              <button
                type="button"
                className="ov-chip ov-zoom-btn"
                onClick={() => {
                  onZoomOut?.();
                  setOpenMenu(null);
                }}
                title="Zoom out"
                aria-label="Zoom out"
              >
                −
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export default memo(MapOverlay);
