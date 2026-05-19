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

const QUICK_ROUTES = ["BKK Y8 PUT", "DCT VANKO PUT", "MOTNA Y8 SAVSA"];

export default function GeneratorPanel({ onResult, waypointIdents }: Props) {
  const [mode, setMode] = useState<InputMode>("manual");
  const [routeMode, setRouteMode] = useState<RouteMode>("fpl");

  const [callsign, setCallsign] = useState("THA204");
  const [actype, setActype] = useState("B738");
  const [adep, setAdep] = useState("VTBS");
  const [ades, setAdes] = useState("VTSP");
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
      // Direction is implied by the departure aerodrome.
      const vtspToVtbs = adep.trim().toUpperCase() === "VTSP";
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
                onChange={(e) => setCallsign(e.target.value.toUpperCase())}
              />
              <em className="hint">airline + flight no.</em>
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
              <em className="hint">B738 in Phase 1</em>
            </label>
          </div>

          <div className="field-row">
            <label className="field">
              <span>ADEP</span>
              <input
                type="text"
                value={adep}
                onChange={(e) => setAdep(e.target.value.toUpperCase())}
              />
              <em className="hint">departure ICAO</em>
            </label>
            <label className="field">
              <span>ADES</span>
              <input
                type="text"
                value={ades}
                onChange={(e) => setAdes(e.target.value.toUpperCase())}
              />
              <em className="hint">destination ICAO</em>
            </label>
          </div>

          <label className="field">
            <span>EOBT (UTC)</span>
            <input
              type="datetime-local"
              value={eobt}
              onChange={(e) => setEobt(e.target.value)}
            />
            <em className="hint">push-back time</em>
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
              <em className="hint">requested flight level</em>
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
              <em className="hint">ground speed</em>
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
                <div className="chips">
                  {QUICK_ROUTES.map((r) => (
                    <button
                      key={r}
                      type="button"
                      className="chip"
                      onClick={() => setRouteStr(r)}
                    >
                      {r}
                    </button>
                  ))}
                </div>
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
