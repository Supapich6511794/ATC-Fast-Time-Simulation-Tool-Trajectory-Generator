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
import FilterPanel, {
  EMPTY_FILTER,
  type FlightFilter,
} from "@/components/FilterPanel";
import FlightTagsMenu, { type TagFields } from "@/components/FlightTagsMenu";
import TrailsMenu, {
  DEFAULT_TRAIL_OPTS,
  type TrailOpts,
} from "@/components/TrailsMenu";
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
  fetchAirwayReporting,
  fetchAirwayVor,
  fetchFir,
  fetchSector,
  fetchSidLines,
  fetchSidWaypoints,
  fetchStarLines,
  fetchStarWaypoints,
  SECTORS,
  type AirwayPointCollection,
  type SectorCollection,
  type SectorKey,
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
  type AirwayExtra,
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
import {
  aircraftAt,
  toSamples,
  totalSeconds,
  useSimPlayback,
} from "@/lib/useSimPlayback";
import { statusFromLocalT } from "@/lib/flightStatus";

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
  // Route Profile cards are individually collapsible (by flightKey). A key
  // in the set = that card is expanded. Overview defaults to all collapsed;
  // the Vertical/Summary tabs expand the first card. Reset per generation.
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const toggleExpanded = useCallback((flightKey: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(flightKey)) next.delete(flightKey);
      else next.add(flightKey);
      return next;
    });
  }, []);

  // Playback source: which generated route the SimControls clock is
  // bound to. A number picks one route; "all" plays every route on the
  // longest route's timeline (legacy behaviour). The engine itself
  // stays single-instance — only the source changes.
  const [playbackIdx, setPlaybackIdx] = useState<number | "all">(0);

  // Two ways to surface a flight's live detail card:
  //  • followActive + followIdx — the camera LOCKS onto the aircraft and tracks
  //    it every frame. Triggered ONLY by clicking the plane on the map.
  //  • detailIdx — the detail card shows WITHOUT locking the camera. Triggered
  //    by hovering a plane on the map or clicking a Results row.
  // followActive takes priority for the card target, so a lock survives hovers.
  const [followActive, setFollowActive] = useState(false);
  const [followIdx, setFollowIdx] = useState(0);
  const [detailIdx, setDetailIdx] = useState<number | null>(null);

  // Locking the camera onto a flight (follow + zoom). Used by BOTH a Results-row
  // click and a click on the plane on the map — either way the camera tracks it.
  const lockOnFlight = useCallback((i: number) => {
    setFollowIdx(i);
    setFollowActive(true);
    setDetailIdx(null);
    // In single-route playback, switch the animated aircraft to the picked one
    // (otherwise it wouldn't be moving). In "all" mode every route animates.
    setPlaybackIdx((idx) => (idx === "all" ? "all" : i));
  }, []);
  const selectFlight = lockOnFlight;
  const handleAircraftClick = lockOnFlight;

  // Hovering a plane on the map: show its detail card, but leave the camera
  // unlocked. Ignored visually while a lock is active (the lock wins the card).
  const handleAircraftHover = useCallback(
    (i: number | null) => setDetailIdx(i),
    [],
  );

  // Which fields show in each aircraft's map label, toggled by the Flight
  // Tags menu. Off by default — a freshly generated map stays uncluttered;
  // the user opts into labels via the Flight Tags menu.
  const [tagFields, setTagFields] = useState<TagFields>({
    callsign: false,
    fl: false,
    ias: false,
    hdg: false,
  });
  // Trail drawing options (the Trails menu).
  const [trailOpts, setTrailOpts] = useState<TrailOpts>(DEFAULT_TRAIL_OPTS);
  // TOC/TOD vertical-profile pins. Off after a fresh generation (just the
  // lines show); the map toolbar's "TOC/TOD" button adds them on demand.
  const [profilePinsOn, setProfilePinsOn] = useState(false);

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
  // Visibility helpers for the filter panel (Show All / Hide All / Invert).
  const showAllRoutes = useCallback(() => setHiddenKeys(new Set()), []);
  const hideAllRoutes = useCallback(
    () => setHiddenKeys(new Set(trajectories.map((t) => t.meta.flightKey))),
    [trajectories],
  );
  const invertRoutes = useCallback(() => {
    setHiddenKeys((prev) => {
      const next = new Set<string>();
      for (const t of trajectories)
        if (!prev.has(t.meta.flightKey)) next.add(t.meta.flightKey);
      return next;
    });
  }, [trajectories]);
  const applyHidden = useCallback(
    (hidden: Set<string>) => setHiddenKeys(hidden),
    [],
  );

  // Per-aircraft icon visibility (separate from the route-line hiddenKeys).
  // The filter panel's eye / Show-Hide-Invert / Apply toggle the *animated
  // plane*, not its route line — so you can declutter the moving aircraft
  // while keeping (or dropping) their drawn paths.
  const [hiddenAircraft, setHiddenAircraft] = useState<Set<string>>(new Set());
  const toggleAircraftHidden = useCallback((flightKey: string) => {
    setHiddenAircraft((prev) => {
      const next = new Set(prev);
      if (next.has(flightKey)) next.delete(flightKey);
      else next.add(flightKey);
      return next;
    });
  }, []);
  const showAllAircraft = useCallback(() => setHiddenAircraft(new Set()), []);
  const hideAllAircraft = useCallback(
    () => setHiddenAircraft(new Set(trajectories.map((t) => t.meta.flightKey))),
    [trajectories],
  );
  const invertAircraft = useCallback(() => {
    setHiddenAircraft((prev) => {
      const next = new Set<string>();
      for (const t of trajectories)
        if (!prev.has(t.meta.flightKey)) next.add(t.meta.flightKey);
      return next;
    });
  }, [trajectories]);
  const applyAircraftHidden = useCallback(
    (hidden: Set<string>) => setHiddenAircraft(hidden),
    [],
  );

  // Full filter panel (FlightRadar-style) — open state + filter criteria.
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState<FlightFilter>(EMPTY_FILTER);
  const patchFilter = useCallback(
    (p: Partial<FlightFilter>) => setFilter((f) => ({ ...f, ...p })),
    [],
  );

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
        setExpandedKeys(new Set()); // Overview lands with every card collapsed
        setProfileFlightQuery("");
        setProfileRouteQuery("");
        setSidebarOpen(true);
        // Fresh generation: every new route + aircraft starts visible.
        setHiddenKeys(new Set());
        setHiddenAircraft(new Set());
        // Hide the faint live preview now the real trajectory is drawn (it
        // sat under the generated line). The standalone button brings it back.
        setPreviewHidden(true);
        // Start playback on "all routes" so a fresh generation animates every
        // flight together (single-route playback is still one click away in
        // the source picker).
        setPlaybackIdx("all");
        // Any prior camera-follow ends with the new generation.
        setFollowActive(false);
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
  const [showAirways, setShowAirways] = useState(false);
  const [showWaypoints, setShowWaypoints] = useState(false);

  // FIR layer (lazy — the file is ~15 MB).
  const [firOn, setFirOn] = useState(false);
  const [fir, setFir] = useState<FirCollection | null>(null);
  const [firLoading, setFirLoading] = useState(false);

  // Airspace sector overlays (BACC / subsector / CTR / TMA / PDR) — each
  // lazily loaded the first time its layer is toggled on.
  const [sectorsOn, setSectorsOn] = useState<Record<SectorKey, boolean>>(
    () =>
      Object.fromEntries(SECTORS.map((s) => [s.key, false])) as Record<
        SectorKey,
        boolean
      >,
  );
  const [sectorData, setSectorData] = useState<
    Partial<Record<SectorKey, SectorCollection>>
  >({});
  const toggleSector = useCallback(
    (k: SectorKey) => setSectorsOn((prev) => ({ ...prev, [k]: !prev[k] })),
    [],
  );

  // Airway reference layers (the Airway tab): VOR + reporting points, lazily
  // loaded when toggled, plus a shared opacity for the lines + points.
  const [airwayExtra, setAirwayExtra] = useState<AirwayExtra>({
    labels: false,
    vor: false,
    reporting: false,
    opacity: 0.7,
  });
  const [airwayVor, setAirwayVor] = useState<AirwayPointCollection | null>(null);
  const [airwayReporting, setAirwayReporting] =
    useState<AirwayPointCollection | null>(null);

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
  // The procedure currently highlighted on the map (from a map click or the
  // lookup form). null = nothing highlighted.
  const [highlightProc, setHighlightProc] = useState<ProcedureDto | null>(null);
  const handleProcedureClick = useCallback((sel: ProcedureSelection) => {
    setProcView({ sel, loading: true });
    setHighlightProc(null);
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
      .then((data) => {
        setProcView({ sel, data });
        setHighlightProc(data); // light up the clicked procedure's path
      })
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
  // removed). "all" is only meaningful with 2+ routes (the picker is hidden
  // for a single flight); when just one route exists it collapses to R1, so
  // a stale "all" (left over from a multi-route run) still shows that
  // flight's live FL/speed instead of the degenerate all-span readout.
  // Numeric out-of-range falls back to R1.
  const safePlaybackIdx =
    playbackIdx === "all"
      ? trajectories.length >= 2
        ? "all"
        : 0
      : trajectories[playbackIdx]
        ? playbackIdx
        : 0;
  const activeTrajectory =
    safePlaybackIdx === "all" ? longest : trajectories[safePlaybackIdx] ?? null;

  // "All" mode plays an ABSOLUTE timeline: a two-point span from the earliest
  // departure to the latest arrival across every route. The shared clock then
  // covers the whole operation, so each flight animates at its real EOBT (the
  // map offsets each route by its own departure — see LeafletMap), spreading
  // same-track traffic into a realistic in-trail stream. (`useSimPlayback` only
  // reads first/last epoch for the clock; its interpolated aircraft is unused
  // in "all" mode — the per-route planes are drawn in LeafletMap.)
  const allOriginMs = useMemo(() => {
    let m = Infinity;
    for (const t of trajectories) {
      const p = t.points?.[0];
      if (p) m = Math.min(m, new Date(p.epoch_ts).getTime());
    }
    return Number.isFinite(m) ? m : 0;
  }, [trajectories]);
  const allSpanPoints = useMemo(() => {
    if (trajectories.length === 0) return undefined;
    let end = -Infinity;
    for (const t of trajectories) {
      const ps = t.points;
      if (!ps || ps.length === 0) continue;
      const b = new Date(ps[ps.length - 1].epoch_ts).getTime();
      if (b > end) end = b;
    }
    if (!Number.isFinite(end) || end <= allOriginMs) return undefined;
    const base = trajectories[0].points[0];
    return [
      { ...base, epoch_ts: new Date(allOriginMs).toISOString() },
      { ...base, epoch_ts: new Date(end).toISOString() },
    ];
  }, [trajectories, allOriginMs]);

  const sim = useSimPlayback(
    safePlaybackIdx === "all" ? allSpanPoints : activeTrajectory?.points,
  );

  // The detail-card target: the locked (followed) flight wins, else the flight
  // hovered / picked for detail only. We interpolate it at the SAME shared sim
  // clock the map uses, so in "all" mode it tracks the real position while every
  // route keeps animating.
  const cardIdx = followActive ? followIdx : detailIdx;
  const cardTraj =
    cardIdx != null && trajectories[cardIdx] ? trajectories[cardIdx] : null;
  const cardSamples = useMemo(
    () => (cardTraj ? toSamples(cardTraj.points) : []),
    [cardTraj],
  );
  // Match the plane to the absolute clock the map uses, so its camera + detail
  // card track the real position (offset by its own EOBT in "all" mode).
  const cardOffsetSec =
    cardTraj && safePlaybackIdx === "all" && cardTraj.points[0]
      ? (new Date(cardTraj.points[0].epoch_ts).getTime() - allOriginMs) / 1000
      : 0;
  const cardLocalT = sim.simT - cardOffsetSec;
  const cardAircraft = cardTraj ? aircraftAt(cardSamples, cardLocalT) : null;
  const cardStatus = cardTraj
    ? statusFromLocalT(cardLocalT, totalSeconds(cardTraj.points))
    : null;

  // Camera follow — keep the LOCKED aircraft centred. Runs every frame while a
  // lock is active (cardAircraft is fresh each tick); panTo animate:false is a
  // cheap centre-set. A hover/Results-click detail card never locks, so the
  // camera stays put for those.
  const followLat = followActive ? cardAircraft?.lat ?? null : null;
  const followLon = followActive ? cardAircraft?.lon ?? null : null;
  useEffect(() => {
    if (!mapInstance || followLat == null || followLon == null) return;
    mapInstance.panTo([followLat, followLon], { animate: false });
  }, [mapInstance, followLat, followLon]);
  // Zoom in when a flight is LOCKED (follow turns on or the target changes),
  // framing the aircraft. Frame-by-frame panning is the effect above, which
  // must not re-zoom.
  useEffect(() => {
    if (!mapInstance || !followActive) return;
    const ac = aircraftAt(cardSamples, sim.simT - cardOffsetSec);
    if (!ac) return;
    mapInstance.setView([ac.lat, ac.lon], Math.max(mapInstance.getZoom(), 8), {
      animate: true,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followActive, followIdx, mapInstance]);

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
  // route), else null so its plane parks at the start. In "all" mode the clock
  // is absolute, so subtract the route's own departure offset to keep each
  // profile's plane in lock-step with the map aircraft.
  const playSimT = (i: number): number | null => {
    if (safePlaybackIdx === "all") {
      const p = trajectories[i]?.points?.[0];
      const off = p
        ? (new Date(p.epoch_ts).getTime() - allOriginMs) / 1000
        : 0;
      return sim.simT - off;
    }
    return safePlaybackIdx === i ? sim.simT : null;
  };

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

  // Fetch each sector overlay once, the first time its layer is enabled.
  useEffect(() => {
    for (const s of SECTORS) {
      if (sectorsOn[s.key] && !sectorData[s.key]) {
        fetchSector(s.key)
          .then((d) => setSectorData((prev) => ({ ...prev, [s.key]: d })))
          .catch((e: unknown) =>
            setError(
              e instanceof Error ? e.message : `Failed to load ${s.label}`,
            ),
          );
      }
    }
  }, [sectorsOn, sectorData]);

  // Fetch the airway VOR / reporting points once, on first enable.
  useEffect(() => {
    if (airwayExtra.vor && !airwayVor) fetchAirwayVor().then(setAirwayVor).catch(() => {});
    if (airwayExtra.reporting && !airwayReporting)
      fetchAirwayReporting().then(setAirwayReporting).catch(() => {});
  }, [airwayExtra.vor, airwayExtra.reporting, airwayVor, airwayReporting]);

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

  // Cascading index for the direct lookup form: airport -> procedure ->
  // [transitions]. Built from the line collection.
  const buildIndex = (lines: ProcedureLineCollection | null) => {
    const idx: Record<string, Record<string, string[]>> = {};
    for (const f of lines?.features ?? []) {
      const a = f.properties.airport_identifier;
      const p = f.properties.procedure_identifier;
      const t = f.properties.transition_identifier ?? "";
      if (!a || !p) continue;
      (idx[a] ??= {});
      (idx[a][p] ??= []);
      if (t && !idx[a][p].includes(t)) idx[a][p].push(t);
    }
    for (const a of Object.keys(idx))
      for (const p of Object.keys(idx[a])) idx[a][p].sort();
    return idx;
  };
  const sidIndex = useMemo(() => buildIndex(sidLines), [sidLines]);
  const starIndex = useMemo(() => buildIndex(starLines), [starLines]);
  const pbnIndex = useMemo(() => buildIndex(pbnLines), [pbnLines]);
  const ilsIndex = useMemo(() => buildIndex(ilsLines), [ilsLines]);

  // Direct procedure lookup (form-driven): map the chosen transition to the
  // right query param and resolve via the procedures API.
  const lookupProcedure = useCallback(
    (
      type: "SID" | "STAR" | "PBN" | "ILS",
      airport: string,
      name: string,
      transition: string | null,
    ) => {
      const t = (transition ?? "").toUpperCase();
      const isRunway = t.startsWith("RW");
      return fetchProcedure(airport, name, {
        type,
        runway: isRunway ? transition ?? undefined : undefined,
        transition: isRunway ? undefined : transition ?? undefined,
      });
    },
    [],
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
          <h1 className="brand">
            <span className="brand-ico" aria-hidden>
              <svg viewBox="0 0 24 24" width="16" height="16">
                <path
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  d="M5 12a7 7 0 0 1 7-7m0 14a7 7 0 0 0 7-7M8.5 12a3.5 3.5 0 0 1 3.5-3.5m0 7A3.5 3.5 0 0 0 15.5 12"
                />
                <circle cx="12" cy="12" r="1.4" fill="currentColor" />
              </svg>
            </span>
            Flight Trajectory Generator
          </h1>
          {trajectories.length > 0 && nav?.kind !== "generator" && (
            <span className="ready-badge">READY</span>
          )}
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
            <p className="rp-ready">
              {trajectories.length} flight
              {trajectories.length === 1 ? "" : "s"} ready
            </p>

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

            {/* Inline section tabs — mirror the "Route Profile ▾" dropdown.
                Overview lands with every card collapsed; Vertical / Summary
                expand the first card so its section is visible at a glance. */}
            <div className="rp-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={nav.section === "both"}
                className={nav.section === "both" ? "active" : undefined}
                onClick={() => setNav({ kind: "all", section: "both" })}
              >
                Overview
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={nav.section === "vertical"}
                className={nav.section === "vertical" ? "active" : undefined}
                onClick={() => setNav({ kind: "all", section: "vertical" })}
              >
                Vertical
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={nav.section === "summary"}
                className={nav.section === "summary" ? "active" : undefined}
                onClick={() => setNav({ kind: "all", section: "summary" })}
              >
                Summary
              </button>
            </div>

            {/* Collapsible, colour-tagged route cards — expand any to reveal
                the active section. Heavy charts mount only when expanded. */}
            {profileRows.map(({ t, d, i }) => (
              <RouteResultTabs
                key={d.flightKey}
                trajectory={t}
                download={d}
                routeIndex={i + 1}
                onRemove={() => removeResultAt(i)}
                collapsible
                collapsed={!expandedKeys.has(d.flightKey)}
                onToggleCollapse={() => toggleExpanded(d.flightKey)}
                sectionMode={nav.section}
                simT={playSimT(i)}
              />
            ))}

            {profileRows.length === 0 && (
              <p className="rp-search-empty">
                No routes match this search. Clear the boxes to see all.
              </p>
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
            {/* Top-center toolbar: Flight Tags menu + the Filter-panel
                toggle. The aircraft-type search now lives inside the panel. */}
            {trajectories.length > 0 && (
              <div className="map-topbar">
                <TrailsMenu
                  opts={trailOpts}
                  onChange={setTrailOpts}
                  flightTagsOn={
                    tagFields.callsign ||
                    tagFields.fl ||
                    tagFields.ias ||
                    tagFields.hdg
                  }
                  onFlightTagsToggle={(on) =>
                    setTagFields(
                      on
                        ? { callsign: true, fl: true, ias: false, hdg: false }
                        : { callsign: false, fl: false, ias: false, hdg: false },
                    )
                  }
                />
                <FlightTagsMenu fields={tagFields} onChange={setTagFields} />
                <button
                  type="button"
                  className={`map-filter-btn${profilePinsOn ? " active" : ""}`}
                  onClick={() => setProfilePinsOn((v) => !v)}
                  aria-pressed={profilePinsOn}
                  title={
                    profilePinsOn
                      ? "Hide the TOC/TOD markers"
                      : "Add the Top-of-Climb / Top-of-Descent markers"
                  }
                >
                  {profilePinsOn ? "✓ TOC/TOD" : "＋ TOC/TOD"}
                </button>
                <button
                  type="button"
                  className={`map-filter-btn${filterOpen ? " active" : ""}`}
                  onClick={() => setFilterOpen((v) => !v)}
                  aria-pressed={filterOpen}
                  title="Filter flights"
                >
                  ⚲ Filter
                </button>
              </div>
            )}
            <FilterPanel
              open={filterOpen && trajectories.length > 0}
              onClose={() => setFilterOpen(false)}
              trajectories={trajectories}
              aircraftTypes={aircraftTypes}
              filter={filter}
              onFilterChange={patchFilter}
              typeQuery={acTypeQuery}
              onTypeQueryChange={setAcTypeQuery}
              hiddenKeys={hiddenAircraft}
              onApplyHidden={applyAircraftHidden}
              onShowAll={showAllAircraft}
              onHideAll={hideAllAircraft}
              onInvert={invertAircraft}
              onToggleHidden={toggleAircraftHidden}
              onSelectFlight={selectFlight}
              activeIndex={followActive ? followIdx : detailIdx ?? safePlaybackIdx}
              playbackIdx={safePlaybackIdx}
              simT={sim.simT}
            />
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
              sectorsOn={sectorsOn}
              onToggleSector={toggleSector}
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
              airwaysOn={showAirways}
              onAirwaysOn={setShowAirways}
              airway={airwayExtra}
              onAirwayChange={setAirwayExtra}
              onProcHighlight={setHighlightProc}
              sid={{
                state: sid,
                onChange: setSid,
                airportOpts: sidOpts.airports,
                procOpts: sidOpts.procedures,
                index: sidIndex,
                lookup: (a, n, t) => lookupProcedure("SID", a, n, t),
              }}
              star={{
                state: star,
                onChange: setStar,
                airportOpts: starOpts.airports,
                procOpts: starOpts.procedures,
                index: starIndex,
                lookup: (a, n, t) => lookupProcedure("STAR", a, n, t),
              }}
              pbn={{
                state: pbn,
                onChange: setPbn,
                airportOpts: pbnOpts.airports,
                procOpts: pbnOpts.procedures,
                index: pbnIndex,
                lookup: (a, n, t) => lookupProcedure("PBN", a, n, t),
              }}
              ils={{
                state: ils,
                onChange: setIls,
                airportOpts: ilsOpts.airports,
                procOpts: ilsOpts.procedures,
                index: ilsIndex,
                lookup: (a, n, t) => lookupProcedure("ILS", a, n, t),
              }}
            />
            <LeafletMap
              basemap={basemap}
              airways={showAirways ? airways : null}
              airwayPts={{
                vor: airwayExtra.vor ? airwayVor : null,
                reporting: airwayExtra.reporting ? airwayReporting : null,
                labels: airwayExtra.labels ? airways : null,
                opacity: airwayExtra.opacity,
              }}
              waypoints={showWaypoints ? waypoints : null}
              fir={firOn ? fir : null}
              sectors={Object.fromEntries(
                SECTORS.filter((s) => sectorsOn[s.key]).map((s) => [
                  s.key,
                  sectorData[s.key] ?? null,
                ]),
              )}
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
              highlightProc={highlightProc}
              onProcedureClick={handleProcedureClick}
              trajectories={trajectories}
              showTrails={trailOpts.show}
              flColorTrails={trailOpts.flColor}
              trailDecaySec={trailOpts.decaySec}
              trailWeight={trailOpts.weight}
              showProfilePins={profilePinsOn}
              hiddenKeys={hiddenKeys}
              hiddenAircraft={hiddenAircraft}
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
              followKey={cardTraj?.meta.flightKey}
              onAircraftClick={handleAircraftClick}
              onAircraftHover={handleAircraftHover}
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

            {/* Flight detail card — live readout for the picked aircraft. When
                LOCKED (clicked on the map) the camera tracks it at centre and
                the header offers to unlock; when shown from a hover / Results
                click it's a read-only card that doesn't move the camera, and the
                header offers to lock on. ✕ dismisses it. */}
            {cardTraj && cardAircraft && cardIdx != null && (
              <div
                className={`follow-card${followActive ? " locked" : " detail"}`}
                role="dialog"
              >
                <div className="follow-card-head">
                  <button
                    type="button"
                    className="follow-card-toggle"
                    onClick={() => {
                      if (followActive) {
                        // Unlock but keep the card open as a detail readout.
                        setFollowActive(false);
                        setDetailIdx(cardIdx);
                      } else {
                        // Lock the camera onto this flight.
                        setFollowIdx(cardIdx);
                        setFollowActive(true);
                      }
                    }}
                    title={
                      followActive
                        ? "Click to unlock (stop following)"
                        : "Click to lock the camera on this aircraft"
                    }
                  >
                    <span className="follow-card-key">
                      {cardTraj.meta.flightKey}
                    </span>
                    <span className="follow-card-unlock">
                      {followActive ? "🔒 click to unlock" : "🔓 click to lock"}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="follow-card-close"
                    onClick={() => {
                      setFollowActive(false);
                      setDetailIdx(null);
                    }}
                    aria-label="Close flight detail"
                    title="Close"
                  >
                    ✕
                  </button>
                </div>
                <dl className="follow-card-body">
                  <div>
                    <dt>ACID</dt>
                    <dd>{cardTraj.meta.callsign}</dd>
                  </div>
                  <div>
                    <dt>Type</dt>
                    <dd>{cardTraj.meta.aircraftType || "—"}</dd>
                  </div>
                  <div>
                    <dt>Route</dt>
                    <dd>
                      {cardTraj.meta.adep} → {cardTraj.meta.ades}
                    </dd>
                  </div>
                  <div>
                    <dt>FL</dt>
                    <dd>
                      {cardAircraft.altitudeFt != null
                        ? `FL${String(
                            Math.round(cardAircraft.altitudeFt / 100),
                          ).padStart(3, "0")}`
                        : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>GS</dt>
                    <dd>{Math.round(cardAircraft.gsKt)} kt</dd>
                  </div>
                  <div>
                    <dt>HDG</dt>
                    <dd>{Math.round(cardAircraft.track)}°</dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd
                      className={`follow-card-status ${cardStatus ?? "enroute"}`}
                    >
                      {cardStatus === "arrived"
                        ? "Arrived"
                        : cardStatus === "scheduled"
                          ? "Scheduled"
                          : "En route"}
                    </dd>
                  </div>
                </dl>
              </div>
            )}

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
                    onClick={() => {
                      setProcView(null);
                      setHighlightProc(null);
                    }}
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
