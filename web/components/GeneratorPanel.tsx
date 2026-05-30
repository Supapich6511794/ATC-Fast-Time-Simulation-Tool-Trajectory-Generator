"use client";

/**
 * GeneratorPanel — click-driven UI for Phase 1.
 *
 * This panel does NO trajectory math. It collects inputs, calls the Python
 * FastAPI server (`/api/generate`), and shows the result. All parsing,
 * pyproj/WGS-84 geodesy and GeoPackage/CSV writing happen in the real
 * `trajectory_sim` package server-side — the web is just the front-end.
 *
 * Two input modes:
 *   - "Manual"       — fill the form by hand. The route itself can be a
 *                       typed Item-15 string, the point-and-click
 *                       RouteBuilder, or the pre-resolved airway CSV.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import IdentCombobox, { type ComboOption } from "@/components/IdentCombobox";
import RouteBuilder from "@/components/RouteBuilder";
import {
  fetchAirports,
  fetchAirwaysMap,
  fetchAllFixes,
  type AirportOption,
  type Fix,
} from "@/lib/aip";
import { generateBatch, generateTrajectory, type GenerateInput } from "@/lib/api";
import SearchCombo from "@/components/SearchCombo";
import {
  flightOptions,
  matchesFlight,
  matchesRoute,
  routeOptions,
} from "@/lib/flightSearch";
import { parseFlightFile, type FlightRecord } from "@/lib/flightFile";
import {
  resolvePreviewFromIdents,
  resolvePreviewFullY8,
  resolveRoutePreview,
  type PreviewPoint,
} from "@/lib/routePreview";
import {
  estimateReferenceMin,
  estimateSimMin,
  fetchCat62Reference,
  lookupReferenceMin,
  type Cat62Table,
} from "@/lib/cat62";
import { kBestRoutes } from "@/lib/routeFinder";
import type { TrajectoryResult } from "@/lib/trajectory/types";

/** How the route portion is supplied (all three kept, none removed). */
type RouteMode = "fpl" | "build" | "csv";

interface DownloadInfo {
  callsign: string;
  flightKey: string;
  route: string;
  gpkg: string;
  csv: string;
  geojson: string;
}

/** One editable flight plan in the multi-plan tab strip. The active tab's
 *  values live in the scalar editor state below; inactive tabs are stored
 *  as snapshots here, so the whole single-plan editor JSX is reused
 *  unchanged and tab-switching just serialises/restores these fields. */
interface PlanDraft {
  id: string;
  callsign: string;
  actype: string;
  adep: string;
  ades: string;
  eobt: string;
  gsKt: number;
  rfl: number;
  routeMode: RouteMode;
  routeStr: string;
  builtWpts: string[];
  routes: string[];
}

let _planSeq = 0;
const nextPlanId = () => `p${++_planSeq}`;

function blankPlan(): PlanDraft {
  return {
    id: nextPlanId(),
    callsign: "",
    actype: "B738",
    adep: "",
    ades: "",
    eobt: "",
    gsKt: 450,
    rfl: 350,
    routeMode: "fpl",
    routeStr: "",
    builtWpts: [],
    routes: [],
  };
}

/** The route strings a draft will fly: queued routes, else the single
 *  effective route, else none. CSV mode is one server-resolved route. */
function draftRouteList(d: PlanDraft): string[] {
  if (d.routeMode === "csv") return [""];
  if (d.routes.length > 0) return d.routes;
  const eff =
    d.routeMode === "build"
      ? d.builtWpts.length
        ? `DCT ${d.builtWpts.join(" DCT ")} DCT`
        : ""
      : d.routeStr.trim();
  return eff ? [eff] : [];
}

/** Short tab label for a plan. */
function planLabel(d: PlanDraft, i: number): string {
  return d.callsign.trim() || `Plan ${i + 1}`;
}

interface Props {
  /** Emits the generated trajectories (or null to clear) to the parent.
   *  An array so several routes can be flown/shown at once. */
  onResult: (results: TrajectoryResult[] | null) => void;
  /** Emits the matching download URLs alongside results. Lifted to the
   *  parent so the floating NavToolbar + DownloadModal can read them. */
  onDownloadsChange?: (dl: DownloadInfo[]) => void;
  /** Live preview of all routes the user has in flight (the queued
   *  routes plus the one currently being typed/built), so the map can
   *  show each as a faint distinctly-coloured polyline in real time. */
  onPreviewChange?: (routes: PreviewPoint[][]) => void;
  /** Emits a short "generated / planned flights" status for the panel
   *  header (shown beside the title, top-right). */
  onReadyChange?: (text: string) => void;
  /** Selectable waypoint idents (from the airway file) for RouteBuilder. */
  waypointIdents: string[];
}

/** Phase 1 flies the B738 only; others are listed for forward-compat. */
const AIRCRAFT = [
  ["B738", "B738 — Boeing 737-800"],
  ["A320", "A320 — Airbus A320"],
  ["B77W", "B77W — Boeing 777-300ER"],
] as const;

/** Fallback airport list used only until the AIP airports load (free
 *  typing of any ICAO is always allowed). The live list comes from the
 *  CAAT eAIP AD section — all 46 Thai aerodromes. */
const AIRPORTS_FALLBACK: ComboOption[] = [
  { code: "VTBS", label: "Suvarnabhumi · Bangkok" },
  { code: "VTSP", label: "Phuket" },
  { code: "VTCC", label: "Chiang Mai" },
];

