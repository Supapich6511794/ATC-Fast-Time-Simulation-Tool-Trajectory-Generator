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

import { memo, useEffect, useMemo, useRef, useState } from "react";

import IdentCombobox, { type ComboOption } from "@/components/IdentCombobox";
import RouteBuilder from "@/components/RouteBuilder";
import {
  fetchAirports,
  fetchAirwaysMap,
  fetchAllFixes,
  type AirportOption,
  type Fix,
} from "@/lib/aip";
import {
  generateBatch,
  generateTrajectory,
  listProcedures,
  type GenerateInput,
} from "@/lib/api";
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
import { kBestRoutes, type RouteOption } from "@/lib/routeFinder";
import {
  aipRouteOptions,
  fetchAipRoutes,
  type AipRoute,
} from "@/lib/aipRoutes";
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

/** One queued route + its terminal procedures = one generated flight.
 *  A plan's queue holds these combos so a single FPL can fly several
 *  (SID × route × STAR) combinations. Empty sid/star = direct / no procedure. */
interface RouteCombo {
  route: string;
  sid: string;
  star: string;
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
  /** Queued (SID × route × STAR) combinations — each becomes one flight. */
  routes: RouteCombo[];
  /** SID name (spliced at ADEP) / STAR name (spliced at ADES). "" = none.
   *  The editor's current pick; queued combos carry their own sid/star. */
  sid: string;
  star: string;
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
    sid: "",
    star: "",
  };
}

/** The (route, sid, star) combos a draft will fly: the queued combos, else
 *  a single combo from the current editor route + sid/star, else none. CSV
 *  mode is one server-resolved route. */
function draftCombos(d: PlanDraft): RouteCombo[] {
  if (d.routes.length > 0) return d.routes;
  if (d.routeMode === "csv") return [{ route: "", sid: d.sid, star: d.star }];
  const eff =
    d.routeMode === "build"
      ? d.builtWpts.length
        ? `DCT ${d.builtWpts.join(" DCT ")} DCT`
        : ""
      : d.routeStr.trim();
  return eff ? [{ route: eff, sid: d.sid, star: d.star }] : [];
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
  /** Live preview of just the route currently being typed/built (the
   *  "section in progress") — emitted as a 0- or 1-element list so the map
   *  can offer a "Current" preview scope alongside the "Full" one. */
  onCurrentPreviewChange?: (routes: PreviewPoint[][]) => void;
  /** Emits a short "generated / planned flights" status for the panel
   *  header (shown beside the title, top-right). */
  onReadyChange?: (text: string) => void;
  /** Selectable waypoint idents (from the airway file) for RouteBuilder. */
  waypointIdents: string[];
}

/** Selectable aircraft types. Each maps to a real BADA 3.16 climb/descent
 *  rate table plus a per-type speed schedule / ceiling in performance.py;
 *  any other ICAO type still works (server falls back to the B738 model). */
