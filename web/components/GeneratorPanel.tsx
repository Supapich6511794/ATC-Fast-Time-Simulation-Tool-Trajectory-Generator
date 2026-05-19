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

import { useMemo, useRef, useState } from "react";

import IdentCombobox, { type ComboOption } from "@/components/IdentCombobox";
import RouteBuilder from "@/components/RouteBuilder";
import { generateTrajectory } from "@/lib/api";
import { parseFlightFile, type FlightRecord } from "@/lib/flightFile";
import type { TrajectoryResult } from "@/lib/trajectory/types";

type InputMode = "manual" | "file";
/** How the route portion is supplied (all three kept, none removed). */
type RouteMode = "fpl" | "build" | "csv";

interface Props {
  /** Emits the generated trajectory (or null to clear) to the parent. */
  onResult: (result: TrajectoryResult | null) => void;
  /** Selectable waypoint idents (from the airway file) for RouteBuilder. */
  waypointIdents: string[];
}

/** Phase 1 flies the B738 only; others are listed for forward-compat. */
const AIRCRAFT = [
  ["B738", "B738 — Boeing 737-800"],
  ["A320", "A320 — Airbus A320"],
  ["B77W", "B77W — Boeing 777-300ER"],
] as const;

/** Suggested ICAO airports (free typing of any code is still allowed). */
const AIRPORTS: ComboOption[] = [
  { code: "VTBS", label: "Suvarnabhumi · Bangkok" },
  { code: "VTSP", label: "Phuket" },
  { code: "VTBD", label: "Don Mueang · Bangkok" },
  { code: "VTCC", label: "Chiang Mai" },
  { code: "VTSS", label: "Hat Yai" },
  { code: "VTUD", label: "Udon Thani" },
];

/** Phase 1 scope: the only corridor with route data. */
const SUPPORTED_PAIR = ["VTBS", "VTSP"];

