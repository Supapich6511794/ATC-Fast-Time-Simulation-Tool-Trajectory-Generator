"use client";

/**
 * MapApp — interactive shell.
 *
 * Orchestrates: airway load, the Phase 1 generator panel, UI theme,
 * basemap, lazy FIR layer, the aircraft-animation playback, and the
 * responsive sidebar drawer. Leaflet is mounted via
 * `next/dynamic({ ssr:false })` (App Router requirement).
 */

import type L from "leaflet";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";

import AltitudeLegend from "@/components/AltitudeLegend";
import DownloadModal, {
  type DownloadInfo,
} from "@/components/DownloadModal";
import FlightTagsMenu, { type TagFields } from "@/components/FlightTagsMenu";
import GeneratorPanel from "@/components/GeneratorPanel";
import MapOverlay from "@/components/MapOverlay";
import NavToolbar, { type NavView } from "@/components/NavToolbar";
import RouteResultTabs from "@/components/RouteResultTabs";
import SimControls from "@/components/SimControls";
import {
  flightOptions,
  matchesFlight,
  matchesRoute,
  routeOptions,
} from "@/lib/flightSearch";
import SearchCombo from "@/components/SearchCombo";
import {
  deriveWaypoints,
  fetchAirways,
  fetchFir,
  fetchSidLines,
  fetchSidWaypoints,
  fetchStarLines,
  fetchStarWaypoints,
} from "@/lib/geojson";
import { fetchProcedure, type ProcedureDto } from "@/lib/api";
import {
  fetchGates,
  fetchIlsLines,
  fetchIlsWaypoints,
  fetchPanelAirports,
  fetchPbnLines,
  fetchPbnWaypoints,
  fetchRunways,
  type GateCollection,
  type PanelAirport,
  type RunwayPoint,
} from "@/lib/atcLayers";
import type { ProcedureSelection } from "@/components/LeafletMap";
import LayerOptions, {
  DEFAULT_PROC_LAYER,
  type ProcLayerState,
} from "@/components/LayerOptions";
import { fetchCsvRouteIdents } from "@/lib/routeCsv";
import type { Basemap, Theme } from "@/lib/mapPrefs";
import type { PreviewPoint } from "@/lib/routePreview";
import type { TrajectoryResult } from "@/lib/trajectory/types";
import type {
  AirwayCollection,
  FirCollection,
  ProcedureLineCollection,
  ProcedureWaypointCollection,
  Waypoint,
} from "@/lib/types";
import { useSimPlayback } from "@/lib/useSimPlayback";

const LeafletMap = dynamic(() => import("@/components/LeafletMap"), {
  ssr: false,
  loading: () => <div className="status">Loading map…</div>,
});

/** Format an altitude constraint DTO as a compact label (e.g. "≤18000ft"). */
function fmtAlt(c: { type: string; alt1_ft?: number | null; alt2_ft?: number | null }): string {
  const a1 = c.alt1_ft ?? null;
  const a2 = c.alt2_ft ?? null;
  switch (c.type) {
    case "AT":
      return a1 != null ? `${a1}ft` : "";
    case "AT_OR_ABOVE":
      return a1 != null ? `≥${a1}ft` : "";
    case "AT_OR_BELOW":
      return a1 != null ? `≤${a1}ft` : "";
    case "BETWEEN":
      return `${a2 ?? "?"}–${a1 ?? "?"}ft`;
    default:
      return "";
  }
}

/** Format a speed constraint DTO as a compact label (e.g. "≤250kt"). */
function fmtSpd(c: { type: string; speed_kt?: number | null }): string {
  const s = c.speed_kt ?? null;
  if (s == null) return "";
  switch (c.type) {
    case "AT":
      return `${s}kt`;
    case "AT_OR_ABOVE":
      return `≥${s}kt`;
    case "AT_OR_BELOW":
      return `≤${s}kt`;
    default:
      return "";
  }
}

