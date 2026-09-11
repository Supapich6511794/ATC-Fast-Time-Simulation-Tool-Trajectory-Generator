"use client";

/**
 * SectorInfoPanel — what one ATC sector had to deal with in one hour.
 *
 * Three picks narrow the run down to a single cell of the sector-hour table:
 *
 *     kind (BACC sector / TMA / CTR / subsector)  →  which one (BANGKOK TMA)
 *                                                 →  which hour (0000-0100Z)
 *
 * and the answer is the workload figure a capacity study is after: how many
 * aircraft entered, how many conflicts arose, and how many of those the
 * controller actually resolved.
 *
 * The panel only reads `rows` — every number here comes from
 * `lib/report/flightEvents.buildSectorHours`, the same table the CSV export
 * writes, so the screen and the file can never disagree.
 */

import { useEffect, useMemo, useState } from "react";

import SectorLoadChart from "@/components/report/SectorLoadChart";
import { conflictBySectorXlsx, trafficBySectorXlsx } from "@/lib/report/chartData";
import { XLSX_MIME } from "@/lib/report/xlsx";
import {
  sectorHourCsv,
  sectorLoadSeries,
  type SectorHourRow,
  type SectorLoadPoint,
} from "@/lib/report/flightEvents";
import {
  describePosition,
  dynamicSectorsCsv,
  dynamicSpansCsv,
  hourRangeLabel,
  spanLabel,
  type DynamicPlan,
  type DynamicSectorConfig,
} from "@/lib/report/dynamicSectors";
import { saveBinaryFile, saveTextFile } from "@/lib/saveFile";

/** Layer keys as the airspace index names them, in the order a controller
 *  would think of them: the en-route sector first, then the terminal units. */
const LAYER_LABEL: Record<string, string> = {
  bacc: "BACC Sector",
  subsector: "Subsector",
  tma: "TMA",
  ctr: "CTR",
};
const LAYER_ORDER = ["bacc", "subsector", "tma", "ctr"];

interface Props {
  rows: SectorHourRow[] | null;
  loading: boolean;
  /** How many trajectories exist. Only used to tell the two empty states
   *  apart: nothing generated yet, versus generated but nothing crossed. */
  flightCount: number;
  /** The band-boxing plan over the same traffic, or null when the chosen layer
   *  has no adjacency to work with (the CTRs are islands). */
  dynamicPlan: DynamicPlan | null;
  dynamicConfig: DynamicSectorConfig;
  onDynamicConfig: (c: DynamicSectorConfig) => void;
  onClose: () => void;
}

/** "2026-09-07T00:00Z" -> "0000-0100 UTC". */
function hourLabel(hourUtc: string): string {
  const start = Date.parse(hourUtc);
  if (!Number.isFinite(start)) return hourUtc;
  const hh = (ms: number) =>
    new Date(ms).toISOString().slice(11, 13) + new Date(ms).toISOString().slice(14, 16);
  return hh(start) + "-" + hh(start + 3600000) + " UTC";
}

/** Tray-and-arrow, drawn rather than typed: the ⬇ glyph renders at a different
 *  weight in every font on the machine, and next to a text label it read as a
 *  stray character rather than as an icon. */
