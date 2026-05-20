"use client";

/**
 * MapApp — interactive shell.
 *
 * Orchestrates: airway load, the Phase 1 generator panel, UI theme,
 * basemap, lazy FIR layer, the aircraft-animation playback, and the
 * responsive sidebar drawer. Leaflet is mounted via
 * `next/dynamic({ ssr:false })` (App Router requirement).
 */

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";

import GeneratorPanel from "@/components/GeneratorPanel";
import MapOverlay from "@/components/MapOverlay";
import SimControls from "@/components/SimControls";
import { deriveWaypoints, fetchAirways, fetchFir } from "@/lib/geojson";
import { fetchCsvRouteIdents } from "@/lib/routeCsv";
import type { Basemap, Theme } from "@/lib/mapPrefs";
import type { PreviewPoint } from "@/lib/routePreview";
import type { TrajectoryResult } from "@/lib/trajectory/types";
import type { AirwayCollection, FirCollection, Waypoint } from "@/lib/types";
import { useSimPlayback } from "@/lib/useSimPlayback";

const LeafletMap = dynamic(() => import("@/components/LeafletMap"), {
  ssr: false,
  loading: () => <div className="status">Loading map…</div>,
});

export default function MapApp() {
  const [airways, setAirways] = useState<AirwayCollection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trajectories, setTrajectories] = useState<TrajectoryResult[]>([]);
  /** Live (pre-Generate) route previews — one entry per route the user
   *  has typed/picked/queued, each drawn in a distinct colour. */
  const [previewRoutes, setPreviewRoutes] = useState<PreviewPoint[][]>([]);

  // UI prefs.
  const [theme, setTheme] = useState<Theme>("dark");
  const [basemap, setBasemap] = useState<Basemap>("dark");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Reference-layer toggles (shown by default on load).
  const [showAirways, setShowAirways] = useState(true);
  const [showWaypoints, setShowWaypoints] = useState(false);

  // FIR layer (lazy — the file is ~15 MB).
  const [firOn, setFirOn] = useState(false);
  const [fir, setFir] = useState<FirCollection | null>(null);
  const [firLoading, setFirLoading] = useState(false);

  // RouteBuilder picker is restricted to the FPL route's own fixes
  // (VTPStoVTBS.csv / airway Y8), not every fix in the airway file.
  const [routeIdents, setRouteIdents] = useState<string[]>([]);

  // Aircraft animation. The shared clock runs over the longest of the
  // generated routes so every flight finishes within the timeline.
  const longest = useMemo(
    () =>
      trajectories.reduce<TrajectoryResult | null>(
        (best, t) =>
          !best || t.points.length > best.points.length ? t : best,
        null,
      ),
    [trajectories],
  );
  const sim = useSimPlayback(longest?.points);

  useEffect(() => {
    let cancelled = false;
    fetchAirways()
      .then((d) => !cancelled && setAirways(d))
      .catch(
        (e: unknown) =>
          !cancelled &&
          setError(e instanceof Error ? e.message : "Failed to load data"),
      );
    return () => {
      cancelled = true;
    };
  }, []);

  // Load the FPL route's waypoint idents for the RouteBuilder picker.
  useEffect(() => {
    let cancelled = false;
    fetchCsvRouteIdents()
      .then((ids) => !cancelled && setRouteIdents(ids))
      .catch(() => {
        /* picker simply shows nothing if the CSV can't be read */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch FIR once, the first time it is enabled.
  useEffect(() => {
    if (!firOn || fir || firLoading) return;
    setFirLoading(true);
    fetchFir()
      .then(setFir)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to load FIR"),
      )
      .finally(() => setFirLoading(false));
  }, [firOn, fir, firLoading]);

  const waypoints: Waypoint[] = useMemo(
    () => (airways ? deriveWaypoints(airways) : []),
    [airways],
  );

  const isLoading = !airways && !error;

  return (
    <div className={`app theme-${theme}`} data-theme={theme}>
      <aside className={`sidebar${sidebarOpen ? " open" : ""}`}>
        <div className="sidebar-header">
          <h1>Flight Trajectory Generator</h1>
          {/* Mobile-only ✕ — lets the user collapse the panel and see
              the map underneath; on desktop the sidebar is fixed and
              this button is hidden via CSS. */}
          <button
            type="button"
            className="sidebar-close"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close menu"
          >
            ✕
          </button>
        </div>
        <GeneratorPanel
          onResult={(rs) => setTrajectories(rs ?? [])}
          onPreviewChange={setPreviewRoutes}
          waypointIdents={routeIdents}
        />
      </aside>

      {/* Click-away backdrop for the mobile drawer. */}
      {sidebarOpen && (
        <div
          className="sidebar-backdrop"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <main className="map-area">
        {error && <div className="status error">⚠ {error}</div>}
        {isLoading && <div className="status">Loading airway data…</div>}
        {!error && airways && (
          <>
            <MapOverlay
              theme={theme}
              onTheme={setTheme}
              basemap={basemap}
              onBasemap={setBasemap}
              airwayOn={showAirways}
              onAirway={setShowAirways}
              waypointsOn={showWaypoints}
              onWaypoints={setShowWaypoints}
              firOn={firOn}
              onFir={setFirOn}
              firLoading={firLoading}
              onToggleSidebar={() => setSidebarOpen((v) => !v)}
            />
            <LeafletMap
              basemap={basemap}
              airways={showAirways ? airways : null}
              waypoints={showWaypoints ? waypoints : null}
              fir={firOn ? fir : null}
              trajectories={trajectories}
              previewRoutes={previewRoutes}
              simT={sim.simT}
            />
            <SimControls sim={sim} />
          </>
        )}
      </main>
    </div>
  );
}