export default function MapApp() {
  const [airways, setAirways] = useState<AirwayCollection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trajectories, setTrajectories] = useState<TrajectoryResult[]>([]);
  /** Download URLs that pair 1-to-1 with `trajectories`. Lifted out of
   *  GeneratorPanel so the floating NavToolbar + DownloadModal can read
   *  them without going through GeneratorPanel. */
  const [downloads, setDownloads] = useState<DownloadInfo[]>([]);
  /** Live (pre-Generate) route previews — one entry per route the user
   *  has typed/picked/queued, each drawn in a distinct colour. */
  const [previewRoutes, setPreviewRoutes] = useState<PreviewPoint[][]>([]);
  /** Just the route currently being typed/built in the Generator (the
   *  "section in progress"), for the "Current" preview scope. */
  const [currentPreview, setCurrentPreview] = useState<PreviewPoint[][]>([]);
  /** Whether the live route preview is hidden on the map. Controlled by a
   *  standalone floating button (not tied to the Generator form), so the
   *  user can toggle the preview on/off at any time. Auto-hidden right
   *  after a Generate (the real trajectory takes over) and auto-shown
   *  again the moment the user edits a route. */
  const [previewHidden, setPreviewHidden] = useState(false);
  /** Which routes the preview draws while composing: every route in flight
   *  ("full") or only the section currently being filled in ("current"). */
  const [previewScope, setPreviewScope] = useState<"full" | "current">("full");
  // Editing routes (a new preview set arrives) brings the preview back.
  useEffect(() => {
    setPreviewHidden(false);
  }, [previewRoutes]);
  /** "N / M flights ready" status shown beside the generator title. */
  const [genStatus, setGenStatus] = useState<string>("");
  // Two-scope search for the Route Profile "all routes" views: pick a
  // flight (callsign / ADEP-ADES), then optionally a specific route (empty
  // route box = every route of that flight).
  const [profileFlightQuery, setProfileFlightQuery] = useState("");
  const [profileRouteQuery, setProfileRouteQuery] = useState("");

  // Top-level navigation state. `null` = nothing open; the sidebar
  // is hidden entirely so the map fills the viewport on first load.
  const [nav, setNav] = useState<NavView>(null);
  const [generatedOpen, setGeneratedOpen] = useState(false);
  const [downloadOpen, setDownloadOpen] = useState(false);
  // "All routes" pagination — how many routes are currently shown in
  // the stacked landing view. Starts at 1 (just R1); "Show more"
  // increments by one each click. Reset on every fresh generation.
  const [visibleCount, setVisibleCount] = useState(1);

  // Playback source: which generated route the SimControls clock is
  // bound to. A number picks one route; "all" plays every route on the
  // longest route's timeline (legacy behaviour). The engine itself
  // stays single-instance — only the source changes.
  const [playbackIdx, setPlaybackIdx] = useState<number | "all">(0);

  // Which fields show in each aircraft's map label, toggled by the Flight
  // Tags menu. Defaults to all on (matching the reference design).
  const [tagFields, setTagFields] = useState<TagFields>({
    callsign: true,
    fl: true,
    ias: true,
    hdg: true,
  });

  // Top-center aircraft-type filter. When non-empty, the map shows only
  // flights whose type matches (case-insensitive substring) — every other
  // route line and aircraft icon is hidden. Empty = show all.
  const [acTypeQuery, setAcTypeQuery] = useState("");
  // Distinct aircraft types currently generated, for the search datalist.
  const aircraftTypes = useMemo(
    () =>
      Array.from(
        new Set(
          trajectories.map((t) => t.meta.aircraftType).filter(Boolean),
        ),
      ).sort(),
    [trajectories],
  );
  // How many flights match the active filter (for the inline count hint).
  const acMatchCount = useMemo(() => {
    const q = acTypeQuery.trim().toUpperCase();
    if (!q) return trajectories.length;
    return trajectories.filter((t) =>
      (t.meta.aircraftType ?? "").toUpperCase().includes(q),
    ).length;
  }, [trajectories, acTypeQuery]);

  // Per-route line visibility, keyed by flightKey (stable across removals,
  // unlike an index). A key in the set = that route is hidden on the map.
  // Lets the user declutter the map mid-simulation without deleting routes.
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(new Set());
  const toggleRouteHidden = useCallback((flightKey: string) => {
    setHiddenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(flightKey)) next.delete(flightKey);
      else next.add(flightKey);
      return next;
    });
  }, []);
  // Master toggle: hide every route line at once (show all if all hidden).
  const toggleAllRoutesHidden = useCallback(() => {
    setHiddenKeys((prev) => {
      const allHidden =
        trajectories.length > 0 &&
        trajectories.every((t) => prev.has(t.meta.flightKey));
      return allHidden
        ? new Set<string>()
        : new Set(trajectories.map((t) => t.meta.flightKey));
    });
  }, [trajectories]);
  const allRoutesHidden =
    trajectories.length > 0 &&
    trajectories.every((t) => hiddenKeys.has(t.meta.flightKey));

  // Leaflet map instance, captured via MapRefBridge inside LeafletMap.
  // Used to drive the custom +/− zoom buttons in MapOverlay (the
  // built-in Leaflet zoom control is disabled).
  const [mapInstance, setMapInstance] = useState<L.Map | null>(null);
  const onMapReady = useCallback(
    (m: L.Map | null) => setMapInstance(m),
    [],
  );
  const handleZoomIn = useCallback(() => mapInstance?.zoomIn(), [mapInstance]);
  const handleZoomOut = useCallback(
    () => mapInstance?.zoomOut(),
    [mapInstance],
  );

  // Stable callbacks for the memoised, animation-independent children
  // (GeneratorPanel / NavToolbar / MapOverlay / DownloadModal). Keeping
  // these referentially constant lets React.memo skip those subtrees on
  // every aircraft-animation frame. All state setters are stable, so the
  // dependency lists are empty.
  const handleResult = useCallback(
    (rs: TrajectoryResult[] | null) => {
      const list = rs ?? [];
      setTrajectories(list);
      // Auto-redirect to the "Generated" landing view on a successful
      // generation. Only R1's data is rendered initially; "Show more"
      // reveals the rest one at a time.
      if (list.length > 0) {
        setNav({ kind: "all", section: "both" });
        setVisibleCount(1);
        setProfileFlightQuery("");
        setProfileRouteQuery("");
        setSidebarOpen(true);
        // Fresh generation: every new route starts visible.
        setHiddenKeys(new Set());
        // Hide the faint live preview now the real trajectory is drawn (it
        // sat under the generated line). The standalone button brings it back.
        setPreviewHidden(true);
        // Reset playback source to R1 so the clock starts on the newly
        // generated flight instead of replaying an older route's timeline.
        setPlaybackIdx(0);
      }
    },
    [],
  );
  const handleNavChange = useCallback((n: NavView) => {
    setNav(n);
    if (n !== null) setSidebarOpen(true);
  }, []);
  const openDownload = useCallback(() => setDownloadOpen(true), []);
  const closeDownload = useCallback(() => setDownloadOpen(false), []);
  const toggleSidebar = useCallback(() => setSidebarOpen((v) => !v), []);

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

  // Airports + runways layers (the Layer Options "Airports" tab). Airport
  // markers are controlled per-airport by the list (no master toggle).
  const [airportList, setAirportList] = useState<PanelAirport[]>([]);
  const [hiddenAirports, setHiddenAirports] = useState<Set<string>>(new Set());
  const [showRunways, setShowRunways] = useState(false);
  const [runways, setRunways] = useState<RunwayPoint[]>([]);

  // Gates layer.
  const [gatesOn, setGatesOn] = useState(false);
  const [gates, setGates] = useState<GateCollection | null>(null);

  // Procedure-style layers (SID/STAR/PBN/ILS) — rich state from the panel.
  const [layersOpen, setLayersOpen] = useState(false);
  const [sid, setSid] = useState<ProcLayerState>(DEFAULT_PROC_LAYER);
  const [star, setStar] = useState<ProcLayerState>(DEFAULT_PROC_LAYER);
  const [pbn, setPbn] = useState<ProcLayerState>(DEFAULT_PROC_LAYER);
  const [ils, setIls] = useState<ProcLayerState>(DEFAULT_PROC_LAYER);
  const [sidWpts, setSidWpts] = useState<ProcedureWaypointCollection | null>(
    null,
  );
  const [starWpts, setStarWpts] = useState<ProcedureWaypointCollection | null>(
    null,
  );
  const [pbnLines, setPbnLines] = useState<ProcedureLineCollection | null>(
    null,
  );
  const [pbnWpts, setPbnWpts] = useState<ProcedureWaypointCollection | null>(
    null,
  );
  const [ilsLines, setIlsLines] = useState<ProcedureLineCollection | null>(
    null,
  );
  const [ilsWpts, setIlsWpts] = useState<ProcedureWaypointCollection | null>(
    null,
  );
  // Procedure inspector: legs + constraints fetched when a SID/STAR line is
  // clicked. null = closed.
  const [procView, setProcView] = useState<{
    sel: ProcedureSelection;
    loading?: boolean;
    data?: ProcedureDto;
    error?: string;
  } | null>(null);
  const handleProcedureClick = useCallback((sel: ProcedureSelection) => {
    setProcView({ sel, loading: true });
    // The clicked line's transition_identifier is either a runway (RW…) or
    // an enroute transition fix; route it to the right query param and let
    // the API auto-resolve the other axis.
    const t = (sel.transition ?? "").toUpperCase();
    const isRunway = t.startsWith("RW");
    fetchProcedure(sel.airport, sel.name, {
      type: sel.type,
      runway: isRunway ? sel.transition ?? undefined : undefined,
      transition: isRunway ? undefined : sel.transition ?? undefined,
    })
      .then((data) => setProcView({ sel, data }))
      .catch((e: unknown) =>
        setProcView({
          sel,
          error: e instanceof Error ? e.message : "Failed to load procedure",
        }),
      );
  }, []);
  const [sidLines, setSidLines] = useState<ProcedureLineCollection | null>(
    null,
  );
  const [starLines, setStarLines] = useState<ProcedureLineCollection | null>(
    null,
  );

  // RouteBuilder picker is restricted to the FPL route's own fixes
  // (VTPStoVTBS.csv / airway Y8), not every fix in the airway file.
  const [routeIdents, setRouteIdents] = useState<string[]>([]);

  // Aircraft animation. One playback engine drives the clock; the
  // source is whichever route the user picked (R1, R2, …) or "all",
  // which falls back to the longest route so every flight fits the
  // timeline. The selector lives in SimControls.
  const longest = useMemo(
    () =>
      trajectories.reduce<TrajectoryResult | null>(
        (best, t) =>
          !best || t.points.length > best.points.length ? t : best,
        null,
      ),
    [trajectories],
  );
  // Clamp playbackIdx to the current list (e.g. after a route is
  // removed). "all" stays as-is; numeric out-of-range falls back to R1
  // when at least one route exists.
  const safePlaybackIdx =
    playbackIdx === "all"
      ? "all"
      : trajectories[playbackIdx]
        ? playbackIdx
        : trajectories.length > 0
          ? 0
          : 0;
  const activeTrajectory =
    safePlaybackIdx === "all" ? longest : trajectories[safePlaybackIdx] ?? null;
  const sim = useSimPlayback(activeTrajectory?.points);

  // Spacebar toggles play/pause (like a media player), except while typing
  // in a form field or focusing a button, so the generator inputs, the
  // aircraft-type search, and clickable controls still behave normally.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" && e.key !== " ") return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        tag === "BUTTON" ||
        el?.isContentEditable
      ) {
        return;
      }
      e.preventDefault(); // stop the page from scrolling on Space
      sim.toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sim.toggle]);

  // The sim clock for a given route's altitude chart: the live `simT` when
  // that route is the one being animated on the map ("all" animates every
  // route), else null so its plane parks at the start. Keeps each profile's
  // plane in lock-step with the map aircraft.
  const playSimT = (i: number): number | null =>
    safePlaybackIdx === "all" || safePlaybackIdx === i ? sim.simT : null;

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

  // Airport list for the Layer Options "Airports" tab + map markers.
  useEffect(() => {
    let cancelled = false;
    fetchPanelAirports()
      .then((xs) => !cancelled && setAirportList(xs))
      .catch(() => {
        /* airports simply unavailable if the CSV can't be read */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Runways (threshold points) — fetched the first time they're shown.
  useEffect(() => {
    if (!showRunways || runways.length > 0) return;
    fetchRunways()
      .then(setRunways)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to load runways"),
      );
  }, [showRunways, runways.length]);

  // Gates — fetched the first time the layer is enabled.
  useEffect(() => {
    if (!gatesOn || gates) return;
    fetchGates()
      .then(setGates)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to load gates"),
      );
  }, [gatesOn, gates]);

  // PBN / ILS line data — like SID/STAR, fetched when the panel opens or a
  // routes layer is enabled (so the filter dropdowns can populate).
  const pbnNeedLines = layersOpen || pbn.routes;
  const ilsNeedLines = layersOpen || ils.routes;
  useEffect(() => {
    if (!pbnNeedLines || pbnLines) return;
    fetchPbnLines()
      .then(setPbnLines)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to load PBN lines"),
      );
  }, [pbnNeedLines, pbnLines]);
  useEffect(() => {
    if (!ilsNeedLines || ilsLines) return;
    fetchIlsLines()
      .then(setIlsLines)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to load ILS lines"),
      );
  }, [ilsNeedLines, ilsLines]);
  useEffect(() => {
    if (!pbn.waypoints || pbnWpts) return;
    fetchPbnWaypoints()
      .then(setPbnWpts)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to load PBN fixes"),
      );
  }, [pbn.waypoints, pbnWpts]);
  useEffect(() => {
    if (!ils.waypoints || ilsWpts) return;
    fetchIlsWaypoints()
      .then(setIlsWpts)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to load ILS fixes"),
      );
  }, [ils.waypoints, ilsWpts]);

  // SID/STAR line data — fetched once the Layer Options panel is opened
  // (so the filter dropdowns can populate) or a routes layer is enabled.
  const sidNeedLines = layersOpen || sid.routes;
  const starNeedLines = layersOpen || star.routes;
  useEffect(() => {
    if (!sidNeedLines || sidLines) return;
    fetchSidLines()
      .then(setSidLines)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to load SID lines"),
      );
  }, [sidNeedLines, sidLines]);
  useEffect(() => {
    if (!starNeedLines || starLines) return;
    fetchStarLines()
      .then(setStarLines)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to load STAR lines"),
      );
  }, [starNeedLines, starLines]);

  // SID/STAR waypoint data — fetched the first time Waypoints is enabled.
  useEffect(() => {
    if (!sid.waypoints || sidWpts) return;
    fetchSidWaypoints()
      .then(setSidWpts)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to load SID fixes"),
      );
  }, [sid.waypoints, sidWpts]);
  useEffect(() => {
    if (!star.waypoints || starWpts) return;
    fetchStarWaypoints()
      .then(setStarWpts)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to load STAR fixes"),
      );
  }, [star.waypoints, starWpts]);

  // Distinct airport / procedure options for the SID/STAR filter dropdowns.
  // PROCEDURE options cascade from the AIRPORT selection.
  const procOpts = (
    lines: ProcedureLineCollection | null,
    airportFilter: Set<string>,
  ) => {
    const airports = new Set<string>();
    const procs = new Set<string>();
    for (const f of lines?.features ?? []) {
      const a = f.properties.airport_identifier;
      if (a) airports.add(a);
      if (airportFilter.size === 0 || airportFilter.has(a)) {
        if (f.properties.procedure_identifier) {
          procs.add(f.properties.procedure_identifier);
        }
      }
    }
    return {
      airports: [...airports].sort(),
      procedures: [...procs].sort(),
    };
  };
  const sidOpts = useMemo(
    () => procOpts(sidLines, sid.airports),
    [sidLines, sid.airports],
  );
  const starOpts = useMemo(
    () => procOpts(starLines, star.airports),
    [starLines, star.airports],
  );
  const pbnOpts = useMemo(
    () => procOpts(pbnLines, pbn.airports),
    [pbnLines, pbn.airports],
  );
  const ilsOpts = useMemo(
    () => procOpts(ilsLines, ils.airports),
    [ilsLines, ils.airports],
  );

  // Airport list handlers for the panel.
  const toggleAirport = useCallback((code: string) => {
    setHiddenAirports((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }, []);
  const showAllAirports = useCallback(() => setHiddenAirports(new Set()), []);
  const hideAllAirports = useCallback(
    () => setHiddenAirports(new Set(airportList.map((a) => a.code))),
    [airportList],
  );

  const waypoints: Waypoint[] = useMemo(
    () => (airways ? deriveWaypoints(airways) : []),
    [airways],
  );

  const isLoading = !airways && !error;

  // Remove one finished route by index — clears it from the map AND
  // from the toolbar / modal selections.
  function removeResultAt(i: number) {
    const removedKey = trajectories[i]?.meta.flightKey;
    const next = trajectories.filter((_, k) => k !== i);
    setTrajectories(next);
    setDownloads((xs) => xs.filter((_, k) => k !== i));
    // Drop the removed route's visibility entry so the set can't grow stale.
    if (removedKey) {
      setHiddenKeys((prev) => {
        if (!prev.has(removedKey)) return prev;
        const n = new Set(prev);
        n.delete(removedKey);
        return n;
      });
    }
    // Keep the "all routes" pagination in range when a route is removed.
    setVisibleCount((c) => Math.max(1, Math.min(c, next.length)));
    // And keep the playback source pointing at a still-existing route.
    setPlaybackIdx((p) => {
      if (p === "all") return next.length > 0 ? "all" : 0;
      if (p === i) return 0;
      if (p > i) return p - 1;
      return p;
    });
    if (next.length === 0) {
      setNav({ kind: "generator" });
    } else if (nav?.kind === "route") {
      const curRoute = nav;
      if (curRoute.routeIdx === i) {
        setNav({ kind: "route", routeIdx: 0, section: curRoute.section });
      } else if (curRoute.routeIdx > i) {
        setNav({
          kind: "route",
          routeIdx: curRoute.routeIdx - 1,
          section: curRoute.section,
        });
      }
    }
  }

  // The sidebar is mounted only when a nav item is active. The form
  // (GeneratorPanel) stays mounted across visits to keep its inputs.
  const sidebarVisible = nav !== null;

  // Route Profile "all routes" views: stage 1 narrows to the matched
  // flight(s); stage 2 optionally picks a route within them. Each row keeps
  // its original index for the R-tag / removal.
  const profileFlightRows = useMemo(() => {
    if (nav?.kind !== "all") return [];
    return trajectories
      .map((t, i) => ({ t, d: downloads[i], i }))
      .filter(
        (row): row is { t: TrajectoryResult; d: DownloadInfo; i: number } =>
          !!row.d,
      )
      .filter(({ t }) =>
        matchesFlight(profileFlightQuery, {
          callsign: t.meta.callsign,
          adep: t.meta.adep,
          ades: t.meta.ades,
        }),
      );
  }, [nav, trajectories, downloads, profileFlightQuery]);

  const profileRows = useMemo(
    () =>
      profileFlightRows.filter(({ d, i }) =>
        matchesRoute(profileRouteQuery, { route: d.route, index: i }),
      ),
    [profileFlightRows, profileRouteQuery],
  );

  const profileFlightSugg = useMemo(
    () =>
      flightOptions(
        trajectories.map((t) => ({
          callsign: t.meta.callsign,
          adep: t.meta.adep,
          ades: t.meta.ades,
        })),
      ),
    [trajectories],
  );
  const profileRouteSugg = useMemo(
    () =>
      routeOptions(
        profileFlightRows.map(({ t, d, i }) => ({
          route: d.route,
          index: i,
          distanceNm: t.stats.distanceNm,
        })),
      ),
    [profileFlightRows],
  );

  const activeRouteLabel = (() => {
    if (nav?.kind === "all") {
      const sec =
        nav.section === "vertical"
          ? " · Vertical profile"
          : nav.section === "summary"
            ? " · Trajectory summary"
            : "";
      return trajectories.length === 1 && nav.section === "both"
        ? "R1"
        : `All routes${sec} (${trajectories.length})`;
    }
    if (nav?.kind !== "route") return null;
    const i = nav.routeIdx;
    if (i < 0 || i >= trajectories.length) return null;
    const sec =
      nav.section === "vertical" ? "Vertical profile" : "Trajectory summary";
    return `R${i + 1} · ${sec}`;
  })();

  return (
    <div className={`app theme-${theme}`} data-theme={theme}>
      <aside
        className={`sidebar${sidebarOpen ? " open" : ""}${
          sidebarVisible ? "" : " hidden"
        }`}
      >
        <div className="sidebar-header">
          <h1>Flight Trajectory Generator</h1>
          {nav?.kind === "generator" && genStatus && (
            <span className="sidebar-ready">{genStatus}</span>
          )}
          {/* ✕ closes the sidebar entirely so only the floating tool
              menu remains, regardless of viewport size. */}
          <button
            type="button"
            className="sidebar-close"
            onClick={() => {
              setNav(null);
              setSidebarOpen(false);
            }}
            aria-label="Close panel"
          >
            ✕
          </button>
        </div>

        {activeRouteLabel && (
          <p className="nav-breadcrumb">
            <button
              className="nav-crumb-link"
              onClick={() => setNav({ kind: "generator" })}
            >
              Generator
            </button>
            <span>›</span>
            <strong>{activeRouteLabel}</strong>
          </p>
        )}

        {/* GeneratorPanel is always mounted so its form state is
            preserved — visible only when nav.kind === "generator". */}
        <div
          style={{
            display: nav?.kind === "generator" ? "block" : "none",
          }}
        >
          <GeneratorPanel
            onResult={handleResult}
            onDownloadsChange={setDownloads}
            onPreviewChange={setPreviewRoutes}
            onCurrentPreviewChange={setCurrentPreview}
            onReadyChange={setGenStatus}
            waypointIdents={routeIdents}
          />
        </div>

        {nav?.kind === "route" &&
          trajectories[nav.routeIdx] &&
          downloads[nav.routeIdx] && (
            <RouteResultTabs
              key={downloads[nav.routeIdx].flightKey}
              trajectory={trajectories[nav.routeIdx]}
              download={downloads[nav.routeIdx]}
              routeIndex={
                trajectories.length > 1 ? nav.routeIdx + 1 : null
              }
              onRemove={() => removeResultAt(nav.routeIdx)}
              forceSection={nav.section}
              simT={playSimT(nav.routeIdx)}
            />
          )}

        {nav?.kind === "all" && trajectories.length > 0 && (
          <div className="gen-all">
            {/* Two-scope search: 1) pick a flight (callsign / ADEP-ADES),
                2) optionally a specific route within it (empty = all). */}
            <div className="rp-search">
              <div className="field-row">
                <label className="field">
                  <span>1 · Flight</span>
                  <SearchCombo
                    value={profileFlightQuery}
                    onChange={setProfileFlightQuery}
                    suggestions={profileFlightSugg}
                    placeholder="VTBS VTSP · THA201 — empty = all flights"
                  />
                </label>
                <label className="field">
                  <span>2 · Route</span>
                  <SearchCombo
                    value={profileRouteQuery}
                    onChange={setProfileRouteQuery}
                    suggestions={profileRouteSugg}
                    placeholder="BKK Y8 PUT · R2 — empty = all routes"
                  />
                </label>
              </div>
              <p className="rp-search-count">
                Showing <strong>{profileRows.length}</strong> of{" "}
                {trajectories.length}{" "}
                {trajectories.length === 1 ? "route" : "routes"}
              </p>
            </div>

            {/* "both" overview paginates (heaviest view); the dedicated
                Vertical / Trajectory section views show every match. */}
            {(nav.section === "both"
              ? profileRows.slice(0, visibleCount)
              : profileRows
            ).map(({ t, d, i }) => (
              <RouteResultTabs
                key={d.flightKey}
                trajectory={t}
                download={d}
                routeIndex={trajectories.length > 1 ? i + 1 : null}
                onRemove={() => removeResultAt(i)}
                forceSection={nav.section === "both" ? undefined : nav.section}
                stacked={nav.section === "both"}
                simT={playSimT(i)}
              />
            ))}

            {profileRows.length === 0 && (
              <p className="rp-search-empty">
                No routes match this search. Clear the boxes to see all.
              </p>
            )}

            {nav.section === "both" &&
              visibleCount < profileRows.length && (
                <button
                  type="button"
                  className="gen-show-more"
                  onClick={() =>
                    setVisibleCount((c) =>
                      Math.min(c + 1, profileRows.length),
                    )
                  }
                >
                  ▾ Show more (
                  {profileRows.length - visibleCount} route
                  {profileRows.length - visibleCount === 1 ? "" : "s"} left)
                </button>
              )}

            {nav.section === "both" && visibleCount > 1 && (
              <button
                type="button"
                className="gen-show-less"
                onClick={() => setVisibleCount(1)}
              >
                ▴ Show fewer
              </button>
            )}
          </div>
        )}
      </aside>

      {/* Click-away backdrop for the mobile drawer. */}
      {sidebarOpen && sidebarVisible && (
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
            <NavToolbar
              nav={nav}
              onNavChange={handleNavChange}
              results={trajectories}
              downloads={downloads}
              generatedOpen={generatedOpen}
              onGeneratedOpenChange={setGeneratedOpen}
              onOpenDownload={openDownload}
            />
            {/* Top-center toolbar: Flight Tags menu (left) + aircraft-type
                search (right). Shown once at least one flight is generated. */}
            {trajectories.length > 0 && (
              <div className="map-topbar">
                <FlightTagsMenu fields={tagFields} onChange={setTagFields} />
                <div className="actype-search">
                  <span className="actype-search-ico" aria-hidden>
                    🔎
                  </span>
                  <input
                    type="text"
                    className="actype-search-input"
                    list="actype-options"
                    value={acTypeQuery}
                    onChange={(e) => setAcTypeQuery(e.target.value)}
                    placeholder="Filter by aircraft type — e.g. A320, B789"
                    aria-label="Filter map by aircraft type"
                  />
                  <datalist id="actype-options">
                    {aircraftTypes.map((t) => (
                      <option key={t} value={t} />
                    ))}
                  </datalist>
                  {acTypeQuery.trim() !== "" && (
                    <>
                      <span className="actype-search-count">
                        {acMatchCount} of {trajectories.length}
                      </span>
                      <button
                        type="button"
                        className="actype-search-clear"
                        onClick={() => setAcTypeQuery("")}
                        aria-label="Clear aircraft-type filter"
                        title="Clear filter"
                      >
                        ×
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
            <DownloadModal
              open={downloadOpen}
              onClose={closeDownload}
              results={trajectories}
              downloads={downloads}
            />
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
              onOpenLayers={() => setLayersOpen(true)}
              onToggleSidebar={toggleSidebar}
              onZoomIn={handleZoomIn}
              onZoomOut={handleZoomOut}
            />
            <LayerOptions
              open={layersOpen}
              onClose={() => setLayersOpen(false)}
              airportList={airportList}
              hiddenAirports={hiddenAirports}
              onToggleAirport={toggleAirport}
              onShowAllAirports={showAllAirports}
              onHideAllAirports={hideAllAirports}
              showRunways={showRunways}
              onShowRunways={setShowRunways}
              gatesOn={gatesOn}
              onGatesOn={setGatesOn}
              sid={{
                state: sid,
                onChange: setSid,
                airportOpts: sidOpts.airports,
                procOpts: sidOpts.procedures,
              }}
              star={{
                state: star,
                onChange: setStar,
                airportOpts: starOpts.airports,
                procOpts: starOpts.procedures,
              }}
              pbn={{
                state: pbn,
                onChange: setPbn,
                airportOpts: pbnOpts.airports,
                procOpts: pbnOpts.procedures,
              }}
              ils={{
                state: ils,
                onChange: setIls,
                airportOpts: ilsOpts.airports,
                procOpts: ilsOpts.procedures,
              }}
            />
            <LeafletMap
              basemap={basemap}
              airways={showAirways ? airways : null}
              waypoints={showWaypoints ? waypoints : null}
              fir={firOn ? fir : null}
              sidLines={sidLines}
              starLines={starLines}
              sidWpts={sidWpts}
              starWpts={starWpts}
              pbnLines={pbnLines}
              pbnWpts={pbnWpts}
              ilsLines={ilsLines}
              ilsWpts={ilsWpts}
              sid={sid}
              star={star}
              pbn={pbn}
              ils={ils}
              airports={airportList}
              hiddenAirports={hiddenAirports}
              gates={gatesOn ? gates : null}
              runways={showRunways ? runways : null}
              onProcedureClick={handleProcedureClick}
              trajectories={trajectories}
              hiddenKeys={hiddenKeys}
              typeFilter={acTypeQuery}
              tagFields={tagFields}
              previewRoutes={
                previewHidden
                  ? []
                  : previewScope === "current"
                    ? currentPreview
                    : previewRoutes
              }
              simT={sim.simT}
              playbackIdx={safePlaybackIdx}
              onMapReady={onMapReady}
            />
            {previewRoutes.length > 0 && (
              <div className={`preview-fab${previewHidden ? " off" : ""}`}>
                <button
                  type="button"
                  className="preview-fab-toggle"
                  onClick={() => setPreviewHidden((v) => !v)}
                  aria-pressed={!previewHidden}
                  title={
                    previewHidden
                      ? "Show the live route preview"
                      : "Hide the live route preview"
                  }
                >
                  <span className="preview-fab-ico" aria-hidden>
                    {previewHidden ? "🚫" : "👁"}
                  </span>
                  {previewHidden ? "Show preview" : "Preview"}
                </button>
                {!previewHidden && (
                  <div
                    className="preview-fab-scope"
                    role="group"
                    aria-label="Preview scope"
                  >
                    <button
                      type="button"
                      className={previewScope === "full" ? "active" : undefined}
                      onClick={() => setPreviewScope("full")}
                      title="Preview every route (queued + the one being edited)"
                    >
                      Full ({previewRoutes.length})
                    </button>
                    <button
                      type="button"
                      className={
                        previewScope === "current" ? "active" : undefined
                      }
                      onClick={() => setPreviewScope("current")}
                      disabled={currentPreview.length === 0}
                      title="Preview only the current flight (this tab's routes)"
                    >
                      Current
                    </button>
                  </div>
                )}
              </div>
            )}
            <SimControls
              sim={sim}
              trajectories={trajectories}
              playbackIdx={safePlaybackIdx}
              onPlaybackIdxChange={setPlaybackIdx}
              hiddenKeys={hiddenKeys}
              onToggleRouteHidden={toggleRouteHidden}
              allRoutesHidden={allRoutesHidden}
              onToggleAllRoutes={toggleAllRoutesHidden}
            />
            {trajectories.length > 0 && <AltitudeLegend />}

            {/* Procedure inspector — legs + constraints for a clicked
                SID/STAR track. */}
            {procView && (
              <div className="proc-panel">
                <div className="proc-panel-head">
                  <strong>
                    {procView.sel.type} · {procView.sel.name}
                  </strong>
                  <button
                    type="button"
                    className="proc-panel-close"
                    onClick={() => setProcView(null)}
                    aria-label="Close procedure panel"
                  >
                    ✕
                  </button>
                </div>
                {procView.loading && (
                  <p className="proc-panel-status">Loading legs…</p>
                )}
                {procView.error && (
                  <p className="proc-panel-status error">{procView.error}</p>
                )}
                {procView.data && (
                  <>
                    <p className="proc-panel-sub">
                      {procView.data.airport}
                      {procView.data.runway ? ` · ${procView.data.runway}` : ""}
                      {procView.data.transition
                        ? ` · ${procView.data.transition}`
                        : ""}
                      {procView.data.assumptions.length > 0 && (
                        <em> (auto-picked)</em>
                      )}
                    </p>
                    <ol className="proc-leg-list">
                      {procView.data.legs.map((lg, i) => (
                        <li key={`${lg.seqno}-${i}`} className="proc-leg">
                          <span className="proc-leg-term">
                            {lg.path_terminator}
                          </span>
                          <span className="proc-leg-ident">
                            {lg.ident ?? "—"}
                          </span>
                          <span className="proc-leg-con">
                            {fmtAlt(lg.altitude)}
                            {fmtSpd(lg.speed) ? ` · ${fmtSpd(lg.speed)}` : ""}
                          </span>
                        </li>
                      ))}
                    </ol>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
