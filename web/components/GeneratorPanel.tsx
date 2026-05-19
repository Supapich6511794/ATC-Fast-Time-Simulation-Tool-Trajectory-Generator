"use client";

/**
 * GeneratorPanel — click-driven UI for Phase 1.
 *
 * This panel does NO trajectory math. It collects inputs, calls the Python
 * FastAPI server (`/api/generate`), and shows the result. All parsing,
 * pyproj/WGS-84 geodesy and GeoPackage/CSV writing happen in the real
 * `trajectory_sim` package server-side — the web is just the front-end.
 *
 * Route sources: pre-resolved airway CSV, a typed Item-15 string, or the
 * point-and-click RouteBuilder (easiest for long multi-waypoint routes).
 */

import { useMemo, useState } from "react";

import RouteBuilder from "@/components/RouteBuilder";
import { generateTrajectory } from "@/lib/api";
import type { TrajectoryResult } from "@/lib/trajectory/types";

type RouteSource = "csv" | "fpl" | "build";

interface Props {
  /** Emits the generated trajectory (or null to clear) to the parent. */
  onResult: (result: TrajectoryResult | null) => void;
  /** Selectable waypoint idents (from the airway file) for RouteBuilder. */
  waypointIdents: string[];
}

export default function GeneratorPanel({ onResult, waypointIdents }: Props) {
  const [source, setSource] = useState<RouteSource>("csv");
  const [vtspToVtbs, setVtspToVtbs] = useState(true);
  const [routeStr, setRouteStr] = useState("DCT MOTNA DCT SABIS DCT VANKO ");
  const [builtWpts, setBuiltWpts] = useState<string[]>([]);
  const [callsign, setCallsign] = useState("THA205");
  const [eobt, setEobt] = useState("2026-01-03T08:15");
  const [gsKt, setGsKt] = useState(450);
  const [rfl, setRfl] = useState(330);

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

  async function handleGenerate() {
    setBusy(true);
    setError(null);
    setWarnings([]);
    try {
      // "build" piggybacks the FPL pipeline with the composed string.
      const apiSource = source === "build" ? "fpl" : source;
      const apiRoute = source === "build" ? builtRoute : routeStr;

      if (source === "build" && builtWpts.length < 2) {
        throw new Error("Add at least 2 waypoints to build a route.");
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
      <h2>Generate trajectory</h2>

      <label className="field">
        <span>Route source</span>
        <select
          value={source}
          onChange={(e) => setSource(e.target.value as RouteSource)}
        >
          <option value="csv">Airway CSV (VTPStoVTBS.csv)</option>
          <option value="fpl">FPL route string</option>
          <option value="build">Build by waypoints (pick)</option>
        </select>
      </label>

      {source === "csv" && (
        <label className="field">
          <span>Direction</span>
          <select
            value={vtspToVtbs ? "1" : "0"}
            onChange={(e) => setVtspToVtbs(e.target.value === "1")}
          >
            <option value="1">VTSP → VTBS (Phuket → Bangkok)</option>
            <option value="0">VTBS → VTSP (Bangkok → Phuket)</option>
          </select>
        </label>
      )}

      {source === "fpl" && (
        <label className="field">
          <span>Item-15 route string</span>
          <input
            type="text"
            value={routeStr}
            onChange={(e) => setRouteStr(e.target.value)}
            placeholder="DCT MOTNA DCT SABIS DCT"
          />
        </label>
      )}

      {source === "build" && (
        <div className="field">
          <span>Pick waypoints (in order)</span>
          <RouteBuilder
            idents={waypointIdents}
            selected={builtWpts}
            onChange={setBuiltWpts}
          />
          {builtRoute && <code className="rb-preview">{builtRoute}</code>}
        </div>
      )}

      <div className="field-row">
        <label className="field">
          <span>Callsign</span>
          <input
            type="text"
            value={callsign}
            onChange={(e) => setCallsign(e.target.value.toUpperCase())}
          />
        </label>
        <label className="field">
          <span>Ground speed (kt)</span>
          <input
            type="number"
            min={100}
            max={600}
            value={gsKt}
            onChange={(e) => setGsKt(Number(e.target.value))}
          />
        </label>
      </div>

      <label className="field">
        <span>RFL — Requested Flight Level (×100 ft)</span>
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
        <span>EOBT (UTC)</span>
        <input
          type="datetime-local"
          value={eobt}
          onChange={(e) => setEobt(e.target.value)}
        />
      </label>

      <button className="generate" onClick={handleGenerate} disabled={busy}>
        {busy ? "Running Python pipeline…" : "▶ Generate trajectory"}
      </button>

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
          {/* <p className="gen-note">
            Computed by the real Python <code>trajectory_sim</code> ·
            pyproj.Geod (WGS-84). GeoPackage is the genuine Phase 1
            deliverable file. Altitude/TAS arrive in Phase 2–3.
          </p> */}
        </div>
      )}
    </section>
  );
}