function DownloadIcon() {
  return (
    <svg
      className="si-dl-ico"
      viewBox="0 0 16 16"
      width="13"
      height="13"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M8 1.5v8m0 0L5 6.5m3 3 3-3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M2.5 11v2.5h11V11"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** "2026-09-07T00:05:12Z" -> "00:05" — the minute an aircraft crossed in. */
function hhmm(timeUtc: string): string {
  const ms = Date.parse(timeUtc);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, 16) : "";
}

/** "2026-09-07T00:00Z" -> "07 Sep". */
function dayLabel(hourUtc: string): string {
  const t = Date.parse(hourUtc);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toUTCString().slice(5, 11);
}

export default function SectorInfoPanel({
  rows,
  loading,
  flightCount,
  dynamicPlan,
  dynamicConfig,
  onDynamicConfig,
  onClose,
}: Props) {
  const [layer, setLayer] = useState<string>("");
  const [sector, setSector] = useState<string>("");
  const [hour, setHour] = useState<string>("");

  const layers = useMemo(() => {
    const present = new Set((rows ?? []).map((r) => r.layer).filter(Boolean));
    return LAYER_ORDER.filter((k) => present.has(k));
  }, [rows]);

  const sectors = useMemo(() => {
    const s = new Set(
      (rows ?? []).filter((r) => r.layer === layer).map((r) => r.sector),
    );
    return [...s].sort();
  }, [rows, layer]);

  const hours = useMemo(() => {
    const h = new Set(
      (rows ?? [])
        .filter((r) => r.layer === layer && r.sector === sector)
        .map((r) => r.hourUtc),
    );
    return [...h].sort();
  }, [rows, layer, sector]);

  // Keep the three picks consistent as the ones above them change: an hour
  // that belongs to another sector must not stay selected and show its numbers.
  useEffect(() => {
    if (layers.length > 0 && !layers.includes(layer)) setLayer(layers[0]);
  }, [layers, layer]);
  useEffect(() => {
    if (sectors.length > 0 && !sectors.includes(sector)) setSector(sectors[0]);
  }, [sectors, sector]);
  useEffect(() => {
    if (hours.length > 0 && !hours.includes(hour)) setHour(hours[0]);
  }, [hours, hour]);

  const cell = useMemo(
    () =>
      (rows ?? []).find(
        (r) => r.layer === layer && r.sector === sector && r.hourUtc === hour,
      ) ?? null,
    [rows, layer, sector, hour],
  );

  /** Save the SELECTED hour, not the whole run. The panel is a question about
   *  one cell — this sector, this hour — and the file it hands over is that
   *  cell. The full table is still exported from the download dialog, which is
   *  where a whole-run report belongs. Nothing is rebuilt: the row is already
   *  on screen, so the file is written from what the reader is looking at and
   *  the two can never disagree. */
  const downloadHour = () => {
    if (!cell) return;
    const slug = (v: string) => v.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "");
    const base =
      "sector_hour_" + slug(cell.sector) + "_" + slug(cell.hourUtc.slice(0, 16)) + "Z";
    saveTextFile(sectorHourCsv(cell), base + ".csv");
    // The companion: every sector's traffic in THIS hour, busiest first, ready
    // to select and chart. The hour file itself is one sector, which is the
    // wrong shape for the "which sector is busiest" question.
    saveBinaryFile(
      trafficBySectorXlsx(rows ?? [], layer, cell.hourUtc),
      base + "_chart_traffic_by_sector.xlsx",
      XLSX_MIME,
    );
  };

  /** Every hour of the run for the chosen sector — the shape of its day, which
   *  is what makes a single hour's count mean anything. Same rows the numbers
   *  above are read from, so the chart cannot disagree with them. */
  const loadSeries: SectorLoadPoint[] = useMemo(
    () => sectorLoadSeries(rows ?? [], layer, sector),
    [rows, layer, sector],
  );

  /** The band-boxing for the hour on screen, and the sectors that were split
   *  back into it. Both are read straight off the plan — the panel decides
   *  nothing itself. */
  const dyn = useMemo(() => {
    if (!dynamicPlan || dynamicPlan.config.layer !== layer) return null;
    const thisHour = dynamicPlan.hours.find((h) => h.hourUtc === hour);
    if (!thisHour) return null;
    return {
      hour: thisHour,
      merged: thisHour.positions.filter((p) => p.merged),
      standalone: thisHour.positions.filter((p) => !p.merged),
      spans: dynamicPlan.spans.filter(
        (sp) => sp.fromHourUtc <= hour && hour < sp.toHourUtc,
      ),
    };
  }, [dynamicPlan, layer, hour]);

  const downloadDynamic = () => {
    if (!dynamicPlan) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const base = "dynamic_sectorization_" + stamp;
    saveTextFile(dynamicSectorsCsv(dynamicPlan), base + ".csv");
    saveTextFile(dynamicSpansCsv(dynamicPlan), base + "_periods.csv");
    // Same three files the Download dialog writes: which button was pressed
    // must not change what the reader ends up with.
    saveBinaryFile(
      conflictBySectorXlsx(rows ?? [], dynamicPlan.config.layer, dynamicPlan),
      base + "_chart_conflict_by_sector.xlsx",
      XLSX_MIME,
    );
  };

  /** Every hour for the chosen sector, so one cell can be read in context. */
  const dayTotals = useMemo(() => {
    const mine = (rows ?? []).filter(
      (r) => r.layer === layer && r.sector === sector,
    );
    return {
      hours: mine.length,
      entries: mine.reduce((n, r) => n + r.entries, 0),
      conflicts: mine.reduce((n, r) => n + r.conflictsTotal, 0),
      resolved: mine.reduce((n, r) => n + r.conflictsResolved, 0),
    };
  }, [rows, layer, sector]);

  return (
    <div className="cdr-panel sector-info" role="dialog" aria-label="Sector information">
      <div className="cdr-panel-head">
        <strong>📊 Sector information</strong>
        <span className="cdr-head-actions">
          <button
            type="button"
            className="si-dl"
            onClick={downloadHour}
            disabled={!cell}
            title={
              cell
                ? "Save " +
                  cell.sector +
                  " " +
                  hourLabel(cell.hourUtc) +
                  " — 2 files: this hour as CSV, plus an .xlsx whose Chart tab holds the traffic-by-sector graph"
                : "Pick a sector and an hour first"
            }
          >
            <DownloadIcon />
            <span>This hour</span>
            <span className="si-dl-ext">CSV+XLSX</span>
          </button>
          <button
            type="button"
            className="cdr-panel-close"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </span>
      </div>

      {loading && (
        <p className="cdr-panel-empty">
          Walking every flight against the airspace…
        </p>
      )}

      {!loading && (!rows || rows.length === 0) && flightCount === 0 && (
        <p className="cdr-panel-empty">
          Nothing to show yet. This report is built from the FLOWN
          trajectories — which sector each aircraft was actually in, and when —
          so the flights have to be generated first. Press{" "}
          <b>Generate all</b>, then reopen this panel.
        </p>
      )}

      {!loading && (!rows || rows.length === 0) && flightCount > 0 && (
        <p className="cdr-panel-empty">
          {flightCount} flight{flightCount === 1 ? " is" : "s are"} generated,
          but the walk found no sector crossings to report — either the
          airspace polygons could not be loaded, or these trajectories stay
          outside every published sector.
        </p>
      )}

      {!loading && rows && rows.length > 0 && (
        <>
          <div className="si-picks">
            <label className="si-pick">
              <span>Airspace</span>
              <select value={layer} onChange={(e) => setLayer(e.target.value)}>
                {layers.map((k) => (
                  <option key={k} value={k}>
                    {LAYER_LABEL[k] ?? k}
                  </option>
                ))}
              </select>
            </label>
            <label className="si-pick">
              <span>{LAYER_LABEL[layer] ?? "Sector"}</span>
              <select value={sector} onChange={(e) => setSector(e.target.value)}>
                {sectors.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="si-pick">
              <span>Hour (UTC)</span>
              <select value={hour} onChange={(e) => setHour(e.target.value)}>
                {hours.map((h) => (
                  <option key={h} value={h}>
                    {dayLabel(h)} {hourLabel(h)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {cell && (
            <div className="si-body">
              <p className="si-head">
                {cell.sector} · {dayLabel(cell.hourUtc)} {hourLabel(cell.hourUtc)}
              </p>

              <div className="si-stats">
                <div className="si-stat">
                  <span className="si-num">{cell.entries}</span>
                  <span className="si-lbl">aircraft entered</span>
                  <span className="si-sub">
                    {cell.entryFlights.length} distinct
                  </span>
                </div>
                <div className="si-stat">
                  <span className="si-num">{cell.conflictsTotal}</span>
                  <span className="si-lbl">conflicts</span>
                  <span className="si-sub">in this hour</span>
                </div>
                <div className="si-stat resolved">
                  <span className="si-num">{cell.conflictsResolved}</span>
                  <span className="si-lbl">resolved by ATC</span>
                  <span className="si-sub">
                    {cell.conflictsTotal - cell.conflictsResolved} left open
                  </span>
                </div>
              </div>

              {cell.entryEvents.length > 0 && (
                <>
                  <h4 className="pdr-group-h">
                    Flights through this sector ({cell.entryFlights.length})
                  </h4>
                  {/* With the crossing minute, in the order they arrived —
                      the same lines, in the same order, that the download
                      writes. */}
                  <p className="si-list">
                    {cell.entryEvents.map((e, i) => (
                      <span key={e.flight + e.timeUtc + i} className="si-entry">
                        {i > 0 ? " · " : ""}
                        {e.flight} <span className="si-at">{hhmm(e.timeUtc)}</span>
                      </span>
                    ))}
                  </p>
                </>
              )}

              {cell.conflictFlights.length > 0 && (
                <>
                  <h4 className="pdr-group-h">
                    In conflict here ({cell.conflictFlights.length})
                  </h4>
                  <p className="si-list warn">{cell.conflictFlights.join(" · ")}</p>
                </>
              )}

              {cell.conflictsTotal === 0 && (
                <p className="si-note">
                  No conflicts recorded in this sector this hour. Note that
                  conflicts are only counted when CD&amp;R monitoring ran — with it
                  off this reads as nothing to do, not as nothing measured.
                </p>
              )}

              <p className="si-note">
                Across the whole run this sector had {dayTotals.entries} entries
                over {dayTotals.hours} hour{dayTotals.hours === 1 ? "" : "s"},
                with {dayTotals.resolved} of {dayTotals.conflicts} conflicts
                resolved.
              </p>

              {/* The traffic curve for this sector. Sits between the measured
                  hour and the proposal below, because it is what turns the
                  proposal from a claim into something visible: the bars under
                  the merge line ARE the hours that get band-boxed. */}
              <SectorLoadChart
                sector={cell.sector}
                points={loadSeries}
                selected={hour}
                threshold={
                  dynamicPlan && dynamicPlan.config.layer === layer
                    ? dynamicConfig.mergeBelow
                    : null
                }
                onPick={setHour}
              />

              {/* Dynamic sectorization. Deliberately below the measured
                  numbers: it is a proposal derived FROM them, and reading it
                  first invites taking it for a description of the airspace. */}
              {dyn && (
                <div className="si-dyn">
                  <h4 className="pdr-group-h">
                    Dynamic sectorization · {hourRangeLabel(dyn.hour.hourUtc)}
                  </h4>

                  {/* The two knobs, then the download on its own line. Squeezed
                      onto one row the labels wrapped and the button ended up
                      narrower than the number fields beside it. */}
                  <div className="si-dyn-cfg">
                    <label className="si-num">
                      <span className="si-num-lbl">Merge below</span>
                      <input
                        type="number"
                        min={1}
                        max={99}
                        value={dynamicConfig.mergeBelow}
                        onChange={(e) =>
                          onDynamicConfig({
                            ...dynamicConfig,
                            mergeBelow: Math.max(
                              1,
                              Math.min(99, Number(e.target.value) || 1),
                            ),
                          })
                        }
                      />
                      <span className="si-num-hint">aircraft / hour</span>
                    </label>
                    <label className="si-num">
                      <span className="si-num-lbl">Max sectors</span>
                      <input
                        type="number"
                        min={2}
                        max={6}
                        value={dynamicConfig.maxSectorsPerPosition}
                        onChange={(e) =>
                          onDynamicConfig({
                            ...dynamicConfig,
                            maxSectorsPerPosition: Math.max(
                              2,
                              Math.min(6, Number(e.target.value) || 2),
                            ),
                          })
                        }
                      />
                      <span className="si-num-hint">per position</span>
                    </label>
                  </div>

                  <button
                    type="button"
                    className="si-dl si-dl-wide"
                    onClick={downloadDynamic}
                    title="Save the whole-run plan and the band-box periods as CSV"
                  >
                    <DownloadIcon />
                    <span className="si-dl-text">
                      <b>Download plan</b>
                      {/* Two files land, which is worth saying before two save
                          dialogs appear unannounced. */}
                      <em>
                        3 files · plan and periods as CSV, plus an .xlsx whose
                        Chart tab holds the conflicts-by-sector graph
                      </em>
                    </span>
                  </button>

                  <p className="si-dyn-head">
                    {dyn.hour.positionsOpen} position
                    {dyn.hour.positionsOpen === 1 ? "" : "s"} for{" "}
                    {dyn.hour.baselineSectors} published sectors
                    {dyn.hour.baselineSectors > dyn.hour.positionsOpen && (
                      <>
                        {" "}
                        — {dyn.hour.baselineSectors - dyn.hour.positionsOpen} saved
                      </>
                    )}
                  </p>

                  {dyn.merged.length === 0 && (
                    <p className="si-note">
                      Nothing can be band-boxed this hour: every adjacent pair
                      would carry {dynamicConfig.mergeBelow} aircraft or more.
                      All {dyn.hour.baselineSectors} sectors are worked
                      separately.
                    </p>
                  )}

                  {dyn.merged.map((p) => (
                    <p key={p.label} className="si-dyn-merge">
                      {describePosition(p)}
                    </p>
                  ))}

                  {dyn.spans.length > 0 && (
                    <p className="si-note">
                      In force:{" "}
                      {dyn.spans
                        .map((sp) => sp.label + " " + spanLabel(sp))
                        .join(" · ")}
                    </p>
                  )}

                  {dyn.hour.splitBack.length > 0 && (
                    <p className="si-dyn-split">
                      ↩ Split back this hour: {dyn.hour.splitBack.join(", ")} —
                      traffic reached the threshold, so each returns to its own
                      position.
                    </p>
                  )}

                  <p className="si-note si-dyn-basis">
                    This is a <b>dynamic operational configuration</b> — who
                    works which airspace this hour. The published sector map is
                    unchanged: every position above is a grouping of the same{" "}
                    {dyn.hour.baselineSectors} baseline sectors, and nothing here
                    is written back to the airspace definition.
                  </p>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
