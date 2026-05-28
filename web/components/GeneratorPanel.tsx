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
 *   - "Upload file"  — drop a .csv/.json/.geojson; it is parsed and the
 *                       fields are pre-filled and still fully editable.
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
import { generateTrajectory } from "@/lib/api";
import { parseFlightFile, type FlightRecord } from "@/lib/flightFile";
import {
  resolvePreviewFromIdents,
  resolvePreviewFullY8,
  resolveRoutePreview,
  type PreviewPoint,
} from "@/lib/routePreview";
import { kBestRoutes } from "@/lib/routeFinder";
import type { TrajectoryResult } from "@/lib/trajectory/types";

type InputMode = "manual" | "file";
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
  waypointIdents,
}: Props) {
  const [mode, setMode] = useState<InputMode>("manual");
  const [routeMode, setRouteMode] = useState<RouteMode>("fpl");

  const [callsign, setCallsign] = useState("");
  const [actype, setActype] = useState("B738");
  const [adep, setAdep] = useState("");
  const [ades, setAdes] = useState("");
  const [eobt, setEobt] = useState("");
  const [gsKt, setGsKt] = useState(450);
  const [rfl, setRfl] = useState(350);
  const [routeStr, setRouteStr] = useState("");
  const [builtWpts, setBuiltWpts] = useState<string[]>([]);
  /** Extra Item-15 routes to fly together (capped at #possible routes). */
  const [routes, setRoutes] = useState<string[]>([]);

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

  /** Apply a parsed file record onto the editable fields. */
  function applyRecord(r: FlightRecord) {
    if (r.callsign) setCallsign(r.callsign);
    if (r.actype) setActype(r.actype);
    if (r.adep) setAdep(r.adep);
    if (r.ades) setAdes(r.ades);
    if (r.eobt) setEobt(r.eobt);
    if (r.rfl != null) setRfl(r.rfl);
    if (r.route) {
      setRouteStr(r.route);
      setRouteMode("fpl");
    }
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
      applyRecord(all[0]);
      setMode("manual");
      setFileNote(
        all.length > 1
          ? `Loaded ${all.length} flights — showing the first; edit before Generate`
          : "Loaded from file — review and edit before Generate",
      );
    } catch (e) {
      setFileNote(null);
      setError(e instanceof Error ? e.message : "Could not parse file.");
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
      setResults(trajectories);
      setDlList(newDownloads);
      setWarnings(settled.flatMap((s) => s.warnings));
      onResult(trajectories);
      onDownloadsChange?.(newDownloads);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generation failed.");
      setResults([]);
      setDlList([]);
      onResult(null);
      onDownloadsChange?.([]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="gen">
      <div className="gen-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={mode === "manual"}
          className={mode === "manual" ? "active" : undefined}
          onClick={() => setMode("manual")}
        >
          ⌨ Manual
        </button>
        <button
          role="tab"
          aria-selected={mode === "file"}
          className={mode === "file" ? "active" : undefined}
          onClick={() => setMode("file")}
        >
          ⬆ Upload file
        </button>
      </div>

      {mode === "file" ? (
        <>
          <div
            className={`dropzone${dragging ? " drag" : ""}`}
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
            <div className="dz-icon">⬆</div>
            <p className="dz-main">Drag a file here, or click to choose</p>
            <p className="dz-sub">
              .csv · .json · .pdf · .geojson — multiple files supported
            </p>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.json,.geojson,application/json,text/csv"
              multiple
              hidden
              onChange={(e) => handleFiles(e.target.files)}
            />
          </div>
        </>
      ) : (
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
                    airway network, for ANY aerodrome pair. */}
                {pairReady && bestRoutes.length > 0 && (
                  <div className="rt-routes">
                    <span>
                      Best routes ({dep} → {des}) — ranked shortest first.
                    </span>
                    {(showAllRoutes ? bestRoutes : bestRoutes.slice(0, 3)).map(
                      (r, i) => {
                        const best = bestRoutes[0];
                        const tag =
                          i === 0
                            ? " ★ recommended"
                            : r.distanceNm > best.distanceNm
                              ? ` · +${Math.round(r.distanceNm - best.distanceNm)} NM`
                              : "";
                        return (
                          <button
                            key={r.text}
                            type="button"
                            className={i === 0 ? "rt-best" : undefined}
                            onClick={() => setRouteStr(r.text)}
                            title={`${r.distanceNm} NM total`}
                          >
                            {r.text} · {r.distanceNm} NM{tag}
                          </button>
                        );
                      },
                    )}
                    {bestRoutes.length > 3 && (
                      <button
                        type="button"
                        className="rt-more"
                        onClick={() => setShowAllRoutes((v) => !v)}
                      >
                        {showAllRoutes
                          ? "See less"
                          : `See more (${bestRoutes.length - 3})`}
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

          <button
            className="generate"
            onClick={handleGenerate}
            disabled={busy}
          >
            {busy
              ? "Generating…"
              : routes.length > 1
                ? `▶ Generate ${routes.length} routes`
                : "▶ Generate trajectory"}
          </button>
        </>
      )}

      {error && <p className="gen-error">⚠ {error}</p>}

      {results.length > 0 && (
        <p className="gen-results-shortcut">
          ✓ {results.length === 1 ? "1 trajectory" : `${results.length} trajectories`} ready
          <span className="gen-results-shortcut-cta">
            Open <strong>Generated ▾</strong> in the menu
          </span>
        </p>
      )}
    </section>
  );
}
     