/** Title-case an ALL-CAPS AIP airport name for the dropdown label. */
function tidyAirportName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bInternational\b/i, "Intl");
}

export default function GeneratorPanel({
  onResult,
  onDownloadsChange,
  onPreviewChange,
  onReadyChange,
  waypointIdents,
}: Props) {
  const [routeMode, setRouteMode] = useState<RouteMode>("fpl");

  const [callsign, setCallsign] = useState("");
  const [actype, setActype] = useState("B738");
  const [adep, setAdep] = useState("");
  const [ades, setAdes] = useState("");
  const [eobt, setEobt] = useState("");
  const [gsKt, setGsKt] = useState(450);
  const [rfl, setRfl] = useState(350);

  // Phase-3 speed-schedule tuning (advanced, collapsed by default).
  // Empty string = use the airframe default for that field.
  // --- DISABLED: speed schedule (advanced) — kept for future use. ---
  // const [tuneOpen, setTuneOpen] = useState(false);
  // const [climbCas, setClimbCas] = useState("");
  // const [cruiseMach, setCruiseMach] = useState("");
  // const [descentCas, setDescentCas] = useState("");
  // const [descentMach, setDescentMach] = useState("");
  // const [restrictCas, setRestrictCas] = useState("");
  const [routeStr, setRouteStr] = useState("");
  const [builtWpts, setBuiltWpts] = useState<string[]>([]);
  /** Extra Item-15 routes to fly together (capped at #possible routes). */
  const [routes, setRoutes] = useState<string[]>([]);

  // --- Multi-plan tabs -----------------------------------------------------
  // The active tab's values live in the scalar state above. `plans` holds a
  // snapshot per tab; switching tabs serialises the current scalar state
  // into the outgoing plan and restores the incoming one. This lets one
  // run cover thousands of flights (2000+ Thai network) without rebuilding
  // the editor for each.
  const initialPlanId = useRef<string>(nextPlanId());
  const [plans, setPlans] = useState<PlanDraft[]>(() => [
    { ...blankPlan(), id: initialPlanId.current },
  ]);
  const [activeId, setActiveId] = useState<string>(initialPlanId.current);
  /** Search/filter over generated results (empty = show all). */
  // Two-scope search over generated routes: pick a flight, then optionally
  // narrow to one of its routes (empty route box = all routes of the flight).
  const [flightQuery, setFlightQuery] = useState("");
  const [routeQuery, setRouteQuery] = useState("");

  const [fileNote, setFileNote] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Generated trajectories + their download bundles kept in lock-step
  // (same index). Multi-route generates several at once; an ✕ button
  // on each download card removes that one entry from both arrays and
  // from the map (via onResult).
  const [results, setResults] = useState<TrajectoryResult[]>([]);
  const [dlList, setDlList] = useState<DownloadInfo[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // RouteBuilder selection → an Item-15 style string.
  const builtRoute = useMemo(
    () => (builtWpts.length ? `DCT ${builtWpts.join(" DCT ")} DCT` : ""),
    [builtWpts],
  );

  /** Snapshot the live editor (scalar state) into a PlanDraft. */
  const snapshotActive = (): PlanDraft => ({
    id: activeId,
    callsign,
    actype,
    adep,
    ades,
    eobt,
    gsKt,
    rfl,
    routeMode,
    routeStr,
    builtWpts,
    routes,
  });

  /** Load a PlanDraft into the live editor (scalar state). */
  const loadDraft = (d: PlanDraft) => {
    setCallsign(d.callsign);
    setActype(d.actype);
    setAdep(d.adep);
    setAdes(d.ades);
    setEobt(d.eobt);
    setGsKt(d.gsKt);
    setRfl(d.rfl);
    setRouteMode(d.routeMode);
    setRouteStr(d.routeStr);
    setBuiltWpts(d.builtWpts);
    setRoutes(d.routes);
  };

  const switchTo = (id: string) => {
    if (id === activeId) return;
    const snap = snapshotActive();
    setPlans((prev) => prev.map((p) => (p.id === activeId ? snap : p)));
    const target = plans.find((p) => p.id === id);
    if (target) {
      loadDraft(target);
      setActiveId(id);
    }
  };

  const addPlan = () => {
    const snap = snapshotActive();
    const fresh = blankPlan();
    setPlans((prev) => [...prev.map((p) => (p.id === activeId ? snap : p)), fresh]);
    loadDraft(fresh);
    setActiveId(fresh.id);
  };

  const duplicatePlan = () => {
    const snap = snapshotActive();
    const copy: PlanDraft = { ...snap, id: nextPlanId() };
    setPlans((prev) => {
      const persisted = prev.map((p) => (p.id === activeId ? snap : p));
      const at = persisted.findIndex((p) => p.id === activeId);
      return [...persisted.slice(0, at + 1), copy, ...persisted.slice(at + 1)];
    });
    loadDraft(copy);
    setActiveId(copy.id);
  };

  const removePlan = (id: string) => {
    if (plans.length <= 1) return; // never drop the last tab
    const at = plans.findIndex((p) => p.id === id);
    const next = plans.filter((p) => p.id !== id);
    // Keep the (possibly edited) active tab's data if it isn't the one
    // being removed.
    const snap = snapshotActive();
    setPlans(next.map((p) => (p.id === activeId ? snap : p)));
    if (id === activeId) {
      const fallback = next[Math.max(0, at - 1)];
      loadDraft(fallback);
      setActiveId(fallback.id);
    }
  };

  // Live view of every plan with the active tab reflecting unsaved edits,
  // for the header counters and "Generate all".
  const liveActive = snapshotActive();
  const allDrafts = plans.map((p) => (p.id === activeId ? liveActive : p));
  const totalRoutes = allDrafts.reduce(
    (n, d) => n + draftRouteList(d).length,
    0,
  );
  const uniqueAirports = useMemo(() => {
    const s = new Set<string>();
    for (const d of allDrafts) {
      const a = d.adep.trim().toUpperCase();
      const b = d.ades.trim().toUpperCase();
      if (a) s.add(a);
      if (b) s.add(b);
    }
    return s;
  }, [allDrafts]);

  // "generated / planned" — shown beside the panel title. Planned is the
  // queued route count, falling back to the plan count so a fresh panel
  // reads "0 / 1".
  const plannedCount = Math.max(totalRoutes, plans.length);
  const readyText = `${results.length} / ${plannedCount} flight${
    plannedCount === 1 ? "" : "s"
  } ready`;
  useEffect(() => {
    onReadyChange?.(readyText);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyText]);

  // Full Thai navdata from the CAAT eAIP cache — all fixes, all airways,
  // and all aerodromes — loaded once on mount.
  const [allFixes, setAllFixes] = useState<Fix[]>([]);
  const [airwaysMap, setAirwaysMap] = useState<Record<string, string[]>>({});
  const [airports, setAirports] = useState<AirportOption[]>([]);
  const [showAllRoutes, setShowAllRoutes] = useState(false);
  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchAllFixes(), fetchAirwaysMap(), fetchAirports()])
      .then(([fixes, aw, aps]) => {
        if (cancelled) return;
        setAllFixes(fixes);
        setAirwaysMap(aw);
        setAirports(aps);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Airport combobox options — from the AIP AD section when loaded, else
  // a tiny fallback. Free typing of any ICAO is always allowed.
  const airportOptions: ComboOption[] = useMemo(
    () =>
      airports.length
        ? airports.map((a) => ({
            code: a.code,
            label: tidyAirportName(a.name),
          }))
        : AIRPORTS_FALLBACK,
    [airports],
  );

  // Any distinct, non-empty ICAO pair is routable now.
  const dep = adep.trim().toUpperCase();
  const des = ades.trim().toUpperCase();
  const pairReady = !!dep && !!des && dep !== des;
  const isY8Corridor =
    (dep === "VTBS" && des === "VTSP") || (dep === "VTSP" && des === "VTBS");

  // Aerodrome reference coords, keyed by ICAO, for the route finder.
  const airportLL = useMemo(() => {
    const m = new Map<string, { lat: number; lon: number }>();
    for (const a of airports) m.set(a.code, { lat: a.lat, lon: a.lon });
    return m;
  }, [airports]);

  // K best routes for ANY aerodrome pair — graph search (Yen's
  // k-shortest) over the whole Thai airway network. Empty when either
  // airport's coordinates aren't in the AIP (e.g. a free-typed field).
  const bestRoutes = useMemo(() => {
    if (!pairReady || allFixes.length === 0) return [];
    const depLL = airportLL.get(dep) ?? null;
    const desLL = airportLL.get(des) ?? null;
    if (!depLL || !desLL) return [];
    return kBestRoutes(allFixes, airwaysMap, depLL, desLL, { k: 6 });
  }, [pairReady, dep, des, airportLL, allFixes, airwaysMap]);

  // CAT62 reference table (loaded once) for pre-screening candidate
  // routes against the city-pair reference time.
  const [cat62, setCat62] = useState<Cat62Table | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchCat62Reference()
      .then((t) => !cancelled && setCat62(t))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // One target time for the whole pair: the real CAT62 reference if we
  // have one, otherwise a distance-based estimate anchored on the
  // shortest (recommended) route — so EVERY pair gets a PASS/FAIL, not
  // just the few with table entries.
  const threshold = cat62?.thresholdMin ?? 5;
  const pairRefMin = useMemo(() => {
    if (!cat62 || bestRoutes.length === 0) return null;
    const real = lookupReferenceMin(cat62, dep, des);
    if (real != null) return real;
    return estimateReferenceMin(bestRoutes[0].distanceNm);
  }, [cat62, dep, des, bestRoutes]);

  // Annotate each candidate route with its predicted flight time +
  // PASS/FAIL against the pair target, then split passing / failing.
  const rankedRoutes = useMemo(
    () =>
      bestRoutes.map((r) => {
        const simMin = estimateSimMin(r.distanceNm);
        const passed =
          pairRefMin != null
            ? Math.abs(simMin - pairRefMin) < threshold
            : null;
        return { ...r, simMin, passed };
      }),
    [bestRoutes, pairRefMin, threshold],
  );

  const passingRoutes = rankedRoutes.filter((r) => r.passed === true);
  const hasReference = pairRefMin != null;
  // Prefer passing routes; if none pass, show everything so the user can
  // still pick + then tune (never a dead end).
  const shownRoutes =
    hasReference && passingRoutes.length > 0 ? passingRoutes : rankedRoutes;

  // The route the Item-15 box currently resolves to (typed or built).
  const effectiveRoute =
    routeMode === "build" ? builtRoute : routeStr.trim();
  // Can't queue more routes than there are distinct possible ones.
  const routeCap = Math.max(1, bestRoutes.length);
  const addRoute = () => {
    const r = effectiveRoute.trim();
    if (!r || routes.includes(r) || routes.length >= routeCap) return;
    setRoutes((xs) => [...xs, r]);
    // Reset the active input so the route is owned only by the queue
    // entry — removing it via ✕ then takes its preview line off the
    // map too, instead of leaving an orphan from the unchanged input.
    if (routeMode === "build") setBuiltWpts([]);
    else if (routeMode === "fpl") setRouteStr("");
  };

  // What the FPL route portion resolves to (for the live preview).
  const previewRoute =
    routeMode === "csv"
      ? `(airway CSV · ${adep || "?"}→${ades || "?"})`
      : routeMode === "build"
        ? builtRoute
        : routeStr.trim();

  const previewFpl =
    callsign && adep && ades && previewRoute
      ? `${callsign} ${actype} ${adep} ${ades} ${previewRoute}`.trim()
      : "";

  // Live route preview — resolve every route the user has in flight to
  // a list of (ident, lat, lon) so the map can highlight each one in a
  // distinct colour the moment the first complete waypoint name is
  // recognised. Includes every queued route plus the one currently
  // being typed/built; emitted upward via onPreviewChange.
  const previewRoutes = useMemo<PreviewPoint[][]>(() => {
    if (allFixes.length === 0) return [];
    const out: PreviewPoint[][] = [];

    // Queued routes (always typed/built — never CSV, since the Add
    // Route button is hidden in CSV mode).
    for (const r of routes) {
      const pts = resolveRoutePreview(r, allFixes, airwaysMap);
      if (pts.length > 0) out.push(pts);
    }

    // Whatever the user is editing right now (separate from the queue
    // so it can be tweaked live without re-adding). Skip if the edit
    // string is already in the queue to avoid drawing it twice.
    let current: PreviewPoint[] = [];
    if (routeMode === "build") {
      const trimmed = builtRoute.trim();
      if (trimmed && !routes.includes(trimmed)) {
        current = resolvePreviewFromIdents(builtWpts, allFixes);
      }
    } else if (routeMode === "csv") {
      current = isY8Corridor
        ? resolvePreviewFullY8(allFixes, airwaysMap, dep)
        : [];
    } else {
      const trimmed = routeStr.trim();
      if (trimmed && !routes.includes(trimmed)) {
        current = resolveRoutePreview(trimmed, allFixes, airwaysMap);
      }
    }
    if (current.length > 0) out.push(current);

    return out;
  }, [
    routeMode,
    routeStr,
    builtRoute,
    builtWpts,
    routes,
    allFixes,
    airwaysMap,
    dep,
    isY8Corridor,
  ]);

  useEffect(() => {
    onPreviewChange?.(previewRoutes);
  }, [previewRoutes, onPreviewChange]);

  /** Turn a parsed flight row into a full PlanDraft. */
  function recordToPlan(r: FlightRecord): PlanDraft {
    const p = blankPlan();
    if (r.callsign) p.callsign = r.callsign;
    if (r.actype) p.actype = r.actype;
    if (r.adep) p.adep = r.adep;
    if (r.ades) p.ades = r.ades;
    if (r.eobt) p.eobt = r.eobt;
    if (r.rfl != null) p.rfl = r.rfl;
    if (r.route) p.routeStr = r.route;
    return p;
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    try {
      const all: FlightRecord[] = [];
      for (const f of Array.from(files)) {
        all.push(...(await parseFlightFile(f)));
      }
      if (all.length === 0) throw new Error("No flight rows found in file.");

      // Bulk import: one tab per row, ready for "Generate all" (the
      // 2000-flight Thai network case). Replaces the current plan set.
      const drafts = all.map(recordToPlan);
      setPlans(drafts);
      loadDraft(drafts[0]);
      setActiveId(drafts[0].id);
      setFileNote(
        all.length > 1
          ? `Imported ${all.length} flights into tabs — edit any, then "Generate all"`
          : "Loaded from file — review and edit before Generate",
      );
    } catch (e) {
      setFileNote(null);
      setError(e instanceof Error ? e.message : "Could not parse file.");
    }
  }

  /** Speed-schedule overrides — only the fields the user actually set, so
   *  blanks keep the airframe default server-side. Shared by single +
   *  batch generation. */
  // --- DISABLED: speed schedule (advanced) — kept for future use. ---
  // function buildSpeedOverrides(): Partial<GenerateInput> {
  //   const num = (s: string) => {
  //     const v = parseFloat(s);
  //     return Number.isFinite(v) ? v : undefined;
  //   };
  //   return {
  //     ...(num(climbCas) !== undefined ? { climb_cas_kt: num(climbCas) } : {}),
  //     ...(num(cruiseMach) !== undefined ? { cruise_mach: num(cruiseMach) } : {}),
  //     ...(num(descentCas) !== undefined ? { descent_cas_kt: num(descentCas) } : {}),
  //     ...(num(descentMach) !== undefined ? { descent_mach: num(descentMach) } : {}),
  //     ...(num(restrictCas) !== undefined ? { restrict_cas_kt: num(restrictCas) } : {}),
  //   };
  // }

  // Stage 1 — narrow to the matched flight(s) by callsign / ADEP-ADES.
  const flightFiltered = useMemo(
    () =>
      results
        .map((r, i) => ({ r, dl: dlList[i], i }))
        .filter(({ r }) =>
          matchesFlight(flightQuery, {
            callsign: r.meta.callsign,
            adep: r.meta.adep,
            ades: r.meta.ades,
          }),
        ),
    [results, dlList, flightQuery],
  );

  // Stage 2 — within those, optionally pick a specific route (empty route
  // box = every route of the matched flight). Shares the matcher with the
  // Route Profile search so both behave identically.
  const filtered = useMemo(
    () =>
      flightFiltered.filter(({ dl, i }) =>
        matchesRoute(routeQuery, { route: dl?.route ?? "", index: i }),
      ),
    [flightFiltered, routeQuery],
  );

  // Flight-field options (one row per generated flight) and route-field
  // options (one row per route, scoped to the flight already chosen).
  const flightSugg = useMemo(
    () =>
      flightOptions(
        results.map((r) => ({
          callsign: r.meta.callsign,
          adep: r.meta.adep,
          ades: r.meta.ades,
        })),
      ),
    [results],
  );
  const routeSugg = useMemo(
    () =>
      routeOptions(
        flightFiltered.map(({ r, dl, i }) => ({
          route: dl?.route ?? "",
          index: i,
          distanceNm: r.stats.distanceNm,
        })),
      ),
    [flightFiltered],
  );

  // Search-driven map: emit only the matched flights (and their downloads)
  // upward. Null when nothing matches so the map clears. `filtered` is a
  // stable useMemo, so this fires only when results/downloads or either
  // search box change — the parent callbacks are intentionally excluded
  // from the deps to avoid a re-emit loop (onResult is inline in MapApp).
  useEffect(() => {
    onResult(filtered.length ? filtered.map((p) => p.r) : null);
    onDownloadsChange?.(
      filtered.map((p) => p.dl).filter(Boolean) as DownloadInfo[],
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered]);

  /** Generate EVERY plan's routes in one batch request. */
  async function generateAll() {
    setBusy(true);
    setError(null);
    setWarnings([]);
    try {
      // Reflect any unsaved edits on the active tab.
      const drafts = plans.map((p) => (p.id === activeId ? snapshotActive() : p));
      // --- DISABLED: speed schedule (advanced) — kept for future use. ---
      // const overrides = buildSpeedOverrides();

      const built: { input: GenerateInput; label: string }[] = [];
      const skipped: string[] = [];
      for (const d of drafts) {
        const dp = d.adep.trim().toUpperCase();
        const ds = d.ades.trim().toUpperCase();
        if (!dp || !ds || dp === ds) {
          skipped.push(`${planLabel(d, drafts.indexOf(d))}: set distinct ADEP/ADES`);
          continue;
        }
        const list = draftRouteList(d);
        if (list.length === 0) {
          skipped.push(`${planLabel(d, drafts.indexOf(d))}: no route`);
          continue;
        }
        const isCsv = d.routeMode === "csv";
        for (const r of list) {
          built.push({
            input: {
              source: isCsv ? "csv" : "fpl",
              vtsp_to_vtbs: dp === "VTSP",
              adep: dp,
              ades: ds,
              route: isCsv ? "" : r,
              callsign: d.callsign || "FLT",
              eobt: d.eobt,
              gs_kt: d.gsKt,
              rfl: d.rfl,
              // ...overrides, // DISABLED: speed schedule (advanced)
            },
            label: isCsv ? `Airway CSV · ${dp}→${ds}` : r || "(route)",
          });
        }
      }

      if (built.length === 0) {
        throw new Error(
          "Nothing to generate — every plan is missing ADEP/ADES or a route.",
        );
      }

      const { results: batch, errors } = await generateBatch(
        built.map((b) => b.input),
      );

      // The server keeps successes + failures in submission order, so the
      // k-th success aligns to the k-th non-failed spec — recover the route
      // label that way.
      const failed = new Set(errors.map((e) => e.index));
      const succeededLabels = built
        .filter((_, i) => !failed.has(i))
        .map((b) => b.label);

      const trajectories = batch.map((s) => s.result);
      const newDownloads: DownloadInfo[] = batch.map((s, i) => ({
        callsign: s.result.meta.callsign,
        flightKey: s.result.meta.flightKey,
        route: succeededLabels[i] ?? "(route)",
        gpkg: s.downloads.gpkg,
        csv: s.downloads.csv,
        geojson: s.downloads.geojson,
      }));

      const notes = [
        ...batch.flatMap((s) => s.warnings),
        ...errors.map((e) => `${e.callsign} ${e.adep}→${e.ades}: ${e.detail}`),
        ...skipped,
      ];

      setFlightQuery("");
      setRouteQuery("");
      setResults(trajectories);
      setDlList(newDownloads);
      setWarnings(notes);
      if (trajectories.length === 0) {
        setError("All flights failed — see the messages below.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Batch generation failed.");
      setResults([]);
      setDlList([]);
    } finally {
      setBusy(false);
    }
  }

  async function handleGenerate() {
    setBusy(true);
    setError(null);
    setWarnings([]);
    try {
      const dep = adep.trim().toUpperCase();
      const des = ades.trim().toUpperCase();

      // Any distinct ICAO pair is routable now; the server resolves the
      // typed route against the full AIP navdata.
      if (!dep || !des) {
        throw new Error("ADEP and ADES are required.");
      }
      if (dep === des) {
        throw new Error(`ADEP and ADES must differ (both ${dep}).`);
      }

      // Direction is implied by the departure aerodrome (used by CSV/Y8
      // mode only; FPL mode flies the route exactly as typed).
      const vtspToVtbs = dep === "VTSP";
      // "build" piggybacks the FPL pipeline with the composed string.
      const apiSource = routeMode === "csv" ? "csv" : "fpl";
      const apiRoute =
        routeMode === "build"
          ? builtRoute
          : routeMode === "csv"
            ? ""
            : routeStr;

      if (
        routeMode === "build" &&
        builtWpts.length < 2 &&
        routes.length === 0
      ) {
        throw new Error("Add at least 2 waypoints to build a route.");
      }
      if (routeMode === "fpl" && !routeStr.trim() && routes.length === 0) {
        throw new Error("Enter an Item-15 route string.");
      }

      // One trajectory per route. CSV mode is always a single route;
      // otherwise fly the queued list, or the single box if none queued.
      const list =
        apiSource === "csv"
          ? [""]
          : routes.length > 0
            ? routes
            : [apiRoute];
      const multi = list.length > 1;

      // Speed-schedule overrides — only include fields the user actually
      // set, so empty inputs keep the airframe default server-side.
      // --- DISABLED: speed schedule (advanced) — kept for future use. ---
      // const speedOverrides = buildSpeedOverrides();

      const settled = await Promise.all(
        list.map((r, i) =>
          generateTrajectory({
            source: apiSource,
            vtsp_to_vtbs: vtspToVtbs,
            adep: dep,
            ades: des,
            route: r,
            // Callsign stays exactly what the user typed (or "FLT" as
            // the default for an unfilled field). Multi-route requests
            // disambiguate via flight_index instead, so the Callsign
            // column in the exported CSV isn't munged with a route number.
            callsign: callsign || "FLT",
            eobt,
            gs_kt: gsKt,
            rfl,
            // ...speedOverrides, // DISABLED: speed schedule (advanced)
            ...(multi ? { flight_index: i } : {}),
          }),
        ),
      );

      const trajectories = settled.map((s) => s.result);
      const newDownloads: DownloadInfo[] = settled.map((s, i) => ({
        callsign: s.result.meta.callsign,
        flightKey: s.result.meta.flightKey,
        route:
          apiSource === "csv"
            ? `Airway CSV · ${dep}→${des}`
            : list[i] || "(route)",
        gpkg: s.downloads.gpkg,
        csv: s.downloads.csv,
        geojson: s.downloads.geojson,
      }));
      // The search-filter effect emits the (filtered) set to the map.
      setFlightQuery("");
      setRouteQuery("");
      setResults(trajectories);
      setDlList(newDownloads);
      setWarnings(settled.flatMap((s) => s.warnings));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generation failed.");
      setResults([]);
      setDlList([]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="gen">
      {/* Stat pills + batch action (mirrors the header in the mockup). */}
      <div className="plans-stats">
        <span className="plans-stat">
          <span className="ps-ico" aria-hidden>
            ≣
          </span>{" "}
          Plans: <b>{plans.length}</b>
        </span>
        <span className="plans-stat">
          <span className="ps-ico" aria-hidden>
            ⇄
          </span>{" "}
          Routes: <b>{totalRoutes}</b>
        </span>
        <span className="plans-stat">
          <span className="ps-ico" aria-hidden>
            ⌖
          </span>{" "}
          Airports: <b>{uniqueAirports.size}</b>
        </span>
        <button
          type="button"
          className="plans-genall"
          onClick={generateAll}
          disabled={busy}
          title="Generate every plan's routes in one batch"
        >
          {busy ? "Generating…" : "▶ Generate all"}
        </button>
      </div>

      {/* Plan tab strip (underline tabs). */}
      <div className="plans-tabs" role="tablist">
        {allDrafts.map((d, i) => (
          <div
            key={d.id}
            className={`plan-tab${d.id === activeId ? " active" : ""}`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={d.id === activeId}
              onClick={() => switchTo(d.id)}
            >
              {planLabel(d, i)}
            </button>
            {plans.length > 1 && (
              <button
                type="button"
                className="plan-x"
                title="Remove this plan"
                onClick={() => removePlan(d.id)}
              >
                ✕
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          className="plan-add"
          title="Add a flight plan"
          onClick={addPlan}
        >
          +
        </button>
      </div>

      <>
          {fileNote && <p className="file-note">📄 {fileNote}</p>}

          <div className="field-row">
            <label className="field">
              <span>Callsign</span>
              <input
                type="text"
                value={callsign}
                placeholder="Enter callsign"
                onChange={(e) => setCallsign(e.target.value.toUpperCase())}
              />
            </label>
            <label className="field">
              <span>Aircraft type</span>
              <select
                value={actype}
                onChange={(e) => setActype(e.target.value)}
              >
                {AIRCRAFT.map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="field-row">
            <label className="field">
              <span>ADEP</span>
              <IdentCombobox
                value={adep}
                onChange={setAdep}
                options={airportOptions}
                placeholder="Departure"
              />
            </label>
            <label className="field">
              <span>ADES</span>
              <IdentCombobox
                value={ades}
                onChange={setAdes}
                options={airportOptions}
                placeholder="Destination"
              />
            </label>
          </div>

          <label className="field">
            <span>EOBT (UTC)</span>
            <input
              type="datetime-local"
              value={eobt}
              onChange={(e) => setEobt(e.target.value)}
            />
          </label>

          <div className="field-row">
            <label className="field">
              <span>RFL</span>
              <input
                type="number"
                min={50}
                max={430}
                step={10}
                value={rfl}
                onChange={(e) => setRfl(Number(e.target.value))}
              />
            </label>
            <label className="field">
              <span>GS (kt)</span>
              <input
                type="number"
                min={100}
                max={600}
                value={gsKt}
                onChange={(e) => setGsKt(Number(e.target.value))}
              />
            </label>
          </div>

          {/* Advanced: speed-schedule tuning. Collapsed by default; the
              fields override the airframe BADA defaults so the user can
              tune total flight time toward the CAT62 reference.
              --- DISABLED: speed schedule (advanced) — kept for future use.
              Re-enable by uncommenting this block AND the related state,
              buildSpeedOverrides(), and the ...overrides / ...speedOverrides
              spreads above. ---
          <div className="tune">
            <button
              type="button"
              className="tune-toggle"
              aria-expanded={tuneOpen}
              onClick={() => setTuneOpen((v) => !v)}
            >
              <span>⚙ Speed schedule (advanced)</span>
              <span className="tune-caret">{tuneOpen ? "▾" : "▸"}</span>
            </button>

            {tuneOpen && (
              <div className="tune-body">
                <p className="tune-hint">
                  Leave blank to use the B738 defaults. Tune these to match
                  the CAT62 reference time (shown on each result).
                </p>
                <div className="field-row">
                  <label className="field">
                    <span>Climb CAS (kt)</span>
                    <input
                      type="number"
                      placeholder="290"
                      value={climbCas}
                      onChange={(e) => setClimbCas(e.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>Cruise Mach</span>
                    <input
                      type="number"
                      step="0.01"
                      placeholder="0.785"
                      value={cruiseMach}
                      onChange={(e) => setCruiseMach(e.target.value)}
                    />
                  </label>
                </div>
                <div className="field-row">
                  <label className="field">
                    <span>Descent CAS (kt)</span>
                    <input
                      type="number"
                      placeholder="290"
                      value={descentCas}
                      onChange={(e) => setDescentCas(e.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>Descent Mach</span>
                    <input
                      type="number"
                      step="0.01"
                      placeholder="0.78"
                      value={descentMach}
                      onChange={(e) => setDescentMach(e.target.value)}
                    />
                  </label>
                </div>
                <label className="field">
                  <span>Below-FL100 CAS cap (kt) — 250 ATC limit</span>
                  <input
                    type="number"
                    placeholder="250"
                    value={restrictCas}
                    onChange={(e) => setRestrictCas(e.target.value)}
                  />
                </label>
                {(climbCas ||
                  cruiseMach ||
                  descentCas ||
                  descentMach ||
                  restrictCas) && (
                  <button
                    type="button"
                    className="tune-reset"
                    onClick={() => {
                      setClimbCas("");
                      setCruiseMach("");
                      setDescentCas("");
                      setDescentMach("");
                      setRestrictCas("");
                    }}
                  >
                    Reset to defaults
                  </button>
                )}
              </div>
            )}
          </div>
          */}

          <div className="field">
            <span>Route string (Item 15)</span>
            <div className="rt-modes" role="tablist">
              <button
                role="tab"
                aria-selected={routeMode === "fpl"}
                className={routeMode === "fpl" ? "active" : undefined}
                onClick={() => setRouteMode("fpl")}
              >
                Type
              </button>
              <button
                role="tab"
                aria-selected={routeMode === "build"}
                className={routeMode === "build" ? "active" : undefined}
                onClick={() => setRouteMode("build")}
              >
                Pick waypoints
              </button>
              {/* <button
                role="tab"
                aria-selected={routeMode === "csv"}
                className={routeMode === "csv" ? "active" : undefined}
                onClick={() => setRouteMode("csv")}
              >
                Airway CSV
              </button> */}
            </div>

            {routeMode === "fpl" && (
              <>
                <input
                  type="text"
                  value={routeStr}
                  onChange={(e) => setRouteStr(e.target.value)}
                  placeholder="e.g. BKK Y8 PUT   or   DCT VANKO DCT PUT"
                />

                {!pairReady && (
                  <p className="rt-hint">
                    {!dep || !des
                      ? "Enter ADEP and ADES above to start a route."
                      : "ADEP and ADES cannot be the same."}
                  </p>
                )}

                {/* Best-route ranker — graph search over the whole Thai
                    airway network, for ANY aerodrome pair. When the pair
                    has a flight-time reference, only routes that PASS the
                    <5 min check are shown (falls back to all if none). */}
                {pairReady && bestRoutes.length > 0 && (
                  <div className="rt-routes">
                    <span>
                      Best routes ({dep} → {des})
                      {hasReference
                        ? passingRoutes.length > 0
                          ? " — within 5 min of reference"
                          : " — none within 5 min; showing all"
                        : " — ranked shortest first"}
                    </span>
                    {(showAllRoutes ? shownRoutes : shownRoutes.slice(0, 3)).map(
                      (r, i) => {
                        const passTag =
                          r.passed === true
                            ? " · PASS"
                            : r.passed === false
                              ? " · FAIL"
                              : "";
                        const timeTag = ` · ~${Math.round(r.simMin)} min`;
                        const cls = [
                          i === 0 ? "rt-best" : "",
                          r.passed === true ? "rt-pass" : "",
                          r.passed === false ? "rt-fail" : "",
                        ]
                          .filter(Boolean)
                          .join(" ");
                        const delta =
                          pairRefMin != null ? r.simMin - pairRefMin : null;
                        return (
                          <button
                            key={r.text}
                            type="button"
                            className={cls || undefined}
                            onClick={() => setRouteStr(r.text)}
                            title={
                              pairRefMin != null
                                ? `${r.distanceNm} NM · ~${Math.round(
                                    r.simMin,
                                  )} min sim vs ${Math.round(
                                    pairRefMin,
                                  )} min ref (Δ ${
                                    delta! >= 0 ? "+" : "-"
                                  }${Math.abs(Math.round(delta!))} min)`
                                : `${r.distanceNm} NM total`
                            }
                          >
                            {r.text} · {r.distanceNm} NM{timeTag}{passTag}
                          </button>
                        );
                      },
                    )}
                    {shownRoutes.length > 3 && (
                      <button
                        type="button"
                        className="rt-more"
                        onClick={() => setShowAllRoutes((v) => !v)}
                      >
                        {showAllRoutes
                          ? "See less"
                          : `See more (${shownRoutes.length - 3})`}
                      </button>
                    )}
                  </div>
                )}

                {/* Pair is set but no airway routing found (e.g. an
                    airport with no coords in the AIP) — guide the user. */}
                {pairReady && bestRoutes.length === 0 && (
                  <p className="rt-hint">
                    No airway routing found for {dep} → {des}. Type an
                    Item-15 route using any airway (e.g.{" "}
                    <code>BKK A1 UBL</code>) — every airway is expanded
                    automatically — or use <strong>Pick waypoints</strong>{" "}
                    to search all {waypointIdents.length} fixes.
                  </p>
                )}
              </>
            )}

            {routeMode === "build" && (
              <RouteBuilder
                idents={waypointIdents}
                selected={builtWpts}
                onChange={setBuiltWpts}
              />
            )}

            {routeMode === "csv" && (
              <p className="rt-csv-note">
                Uses the pre-resolved route from{" "}
                <code>csv Y8 </code> in the direction{" "}
                <strong>
                  {adep || "?"} → {ades || "?"}
                </strong>{" "}
                 .
              </p>
            )}

            {routeMode !== "csv" && (
              <div className="rt-multi">
                <button
                  type="button"
                  className="rt-add"
                  onClick={addRoute}
                  disabled={
                    !effectiveRoute.trim() || routes.length >= routeCap
                  }
                  title={`Fly several routes together — max ${routeCap} (the number of possible routes)`}
                >
                  + Add route ({routes.length}/{routeCap})
                </button>
                {routes.length > 0 && (
                  <ul className="rt-queue">
                    {routes.map((r, i) => (
                      <li key={`${r}-${i}`}>
                        <span>
                          {i + 1}. {r}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            setRoutes((xs) =>
                              xs.filter((_, k) => k !== i),
                            )
                          }
                          title="Remove"
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          <div className="fpl-prev">
            <span>PREVIEW FPL STRING</span>
            <code>{previewFpl || "— fill in the fields above —"}</code>
          </div>

          {/* Inline bulk import — drop a CSV/JSON of many flights to fan
              them out into tabs, ready for "Generate all". */}
          <div
            className={`gen-import${dragging ? " drag" : ""}`}
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              handleFiles(e.dataTransfer.files);
            }}
          >
            <span className="gen-import-ico" aria-hidden>
              ⬆
            </span>
            <span>Drag &amp; drop CSV / JSON to bulk-import flights ↗</span>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.json,.geojson,application/json,text/csv"
              multiple
              hidden
              onChange={(e) => handleFiles(e.target.files)}
            />
          </div>

          {/* Bottom action bar — hint on the left, Duplicate + Generate
              on the right (mirrors the mockup footer). */}
          <div className="gen-actionbar">
            <span className="gen-actionbar-hint">
              {pairReady
                ? `${dep} → ${des}`
                : "Fill in fields above"}
            </span>
            <div className="gen-actionbar-btns">
              <button
                type="button"
                className="plans-dup"
                onClick={duplicatePlan}
                title="Duplicate this plan into a new tab"
              >
                ⧉ Duplicate
              </button>
              <button
                className="generate"
                onClick={handleGenerate}
                disabled={busy}
              >
                {busy
                  ? "Generating…"
                  : routes.length > 1
                    ? `▶ Generate ${routes.length} routes`
                    : "▶ Generate this plan"}
              </button>
            </div>
          </div>
      </>

      {error && <p className="gen-error">⚠ {error}</p>}

      {warnings.length > 0 && (
        <ul className="gen-warnings">
          {warnings.map((w, i) => (
            <li key={i}>⚠ {w}</li>
          ))}
        </ul>
      )}

      {results.length > 0 && (
        <div className="gen-search">
          <div className="field-row">
            <label className="field">
              <span>1 · Flight</span>
              <SearchCombo
                value={flightQuery}
                onChange={setFlightQuery}
                suggestions={flightSugg}
                placeholder="VTBS VTSP · THA201 — empty = all flights"
              />
            </label>
            <label className="field">
              <span>2 · Route</span>
              <SearchCombo
                value={routeQuery}
                onChange={setRouteQuery}
                suggestions={routeSugg}
                placeholder="BKK Y8 PUT · R2 — empty = all routes"
              />
            </label>
          </div>
          <p className="gen-results-shortcut">
            ✓ Showing <strong>{filtered.length}</strong> of {results.length}{" "}
            {results.length === 1 ? "route" : "routes"}
            <span className="gen-results-shortcut-cta">
              Open <strong>Route Profile ▾</strong> in the menu
            </span>
          </p>
        </div>
      )}
    </section>
  );
}
     