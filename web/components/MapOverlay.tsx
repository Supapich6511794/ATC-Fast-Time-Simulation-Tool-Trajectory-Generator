"use client";

/**
 * MapOverlay — floating controls on top of the map:
 *   - mobile hamburger (toggles the sidebar drawer on small screens)
 *   - theme toggle (dark / light UI)
 *   - basemap selector (streets / satellite / dark)
 *   - Airspace panel with a FIR layer toggle (styled after the reference UI)
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
  airwayOn: boolean;
  onAirway: (on: boolean) => void;
  waypointsOn: boolean;
  onWaypoints: (on: boolean) => void;
  firOn: boolean;
  onFir: (on: boolean) => void;
  firLoading: boolean;
  /** Airspace sector visibility (BACC / subsector / CTR / TMA / PDR) for the
   *  standalone Airspace dropdown. */
  sectorsOn: Record<SectorKey, boolean>;
  onToggleSector: (key: SectorKey) => void;
  /** Open the tabbed Layer Options panel (Airports / SID / STAR / …). */
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
  airwayOn,
  onAirway,
  waypointsOn,
  onWaypoints,
  firOn,
  onFir,
  firLoading,
  sectorsOn,
  onToggleSector,
  onOpenLayers,
  onToggleSidebar,
  onZoomIn,
  onZoomOut,
}: Props) {
  // Only one toolbar dropdown is open at a time — opening one closes the other,
  // so the Layers and Airspace popovers can never overlap.
  const [openMenu, setOpenMenu] = useState<"layers" | "airspace" | null>(null);
  const airspaceOpen = openMenu === "layers";

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
          <div className="ov-layers-wrap">
            <button
              className={`ov-chip${airspaceOpen ? " active" : ""}`}
              onClick={() =>
                setOpenMenu((m) => (m === "layers" ? null : "layers"))
              }
              title="Map layers"
            >
              🗂 Layers
            </button>

            {airspaceOpen && (
              <div className="ov-airspace">
                <label className="ov-air-item">
                  <input
                    type="checkbox"
                    checked={airwayOn}
                    onChange={(e) => onAirway(e.target.checked)}
                  />
                  <span>Airway network</span>
                </label>
                <label className="ov-air-item">
                  <input
                    type="checkbox"
                    checked={waypointsOn}
                    onChange={(e) => onWaypoints(e.target.checked)}
                  />
                  <span>Waypoints</span>
                </label>
                <label className="ov-air-item">
                  <input
                    type="checkbox"
                    checked={firOn}
                    onChange={(e) => onFir(e.target.checked)}
                  />
                  <span>FIR</span>
                  {firLoading && <em className="ov-loading">loading…</em>}
                </label>
                <button
                  type="button"
                  className="ov-air-more"
                  onClick={() => {
                    onOpenLayers();
                    setOpenMenu(null);
                  }}
                >
                  ⚙ More Layer Options
                </button>
              </div>
            )}
          </div>

          {/* Standalone Airspace dropdown (sector polygons), beside Layers. */}
          <AirspaceMenu
            open={openMenu === "airspace"}
            onOpenChange={(o) => setOpenMenu(o ? "airspace" : null)}
            sectorsOn={sectorsOn}
            onToggleSector={onToggleSector}
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