export default function GeneratorPanel({ onResult, waypointIdents }: Props) {
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

  const [fileNote, setFileNote] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [result, setResult] = useState<TrajectoryResult | null>(null);
  const [downloads, setDownloads] = useState<{
    gpkg: string;
    csv: string;
    geojson: string;
  } | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // RouteBuilder selection → an Item-15 style string.
  const builtRoute = useMemo(
    () => (builtWpts.length ? `DCT ${builtWpts.join(" DCT ")} DCT` : ""),
    [builtWpts],
  );

  // The one real VTBS↔VTSP airway route (its fixes). Direction is set by
  // ADEP/ADES; the server re-orients the fixes to match.
  const possibleRoute = useMemo(
    () => waypointIdents.join(" "),
    [waypointIdents],
  );

  // Route/fix suggestions only make sense once a valid city pair is
  // entered — they're specific to the VTBS<->VTSP corridor.
  const dep = adep.trim().toUpperCase();
  const des = ades.trim().toUpperCase();
  const pairReady =
    !!dep &&
    !!des &&
    dep !== des &&
    SUPPORTED_PAIR.includes(dep) &&
    SUPPORTED_PAIR.includes(des);

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

      // Phase 1 scope: VTBS <-> VTSP only (validate before the round-trip).
      const SUPPORTED = ["VTBS", "VTSP"];
      if (!dep || !des) {
        throw new Error("ADEP and ADES are required.");
      }
      if (dep === des) {
        throw new Error(`ADEP and ADES must differ (both ${dep}).`);
      }
      const bad = [dep, des].filter((a) => !SUPPORTED.includes(a));
      if (bad.length) {
        throw new Error(
          `Now supports only VTBS ↔ VTSP. Unsupported: ${bad.join(", ")}.`,
        );
      }

      // Direction is implied by the departure aerodrome.
      const vtspToVtbs = dep === "VTSP";
      // "build" piggybacks the FPL pipeline with the composed string.
      const apiSource = routeMode === "csv" ? "csv" : "fpl";
      const apiRoute =
        routeMode === "build"
          ? builtRoute
          : routeMode === "csv"
            ? ""
            : routeStr;

      if (routeMode === "build" && builtWpts.length < 2) {
        throw new Error("Add at least 2 waypoints to build a route.");
      }
      if (routeMode === "fpl" && !routeStr.trim()) {
        throw new Error("Enter an Item-15 route string.");
      }

      const { result, warnings, downloads } = await generateTrajectory({
        source: apiSource,
        vtsp_to_vtbs: vtspToVtbs,
        adep: dep,
        ades: des,
        route: apiRoute,
        callsign,
        eobt, // datetime-local; server treats as UTC
        gs_kt: gsKt,
        rfl,
      });
      setResult(result);
      setDownloads(downloads);
      setWarnings(warnings);
      onResult(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generation failed.");
      setResult(null);
      setDownloads(null);
      onResult(null);
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
              .csv · .json · .geojson — multiple files supported
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
                placeholder="THA204"
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
                options={AIRPORTS}
                placeholder="VTBS"
              />
            </label>
            <label className="field">
              <span>ADES</span>
              <IdentCombobox
                value={ades}
                onChange={setAdes}
                options={AIRPORTS}
                placeholder="VTSP"
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
              <button
                role="tab"
                aria-selected={routeMode === "csv"}
                className={routeMode === "csv" ? "active" : undefined}
                onClick={() => setRouteMode("csv")}
              >
                Airway CSV
              </button>
            </div>

            {routeMode === "fpl" && (
              <>
                <input
                  type="text"
                  value={routeStr}
                  onChange={(e) => setRouteStr(e.target.value)}
                  placeholder="BKK Y8 PUT   or   DCT VANKO DCT PUT"
                />

                {!pairReady && (
                  <p className="rt-hint">
                    {!dep || !des
                      ? "Enter ADEP and ADES above to see the possible route and the allowed fixes for that pair."
                      : dep === des
                        ? "ADEP and ADES cannot be the same."
                        : `No information for ${dep} to ${des} — Route data for VTBS ↔ VTSP only.`}
                  </p>
                )}

                {pairReady && waypointIdents.length > 0 && (
                  <>
                    <div className="rt-routes">
                      <span>
                        Possible route ({dep} → {des}):
                      </span>
                      <button
                        type="button"
                        onClick={() => setRouteStr(possibleRoute)}
                        title={possibleRoute}
                      >
                        Apply {dep} → {des} route
                      </button>
                    </div>

                    <p className="rt-fixes">
                      <span>Allowed fixes — click to append:</span>
                      {waypointIdents.map((id) => (
                        <button
                          key={id}
                          type="button"
                          onClick={() =>
                            setRouteStr((s) =>
                              s.trim() ? `${s.trim()} ${id}` : id,
                            )
                          }
                        >
                          {id}
                        </button>
                      ))}
                    </p>
                  </>
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
                <code>VTPStoVTBS.csv</code> in the direction{" "}
                <strong>
                  {adep || "?"} → {ades || "?"}
                </strong>{" "}
                (swap via the ADEP/ADES fields).
              </p>
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
            {busy ? "Running Python pipeline…" : "▶ Generate trajectory"}
          </button>
        </>
      )}

      {error && <p className="gen-error">⚠ {error}</p>}

      {warnings.length > 0 && (
        <ul className="gen-warn">
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}

      {result && downloads && (
        <div className="gen-result">
          <dl>
            <div>
              <dt>Waypoints</dt>
              <dd>{result.stats.waypointCount}</dd>
            </div>
            <div>
              <dt>Points</dt>
              <dd>{result.stats.pointCount}</dd>
            </div>
            <div>
              <dt>Distance</dt>
              <dd>{result.stats.distanceNm} NM</dd>
            </div>
            <div>
              <dt>Flight time</dt>
              <dd>{result.stats.timeMinutes} min</dd>
            </div>
          </dl>
          <p className="gen-key">{result.meta.flightKey}</p>

          <div className="gen-downloads">
            <a className="dl-btn" href={downloads.gpkg}>
              ⬇ GeoPackage
            </a>
            <a className="dl-btn" href={downloads.csv}>
              ⬇ CSV
            </a>
            <a className="dl-btn" href={downloads.geojson}>
              ⬇ GeoJSON
            </a>
          </div>
        </div>
      )}
    </section>
  );
}