const AIRCRAFT = [
  ["B738", "B738 — Boeing 737-800"],
  ["B739", "B739 — Boeing 737-900"],
  ["B38M", "B38M — Boeing 737 MAX 8"],
  ["A319", "A319 — Airbus A319"],
  ["A320", "A320 — Airbus A320"],
  ["A321", "A321 — Airbus A321"],
  ["A20N", "A20N — Airbus A320neo"],
  ["A21N", "A21N — Airbus A321neo"],
  ["A332", "A332 — Airbus A330-200"],
  ["A333", "A333 — Airbus A330-300"],
  ["A359", "A359 — Airbus A350-900"],
  ["B772", "B772 — Boeing 777-200"],
  ["B77W", "B77W — Boeing 777-300ER"],
  ["B788", "B788 — Boeing 787-8"],
  ["B789", "B789 — Boeing 787-9"],
  ["E190", "E190 — Embraer E190"],
  ["AT76", "AT76 — ATR 72-600"],
  ["DH8D", "DH8D — Dash 8 Q400"],
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

// Memoised: this panel stays mounted (hidden via display:none) while the
// map aircraft animates, so MapApp re-renders it ~60×/sec. Its props are
// referentially stable (state setters + a useCallback'd onResult), so memo
// lets React skip reconciling this large tree on every animation frame.
function GeneratorPanel({
  onResult,
  onDownloadsChange,
  onPreviewChange,
  onCurrentPreviewChange,
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

  // Surveillance Profile — output sampling cadence (seconds) applied to the
  // whole generation. 5 s = en-route radar (default), 4 s = CAT62 terminal,
  // 1 s = high-rate, or a free "custom" value. Only changes export density;
  // flight time / CAT62 validation are unaffected.
  const [survMode, setSurvMode] = useState<"5" | "4" | "1" | "custom">("5");
  const [survCustom, setSurvCustom] = useState(5);
  const outputEveryS = Math.max(
    0.5,
    Math.min(60, survMode === "custom" ? survCustom : Number(survMode)),
  );

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
  const [routes, setRoutes] = useState<RouteCombo[]>([]);
  // SID/STAR terminal procedures to splice (empty = none). Their option
  // lists are fetched per ADEP/ADES below.
  const [sid, setSid] = useState("");
  const [star, setStar] = useState("");

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
  // Live progress text for "Generate all" while it streams the batch in
  // chunks (e.g. "Generating 80/242…").
  const [genProgress, setGenProgress] = useState("");

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
    sid,
    star,
  });

  /** Pick the route tab for a loaded plan: AIP when its route is a published
   *  filed route for the pair, otherwise Manual (so a custom/imported route
   *  shows automatically in the Manual editor, limited to the pair's
   *  waypoints). Empty route defaults to AIP so the filed-route suggestions
   *  appear. */
  const routeTabForDraft = (d: PlanDraft): "aip" | "manual" => {
    const a = d.adep.trim().toUpperCase();
    const b = d.ades.trim().toUpperCase();
    const norm = (s: string) => s.trim().toUpperCase().replace(/\s+/g, " ");
    const rt = norm(d.routes?.[0]?.route ?? d.routeStr ?? "");
    if (!rt) return d.builtWpts.length > 0 ? "manual" : "aip";
    return aipRoutes.some(
      (r) =>
        r.adep.toUpperCase() === a &&
        r.ades.toUpperCase() === b &&
        norm(r.route) === rt,
    )
      ? "aip"
      : "manual";
  };

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
    setSid(d.sid);
    setStar(d.star);
    // Auto-select AIP vs Manual based on whether the route is a filed route.
    setRouteTab(routeTabForDraft(d));
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
    (n, d) => n + draftCombos(d).length,
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

  // Predefined AIP flight-planning routes (ENR 4). When a city pair has a
  // published route it is used VERBATIM instead of the computed best-route
  // (no BKK/CMA navaid endpoints). RNAV vs Non-RNAV picks which table.
  const [aipRoutes, setAipRoutes] = useState<AipRoute[]>([]);
  // Route source: "aip" = pick a published filed route (RNAV + Non-RNAV
  // listed together); "manual" = build it (Type / Pick) from this pair's
  // AIP waypoints.
  const [routeTab, setRouteTab] = useState<"aip" | "manual">("aip");
  useEffect(() => {
    let cancelled = false;
    fetchAipRoutes()
      .then((rs) => !cancelled && setAipRoutes(rs))
      .catch(() => {
        /* no published routes available → computed best-route is used */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ADES suggestions cascade from ADEP: when the departure aerodrome has
  // published AIP routes, the destination dropdown lists only those filed
  // destinations (e.g. VTCC → VTBD, VTBS). Falls back to all aerodromes when
  // the ADEP has no AIP route (so best-route pairs still work); free-typing
  // any ICAO stays allowed by the combobox.
  const adesOptions = useMemo<ComboOption[]>(() => {
    const a = adep.trim().toUpperCase();
    if (!a) return airportOptions;
    const dests = new Set(
      aipRoutes
        .filter((r) => r.adep.toUpperCase() === a)
        .map((r) => r.ades.toUpperCase()),
    );
    if (dests.size === 0) return airportOptions;
    return airportOptions.filter((o) => dests.has(o.code.toUpperCase()));
  }, [adep, aipRoutes, airportOptions]);

  // Aerodrome reference coords, keyed by ICAO, for the route finder.
  const airportLL = useMemo(() => {
    const m = new Map<string, { lat: number; lon: number }>();
    for (const a of airports) m.set(a.code, { lat: a.lat, lon: a.lon });
    return m;
  }, [airports]);

  // K best routes for ANY aerodrome pair — graph search (Yen's
  // k-shortest) over the whole Thai airway network. Empty when either
  // airport's coordinates aren't in the AIP (e.g. a free-typed field).
  const bestRoutes = useMemo<(RouteOption & { caps?: boolean[] })[]>(() => {
    if (!pairReady) return [];
    const depLL = airportLL.get(dep) ?? null;
    const desLL = airportLL.get(des) ?? null;
    // Published AIP routes for BOTH capabilities (RNAV + Non-RNAV). When the
    // SAME route string is filed under both, merge it into ONE entry tagged
    // with both labels (no duplicate row). Used verbatim (no computed path,
    // no injected BKK/CMA). Falls back to the graph search when the pair has
    // no published route at all.
    const both = [
      ...aipRouteOptions(aipRoutes, dep, des, true, allFixes, airwaysMap, depLL, desLL).map(
        (r) => ({ ...r, rnav: true }),
      ),
      ...aipRouteOptions(aipRoutes, dep, des, false, allFixes, airwaysMap, depLL, desLL).map(
        (r) => ({ ...r, rnav: false }),
      ),
    ];
    if (both.length > 0) {
      const byText = new Map<
        string,
        RouteOption & { caps: boolean[] }
      >();
      for (const r of both) {
        const e = byText.get(r.text);
        if (e) {
          if (!e.caps.includes(r.rnav)) e.caps.push(r.rnav);
        } else {
          byText.set(r.text, {
            text: r.text,
            distanceNm: r.distanceNm,
            caps: [r.rnav],
          });
        }
      }
      // RNAV first within each capability set, then by distance.
      return [...byText.values()].map((e) => ({
        ...e,
        caps: [...e.caps].sort((a, b) => Number(b) - Number(a)),
      }));
    }
    if (allFixes.length === 0 || !depLL || !desLL) return [];
    return kBestRoutes(allFixes, airwaysMap, depLL, desLL, { k: 6 });
  }, [pairReady, dep, des, airportLL, allFixes, airwaysMap, aipRoutes]);

  // Whether the current pair resolves to ANY published AIP route, so the UI
  // can label it "AIP filed route".
  const usingAip = useMemo(
    () => bestRoutes.some((r) => r.caps !== undefined),
    [bestRoutes],
  );

  // Waypoints that appear in this pair's AIP routes (both capabilities) —
  // the allowed set for Manual mode (Pick/Type). Falls back to every fix
  // when the pair has no published route.
  const manualFixes = useMemo(() => {
    const a = dep.trim().toUpperCase();
    const b = des.trim().toUpperCase();
    const known = new Set(allFixes.map((f) => f.ident));
    const out = new Set<string>();
    for (const r of aipRoutes) {
      if (r.adep.toUpperCase() !== a || r.ades.toUpperCase() !== b) continue;
      for (const tok of r.route.toUpperCase().split(/\s+/)) {
        const t = tok.includes("/") ? tok.split("/")[0] : tok;
        if (t !== "DCT" && known.has(t)) out.add(t);
      }
    }
    return out.size > 0 ? [...out].sort() : waypointIdents;
  }, [aipRoutes, dep, des, allFixes, waypointIdents]);

  // SID/STAR procedure names published at the current ADEP/ADES. Fetched
  // whenever the airport changes; an airport with no coded procedures (or
  // an unreachable API) yields an empty list and the picker just shows
  // "None". SID belongs to ADEP, STAR to ADES.
  const [sidOptions, setSidOptions] = useState<string[]>([]);
  const [starOptions, setStarOptions] = useState<string[]>([]);
  useEffect(() => {
    if (!dep) {
      setSidOptions([]);
      return;
    }
    let cancelled = false;
    listProcedures(dep)
      .then((p) => !cancelled && setSidOptions(p.SID))
      .catch(() => !cancelled && setSidOptions([]));
    return () => {
      cancelled = true;
    };
  }, [dep]);
  useEffect(() => {
    if (!des) {
      setStarOptions([]);
      return;
    }
    let cancelled = false;
    listProcedures(des)
      .then((p) => !cancelled && setStarOptions(p.STAR))
      .catch(() => !cancelled && setStarOptions([]));
    return () => {
      cancelled = true;
    };
  }, [des]);

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
  // Per-route SID/STAR options: the procedures whose name connects to the
  // route's first / last fix (Thai naming convention, e.g. OLVUK→OLVU*).
  const routeProcs = (routeText: string) => {
    const known = new Set(allFixes.map((f) => f.ident));
    const toks = routeText
      .toUpperCase()
      .split(/\s+/)
      .map((t) => (t.includes("/") ? t.split("/")[0] : t))
      .filter((t) => t && t !== "DCT" && known.has(t));
    const first = toks[0] ?? null;
    const last = toks[toks.length - 1] ?? null;
    const pref = (n: string) => n.match(/^[A-Z]+/)?.[0] ?? n;
    return {
      sids: first ? sidOptions.filter((n) => first.startsWith(pref(n))) : [],
      stars: last ? starOptions.filter((n) => last.startsWith(pref(n))) : [],
    };
  };

  // Total possible combinations across the listed AIP routes:
  // Σ (SID+1) × (STAR+1). This is the queue cap and the "(n/total)" counter.
  const routeTotal = useMemo(() => {
    if (bestRoutes.length === 0) return 1;
    let t = 0;
    for (const r of bestRoutes) {
      const { sids, stars } = routeProcs(r.text);
      t += (sids.length + 1) * (stars.length + 1);
    }
    return Math.max(1, t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bestRoutes, sidOptions, starOptions, allFixes]);

  const comboKey = (c: RouteCombo) => `${c.sid}|${c.route}|${c.star}`;

  // SID/STAR filtered to procedures that actually connect to the chosen
  // route's terminal fixes: a SID must reach the route's FIRST en-route fix,
  // a STAR must start from its LAST. Thai procedure names are coded from that
  // fix (OLVUK → OLVU1B/OLVU3A…, ENBAT → ENBA2A…), so we match on the
  // alphabetic name prefix. Falls back to all options when nothing matches
  // (e.g. a computed route whose entry fix has no same-named SID), so the
  // picker is never an unintended dead-end.
  const routeEndFixes = useMemo(() => {
    // SID/STAR follow the route the user actually picked/typed (its first
    // and last fix); fall back to the top suggestion before one is chosen.
    const src =
      (effectiveRoute && effectiveRoute.trim()) || bestRoutes[0]?.text || "";
    const known = new Set(allFixes.map((f) => f.ident));
    const toks = src
      .toUpperCase()
      .split(/\s+/)
      .filter((t) => t && t !== "DCT" && known.has(t));
    return { first: toks[0] ?? null, last: toks[toks.length - 1] ?? null };
  }, [usingAip, effectiveRoute, bestRoutes, allFixes]);

  const sidShown = useMemo(() => {
    const f = routeEndFixes.first;
    if (!f) return sidOptions;
    const m = sidOptions.filter((n) =>
      f.startsWith(n.match(/^[A-Z]+/)?.[0] ?? n),
    );
    return m.length > 0 ? m : sidOptions;
  }, [sidOptions, routeEndFixes]);

  const starShown = useMemo(() => {
    const f = routeEndFixes.last;
    if (!f) return starOptions;
    const m = starOptions.filter((n) =>
      f.startsWith(n.match(/^[A-Z]+/)?.[0] ?? n),
    );
    return m.length > 0 ? m : starOptions;
  }, [starOptions, routeEndFixes]);
  /** Queue one (route, SID, STAR) combination (deduped + capped). */
  const addCombo = (c: RouteCombo) => {
    if (!c.route.trim()) return;
    setRoutes((xs) =>
      xs.length >= routeTotal || xs.some((x) => comboKey(x) === comboKey(c))
        ? xs
        : [...xs, c],
    );
  };

  /** "+ Add route" — queue the CURRENT selection: the picked/typed route
   *  with the currently-chosen SID/STAR. (Workflow: pick route, then
   *  SID/STAR, then add.) */
  const addCurrent = () => {
    const route = effectiveRoute.trim();
    if (!route) return;
    addCombo({ route, sid, star });
  };

  /** "Add all combinations" — every listed route × (its SIDs + no-SID) ×
   *  (its STARs + no-STAR), up to the total cap. */
  const addAllCombos = () => {
    const all: RouteCombo[] = [];
    for (const r of bestRoutes) {
      const { sids, stars } = routeProcs(r.text);
      for (const s of ["", ...sids])
        for (const t of ["", ...stars])
          all.push({ route: r.text, sid: s, star: t });
    }
    setRoutes((prev) => {
      const seen = new Set(prev.map(comboKey));
      const merged = [...prev];
      for (const c of all) {
        const k = comboKey(c);
        if (!seen.has(k)) {
          seen.add(k);
          merged.push(c);
        }
      }
      return merged.slice(0, routeTotal);
    });
  };

  /** Drop the active tab's route selection — the queue, the typed Item-15
   *  string and any picked waypoints. A route is specific to its city pair,
   *  so changing ADEP/ADES (e.g. after a Duplicate) must clear the routes
   *  carried over from the previous flight. Called only from the airport
   *  comboboxes' onChange (a user action) — never from loadDraft, so
   *  switching tabs / importing still restores each plan's own routes. */
  const clearRouteSelection = () => {
    setRoutes([]);
    setRouteStr("");
    setBuiltWpts([]);
  };
  const handleAdepChange = (v: string) => {
    const nv = v.trim().toUpperCase();
    if (nv !== adep.trim().toUpperCase()) {
      clearRouteSelection();
      setSid(""); // SID is ADEP-specific — drop it when ADEP changes.
      // ADES cascades from ADEP: if the new ADEP publishes AIP destinations
      // and the current ADES isn't one of them, clear it so the dependent
      // dropdown stays consistent.
      const dests = new Set(
        aipRoutes
          .filter((r) => r.adep.toUpperCase() === nv)
          .map((r) => r.ades.toUpperCase()),
      );
      if (dests.size > 0 && ades && !dests.has(ades.trim().toUpperCase())) {
        setAdes("");
        setStar("");
      }
    }
    setAdep(v);
  };
  const handleAdesChange = (v: string) => {
    if (v.trim().toUpperCase() !== ades.trim().toUpperCase()) {
      clearRouteSelection();
      setStar(""); // STAR is ADES-specific — drop it when ADES changes.
    }
    setAdes(v);
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

  // The single route the user is editing *right now* — the "section in
  // progress". Skipped if the edit string is already queued, to avoid
  // drawing it twice. Folded into both preview scopes below.
  const inProgressPreview = useMemo<PreviewPoint[]>(() => {
    if (allFixes.length === 0) return [];
    if (routeMode === "build") {
      const trimmed = builtRoute.trim();
      return trimmed && !routes.some((c) => c.route === trimmed)
        ? resolvePreviewFromIdents(builtWpts, allFixes)
        : [];
    }
    if (routeMode === "csv") {
      return isY8Corridor
        ? resolvePreviewFullY8(allFixes, airwaysMap, dep)
        : [];
    }
    const trimmed = routeStr.trim();
    return trimmed && !routes.some((c) => c.route === trimmed)
      ? resolveRoutePreview(trimmed, allFixes, airwaysMap)
      : [];
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

  // "Current" preview scope — the active tab's flight only: its queued
  // routes plus the route being typed/built. This is the flight the user
  // is composing right now (every queued route, not just the edit box).
  const currentPreview = useMemo<PreviewPoint[][]>(() => {
    if (allFixes.length === 0) return [];
    const out: PreviewPoint[][] = [];
    for (const c of routes) {
      const pts = resolveRoutePreview(c.route, allFixes, airwaysMap);
      if (pts.length > 0) out.push(pts);
    }
    if (inProgressPreview.length > 0) out.push(inProgressPreview);
    return out;
  }, [routes, allFixes, airwaysMap, inProgressPreview]);

  // "Full" preview scope — every route across EVERY plan/tab, not just the
  // active one, so a duplicated/previous flight's routes stay previewed
  // while a new tab is edited. The active tab uses the live queue (`routes`)
  // + the in-progress section; other tabs use their stored route list.
  const previewRoutes = useMemo<PreviewPoint[][]>(() => {
    if (allFixes.length === 0) return [];
    const out: PreviewPoint[][] = [];
    const resolveAll = (strs: string[]) => {
      for (const r of strs) {
        const s = r.trim();
        if (!s) continue;
        const pts = resolveRoutePreview(s, allFixes, airwaysMap);
        if (pts.length > 0) out.push(pts);
      }
    };
    for (const p of plans) {
      // Active tab: only its queued routes here — the route being typed is
      // appended once below (avoids a double-draw).
      if (p.id === activeId) resolveAll(routes.map((c) => c.route));
      else resolveAll(draftCombos(p).map((c) => c.route));
    }
    if (inProgressPreview.length > 0) out.push(inProgressPreview);
    return out;
  }, [plans, activeId, routes, allFixes, airwaysMap, inProgressPreview]);

  useEffect(() => {
    onPreviewChange?.(previewRoutes);
  }, [previewRoutes, onPreviewChange]);

  // Emit the active tab's flight on its own so the map's "Current" scope
  // can draw just this flight (queue + in-progress) and not the others.
  useEffect(() => {
    onCurrentPreviewChange?.(currentPreview);
  }, [currentPreview, onCurrentPreviewChange]);

  /** Turn a parsed flight row into a full PlanDraft. */
  function recordToPlan(r: FlightRecord): PlanDraft {
    const p = blankPlan();
    if (r.callsign) p.callsign = r.callsign;
    if (r.actype) p.actype = r.actype;
    if (r.adep) p.adep = r.adep;
    if (r.ades) p.ades = r.ades;
    if (r.eobt) p.eobt = r.eobt;
    if (r.rfl != null) p.rfl = r.rfl;
    if (r.sid) p.sid = r.sid;
    if (r.star) p.star = r.star;
    // A multi-route flight rebuilds as ONE plan with a route queue; a
    // single-route flight fills the Item-15 box.
    if (r.routes && r.routes.length > 0)
      p.routes = r.routes.map((rt) => ({
        route: rt,
        sid: r.sid ?? "",
        star: r.star ?? "",
      }));
    else if (r.route) p.routeStr = r.route;
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
        const list = draftCombos(d);
        if (list.length === 0) {
          skipped.push(`${planLabel(d, drafts.indexOf(d))}: no route`);
          continue;
        }
        const isCsv = d.routeMode === "csv";
        for (const c of list) {
          built.push({
            input: {
              source: isCsv ? "csv" : "fpl",
              vtsp_to_vtbs: dp === "VTSP",
              adep: dp,
              ades: ds,
              actype: d.actype,
              route: isCsv ? "" : c.route,
              callsign: d.callsign || "FLT",
              eobt: d.eobt,
              gs_kt: d.gsKt,
              rfl: d.rfl,
              output_every_s: outputEveryS,
              // ...overrides, // DISABLED: speed schedule (advanced)
              ...(c.sid ? { sid: c.sid } : {}),
              ...(c.star ? { star: c.star } : {}),
            },
            label: isCsv ? `Airway CSV · ${dp}→${ds}` : c.route || "(route)",
          });
        }
      }

      if (built.length === 0) {
        throw new Error(
          "Nothing to generate — every plan is missing ADEP/ADES or a route.",
        );
      }

      // Send the batch in chunks rather than one giant request. A 200+
      // route "Generate all" in a single POST can exceed a small/free API
      // host's request timeout or memory and drop the connection (which the
      // browser then reports as "Cannot reach the API"). Chunking keeps each
      // request small, lets the host free memory between chunks, gives live
      // progress, and lets one bad chunk fail without sinking the rest. The
      // global `start` offset keeps every route's flight_key unique.
      const CHUNK = 40;
      const allTraj: TrajectoryResult[] = [];
      const allDownloads: DownloadInfo[] = [];
      const notes: string[] = [...skipped];

      for (let start = 0; start < built.length; start += CHUNK) {
        const chunk = built.slice(start, start + CHUNK);
        const done = Math.min(start + chunk.length, built.length);
        setGenProgress(`Generating ${done}/${built.length}…`);
        try {
          const { results: batch, errors } = await generateBatch(
            chunk.map((b) => b.input),
            start,
          );
          // Within a chunk the k-th success aligns to the k-th non-failed
          // spec — recover the route label that way.
          const failed = new Set(errors.map((e) => e.index));
          const okLabels = chunk
            .filter((_, i) => !failed.has(i))
            .map((b) => b.label);
          batch.forEach((s, i) => {
            allTraj.push(s.result);
            allDownloads.push({
              callsign: s.result.meta.callsign,
              flightKey: s.result.meta.flightKey,
              route: okLabels[i] ?? "(route)",
              gpkg: s.downloads.gpkg,
              csv: s.downloads.csv,
              geojson: s.downloads.geojson,
            });
          });
          notes.push(...batch.flatMap((s) => s.warnings));
          notes.push(
            ...errors.map(
              (e) => `${e.callsign} ${e.adep}→${e.ades}: ${e.detail}`,
            ),
          );
        } catch (chunkErr) {
          // A whole chunk failed (e.g. a cold-start timeout). Record it and
          // keep going — later chunks usually succeed once the host is warm.
          notes.push(
            `Routes ${start + 1}-${done} failed: ` +
              (chunkErr instanceof Error ? chunkErr.message : "request failed"),
          );
        }
      }

      setFlightQuery("");
      setRouteQuery("");
      setResults(allTraj);
      setDlList(allDownloads);
      setWarnings(notes);
      if (allTraj.length === 0) {
        setError(
          "All flights failed — see the messages below. If this says " +
            "'Cannot reach the API', the server may be waking up; wait ~30s " +
            "and try again.",
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Batch generation failed.");
      setResults([]);
      setDlList([]);
    } finally {
      setGenProgress("");
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

      // One trajectory per (route, SID, STAR) combo. CSV mode is a single
      // route; otherwise fly the queued combos, or the single box if none
      // queued (carrying the editor's current SID/STAR).
      const comboList: RouteCombo[] =
        apiSource === "csv"
          ? [{ route: "", sid, star }]
          : routes.length > 0
            ? routes
            : [{ route: apiRoute, sid, star }];
      const multi = comboList.length > 1;

      const settled = await Promise.all(
        comboList.map((c, i) =>
          generateTrajectory({
            source: apiSource,
            vtsp_to_vtbs: vtspToVtbs,
            adep: dep,
            ades: des,
            actype,
            route: c.route,
            // Callsign stays exactly what the user typed (or "FLT" as
            // the default for an unfilled field). Multi-route requests
            // disambiguate via flight_index instead, so the Callsign
            // column in the exported CSV isn't munged with a route number.
            callsign: callsign || "FLT",
            eobt,
            gs_kt: gsKt,
            rfl,
            output_every_s: outputEveryS,
            ...(c.sid ? { sid: c.sid } : {}),
            ...(c.star ? { star: c.star } : {}),
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
            : [comboList[i].sid, comboList[i].route || "(route)", comboList[i].star]
                .filter(Boolean)
                .join(" · "),
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
          {busy ? genProgress || "Generating…" : "▶ Generate all"}
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
                onChange={handleAdepChange}
                options={airportOptions}
                placeholder="Departure"
              />
            </label>
            <label className="field">
              <span>ADES</span>
              <IdentCombobox
                value={ades}
                onChange={handleAdesChange}
                options={adesOptions}
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

          {/* Surveillance Profile — output sampling cadence for the exported
              track (and the UTC timestamps in the files). Applies to every
              plan in this generation; output density only, so the CAT62
              flight-time check is unaffected. */}
          <div className="field surv">
            <span>Surveillance Profile</span>
            <div
              className="surv-opts"
              role="radiogroup"
              aria-label="Surveillance Profile"
            >
              {(
                [
                  { v: "5", label: "5s", sub: "En-route Radar" },
                  { v: "4", label: "4s", sub: "CAT62 Terminal" },
                  { v: "1", label: "1s", sub: "High-rate" },
                  { v: "custom", label: "Custom", sub: "set interval" },
                ] as const
              ).map((o) => (
                <button
                  type="button"
                  key={o.v}
                  role="radio"
                  aria-checked={survMode === o.v}
                  className={`surv-opt${survMode === o.v ? " on" : ""}`}
                  onClick={() => setSurvMode(o.v)}
                >
                  <span className="surv-radio" aria-hidden />
                  <span className="surv-text">
                    <span className="surv-label">
                      {o.label}
                      {o.v === "5" && (
                        <span className="surv-default">Default</span>
                      )}
                    </span>
                    <span className="surv-sub">{o.sub}</span>
                  </span>
                </button>
              ))}
            </div>
            {survMode === "custom" && (
              <label className="surv-custom">
                <span>Interval (seconds)</span>
                <input
                  type="number"
                  min={0.5}
                  max={60}
                  step={0.5}
                  value={survCustom}
                  onChange={(e) =>
                    setSurvCustom(Number(e.target.value) || 0.5)
                  }
                />
              </label>
            )}
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
            <span>Route</span>
            <div className="rt-modes" role="tablist">
              <button
                role="tab"
                aria-selected={routeTab === "aip"}
                className={routeTab === "aip" ? "active" : undefined}
                onClick={() => {
                  setRouteTab("aip");
                  setRouteMode("fpl"); // AIP picks fill the Item-15 text box
                }}
              >
                AIP
              </button>
              <button
                role="tab"
                aria-selected={routeTab === "manual"}
                className={routeTab === "manual" ? "active" : undefined}
                onClick={() => setRouteTab("manual")}
              >
                Manual
              </button>
            </div>

            {!pairReady && (
              <p className="rt-hint">
                {!dep || !des
                  ? "Enter ADEP and ADES above to start a route."
                  : "ADEP and ADES cannot be the same."}
              </p>
            )}

            {/* AIP — pick a published filed route. RNAV + Non-RNAV are listed
                together; click to fill the route, add either or both. */}
            {routeTab === "aip" &&
              pairReady &&
              (bestRoutes.length > 0 ? (
                <div className="rt-routes">
                  <span>
                    {usingAip ? "AIP filed routes" : "Best routes"} ({dep} →{" "}
                    {des})
                    {usingAip
                      ? " — RNAV + Non-RNAV"
                      : hasReference
                        ? passingRoutes.length > 0
                          ? " — within 5 min of reference"
                          : " — none within 5 min; showing all"
                        : " — ranked shortest first"}
                  </span>
                  {(showAllRoutes ? shownRoutes : shownRoutes.slice(0, 4)).map(
                    (r) => {
                      const passTag =
                        r.passed === true
                          ? " · PASS"
                          : r.passed === false
                            ? " · FAIL"
                            : "";
                      const queued = routes.some((c) => c.route === r.text);
                      const selected = routeStr === r.text;
                      const cls = [
                        selected ? "rt-best" : "",
                        r.passed === true ? "rt-pass" : "",
                        r.passed === false ? "rt-fail" : "",
                      ]
                        .filter(Boolean)
                        .join(" ");
                      return (
                        <button
                          key={r.text}
                          type="button"
                          className={cls || undefined}
                          onClick={() => setRouteStr(r.text)}
                          title={`${r.distanceNm} NM · ~${Math.round(r.simMin)} min — select, then pick SID/STAR and Add`}
                        >
                          {r.caps?.includes(true) && (
                            <span className="rt-cap">RNAV</span>
                          )}
                          {r.caps?.includes(false) && (
                            <span className="rt-cap non">NON-RNAV</span>
                          )}
                          {queued && <span className="rt-cap added">✓ queued</span>}
                          {r.text} · {r.distanceNm} NM · ~
                          {Math.round(r.simMin)} min{passTag}
                        </button>
                      );
                    },
                  )}
                  {shownRoutes.length > 4 && (
                    <button
                      type="button"
                      className="rt-more"
                      onClick={() => setShowAllRoutes((v) => !v)}
                    >
                      {showAllRoutes
                        ? "See less"
                        : `See more (${shownRoutes.length - 4})`}
                    </button>
                  )}
                </div>
              ) : (
                <p className="rt-hint">
                  No AIP filed route for {dep} → {des}. Use{" "}
                  <strong>Manual</strong> to build one from this pair&apos;s
                  waypoints.
                </p>
              ))}

            {/* Manual — Type or Pick, limited to this pair's AIP waypoints. */}
            {routeTab === "manual" && (
              <>
                <div className="rt-modes rt-sub" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={routeMode !== "build"}
                    className={routeMode !== "build" ? "active" : undefined}
                    onClick={() => setRouteMode("fpl")}
                  >
                    Type
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={routeMode === "build"}
                    className={routeMode === "build" ? "active" : undefined}
                    onClick={() => setRouteMode("build")}
                  >
                    Pick waypoints
                  </button>
                </div>

                {routeMode !== "build" && (
                  <>
                    <input
                      type="text"
                      value={routeStr}
                      list="manual-fixes"
                      onChange={(e) => setRouteStr(e.target.value)}
                      placeholder="e.g. SABIS Y8 SAVSA"
                    />
                    <datalist id="manual-fixes">
                      {manualFixes.map((f) => (
                        <option key={f} value={f} />
                      ))}
                    </datalist>
                    {pairReady && manualFixes.length > 0 && (
                      <p className="rt-hint">
                        Waypoints for {dep} → {des}:{" "}
                        <strong>{manualFixes.join(" · ")}</strong>
                      </p>
                    )}
                  </>
                )}

                {routeMode === "build" && (
                  <RouteBuilder
                    idents={manualFixes}
                    selected={builtWpts}
                    onChange={setBuiltWpts}
                  />
                )}
              </>
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

          </div>

          {/* Terminal procedures — splice a SID at ADEP / STAR at ADES into
              the enroute route. Options come from the navdata for each
              aerodrome; "None" leaves that end as a direct leg. */}
          <div className="field-row">
            <label className="field">
              <span>SID (at {dep || "ADEP"})</span>
              <select
                value={sid}
                onChange={(e) => setSid(e.target.value)}
                disabled={!dep}
              >
                <option value="">None (direct departure)</option>
                {sid && !sidShown.includes(sid) && (
                  <option value={sid}>{sid}</option>
                )}
                {sidShown.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>STAR (at {des || "ADES"})</span>
              <select
                value={star}
                onChange={(e) => setStar(e.target.value)}
                disabled={!des}
              >
                <option value="">None (direct arrival)</option>
                {star && !starShown.includes(star) && (
                  <option value={star}>{star}</option>
                )}
                {starShown.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {((dep && sidOptions.length === 0) ||
            (des && starOptions.length === 0)) && (
            <p className="rt-hint">
              {sidOptions.length === 0 && starOptions.length === 0
                ? `No coded SID/STAR in the navdata for ${dep || "ADEP"} / ${
                    des || "ADES"
                  }.`
                : sidOptions.length === 0
                  ? `No coded SID for ${dep}.`
                  : `No coded STAR for ${des}.`}
            </p>
          )}

          {/* Queue of (route × SID × STAR) combinations — one flight each.
              Workflow: pick a route + SID/STAR above, then Add; or Add all.
              Total = Σ (SID+1) × (STAR+1) over the listed routes. */}
          <div className="rt-multi">
            <div className="rt-multi-btns">
              <button
                type="button"
                className="rt-add"
                onClick={addCurrent}
                disabled={!effectiveRoute.trim() || routes.length >= routeTotal}
                title="Queue the selected route with the chosen SID / STAR"
              >
                + Add route ({routes.length}/{routeTotal})
              </button>
              {usingAip && routeTotal > 1 && (
                <button
                  type="button"
                  className="rt-add-all"
                  onClick={addAllCombos}
                  disabled={routes.length >= routeTotal}
                  title="Queue every SID × route × STAR combination"
                >
                  Add all ({routeTotal})
                </button>
              )}
              {routes.length > 0 && (
                <button
                  type="button"
                  className="rt-clear"
                  onClick={() => setRoutes([])}
                  title="Clear the queue"
                >
                  Clear
                </button>
              )}
            </div>
            {routes.length > 0 && (
              <ul className="rt-queue">
                {routes.map((c, i) => (
                  <li key={`${comboKey(c)}-${i}`}>
                    <span>
                      {i + 1}.{" "}
                      {c.sid && <span className="rt-cap">{c.sid}</span>}
                      {c.route}
                      {c.star && <span className="rt-cap non">{c.star}</span>}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setRoutes((xs) => xs.filter((_, k) => k !== i))
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

export default memo(GeneratorPanel);
     