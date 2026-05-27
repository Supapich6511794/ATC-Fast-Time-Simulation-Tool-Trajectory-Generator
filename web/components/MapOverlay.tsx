"use client";

/**
 * MapOverlay — floating controls on top of the map:
 *   - mobile hamburger (toggles the sidebar drawer on small screens)
 *   - theme toggle (dark / light UI)
 *   - basemap selector (streets / satellite / dark)
 *   - Airspace panel with a FIR layer toggle (styled after the reference UI)
 */

import { useState } from "react";

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
  onToggleSidebar: () => void;
  /** Custom map zoom drivers — the built-in Leaflet zoom control is
   *  disabled so a matching +/− pair can sit inline with this toolbar. */
  onZoomIn?: () => void;
  onZoomOut?: () => void;
}

export default function MapOverlay({
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
  onToggleSidebar,
  onZoomIn,
  onZoomOut,
}: Props) {
  const [airspaceOpen, setAirspaceOpen] = useState(false);

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
              onClick={() => setAirspaceOpen((v) => !v)}
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
              </div>
            )}
          </div>

          <select
            className="ov-select"
            value={basemap}
            // Close BEFORE the native option list opens, so the two
            // dropdowns never overlap.
            onMouseDown={() => setAirspaceOpen(false)}
            onFocus={() => setAirspaceOpen(false)}
            onChange={(e) => {
              onBasemap(e.target.value as Basemap);
              setAirspaceOpen(false);
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
              setAirspaceOpen(false); // close the Layers panel
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
                  setAirspaceOpen(false);
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
                  setAirspaceOpen(false);
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
