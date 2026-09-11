/**
 * Chart-ready views of the run reports.
 *
 * A .csv is a table and nothing else — it cannot carry an embedded chart
 * object, however it is named. What it CAN carry is a table already shaped like
 * the chart someone wants, so that selecting the block and pressing Insert →
 * Chart in Excel produces the right picture with no re-arranging: the X values
 * in the first column, one Y series per column after it, rows already in the
 * order the axis should read, and no blank cells to break a line.
 *
 * That is what each function here returns. The data files stay exactly as they
 * were — one flat table per report, for filtering and pivoting — and each gains
 * a small companion file holding just the series for its headline chart:
 *
 *   | report                | chart               | X         | Y            |
 *   |-----------------------|---------------------|-----------|--------------|
 *   | Dynamic sectorization | Conflict by sector  | sector    | conflicts    |
 *   | Sector hours          | Standard vs merged  | hour      | sector count |
 *   | Sector information    | Traffic by sector   | sector    | entries      |
 *   | Flight events         | Flight trajectory   | longitude | latitude     |
 *
 * The two "by sector" charts are sorted busiest-first, which is what makes the
 * question they answer — *which* sector — readable at a glance; the two
 * time/space charts keep their natural order, because a trajectory or a day
 * re-sorted by value is meaningless.
 */

import {
  flightEventsTable,
  sectorHoursTable,
  type FlightEventRow,
  type SectorHourRow,
} from "./flightEvents";
import { dynamicSectorsTable, type DynamicPlan } from "./dynamicSectors";
import { buildWorkbook, type Cell, type ChartSpec } from "./xlsx";

/** The sheet the chart reads its series from. The report itself always
 *  sits on the first tab, untouched. */
const SERIES_SHEET = "Chart data";

/**
 * One workbook: the report as it stands, the series a chart needs, and the
 * chart on a tab of its own.
 *
 * The report sheet is the same table the .csv holds — same columns, same
 * rows, same order. A chart wants a different shape (pivoted, aggregated,
 * sorted by value), and giving it that shape at the cost of the report would
 * be trading the thing being reported for a picture of it.
 */
function reportWithChart(
  reportName: string,
  report: Cell[][],
  series: Cell[][],
  spec: ChartSpec,
): Uint8Array {
  return buildWorkbook({
    sheets: [
      { name: reportName, rows: report },
      { name: SERIES_SHEET, rows: series },
    ],
    chart: { spec, dataSheet: SERIES_SHEET },
  });
}

// --- CSV --------------------------------------------------------------------

const CRLF = String.fromCharCode(13, 10);

function csvField(v: string | number): string {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** The same table the workbook holds, in the plainer container. */
function rowsCsv(rows: Cell[][]): string {
  return (
    "﻿" +
    rows.map((r) => r.map((v) => csvField(v ?? "")).join(",")).join(CRLF) +
    CRLF
  );
}


/** "2026-09-07T03:00Z" -> "0300". Excel keeps this as text, which is what an
 *  axis label wants — a real time value would be re-formatted per locale. */
function hourLabel(hourUtc: string): string {
  const ms = Date.parse(hourUtc);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, 16).replace(":", "") : hourUtc;
}

// --- 1. Conflict by sector --------------------------------------------------

/**
 * Which sectors generated the conflicts, busiest first.
 *
 * Totals across the whole run: a conflict is counted in the sector that owned
 * it, and `resolved` is the part a controller actually closed out. `open` is
 * the remainder — the column a capacity study is really after, since a sector
 * that produces conflicts nobody resolved is the one that is over its limit.
 */
export function conflictBySectorRows(rows: SectorHourRow[], layer: string): Cell[][] {
  const byS = new Map<string, { total: number; resolved: number; hours: number }>();
  for (const r of rows) {
    if (r.layer !== layer) continue;
    const e = byS.get(r.sector) ?? { total: 0, resolved: 0, hours: 0 };
    e.total += r.conflictsTotal;
    e.resolved += r.conflictsResolved;
    e.hours += 1;
    byS.set(r.sector, e);
  }
  const out = [...byS.entries()].sort(
    (a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]),
  );
  return [
    ["sector", "conflicts", "resolved", "open"],
    ...out.map(([sector, e]) => [sector, e.total, e.resolved, e.total - e.resolved]),
  ];
}

export const CONFLICT_BY_SECTOR_CHART: ChartSpec = {
  kind: "line",
  title: "Conflicts by sector",
  xTitle: "Sector",
  yTitle: "Conflicts",
  catCol: 0,
  valCols: [1, 2, 3],
};

export function conflictBySectorCsv(rows: SectorHourRow[], layer: string): string {
  return rowsCsv(conflictBySectorRows(rows, layer));
}

export function conflictBySectorXlsx(
  rows: SectorHourRow[],
  layer: string,
  plan: DynamicPlan,
): Uint8Array {
  return reportWithChart(
    "Dynamic sectorization",
    dynamicSectorsTable(plan),
    conflictBySectorRows(rows, layer),
    CONFLICT_BY_SECTOR_CHART,
  );
}

// --- 2. Standard vs merged --------------------------------------------------

/**
 * How many controller positions the airspace needed, hour by hour.
 *
 * Two lines over the same hours: the published sector count, which is flat by
 * definition, and the positions the traffic actually justified. The gap between
 * them IS the dynamic sectorization result, which is why the saving is a column
 * of its own rather than something to be read off by subtracting.
 */
export function standardVsMergedRows(plan: DynamicPlan): Cell[][] {
  return [
    ["hour", "hour_utc", "standard_sectors", "merged_positions", "positions_saved"],
    ...plan.hours.map((h) => [
      hourLabel(h.hourUtc),
      h.hourUtc,
      h.baselineSectors,
      h.positionsOpen,
      h.baselineSectors - h.positionsOpen,
    ]),
  ];
}

export const STANDARD_VS_MERGED_CHART: ChartSpec = {
  kind: "line",
  title: "Standard vs merged positions",
  xTitle: "Hour (UTC)",
  yTitle: "Sectors / positions",
  catCol: 0,
  valCols: [2, 3, 4],
};

export function standardVsMergedCsv(plan: DynamicPlan): string {
  return rowsCsv(standardVsMergedRows(plan));
}

export function standardVsMergedXlsx(
  plan: DynamicPlan,
  rows: SectorHourRow[],
): Uint8Array {
  return reportWithChart(
    "Sector hours",
    sectorHoursTable(rows),
    standardVsMergedRows(plan),
    STANDARD_VS_MERGED_CHART,
  );
}

// --- 3. Traffic by sector ---------------------------------------------------

/**
 * Which sectors carried the traffic in ONE hour, busiest first.
 *
 * Scoped to an hour because that is what the Sector information panel is about.
 * `entries` is the X-to-Y the question asks for; `aircraft_present` rides along
 * because the two answer different questions and a reader with both in front of
 * them will not mistake one for the other.
 */
export function trafficBySectorRows(
  rows: SectorHourRow[],
  layer: string,
  hourUtc: string,
): Cell[][] {
  const mine = rows
    .filter((r) => r.layer === layer && r.hourUtc === hourUtc)
    .sort((a, b) => b.entries - a.entries || a.sector.localeCompare(b.sector));
  return [
    ["sector", "entries", "aircraft_present", "conflicts", "hour"],
    ...mine.map((r) => [
      r.sector,
      r.entries,
      r.occupancy,
      r.conflictsTotal,
      hourLabel(r.hourUtc),
    ]),
  ];
}

export const TRAFFIC_BY_SECTOR_CHART: ChartSpec = {
  kind: "line",
  title: "Traffic by sector",
  xTitle: "Sector",
  yTitle: "Aircraft",
  catCol: 0,
  valCols: [1, 2],
};

export function trafficBySectorCsv(
  rows: SectorHourRow[],
  layer: string,
  hourUtc: string,
): string {
  return rowsCsv(trafficBySectorRows(rows, layer, hourUtc));
}

export function trafficBySectorXlsx(
  rows: SectorHourRow[],
  layer: string,
  hourUtc: string,
): Uint8Array {
  return reportWithChart(
    "Sector hours",
    sectorHoursTable(rows),
    trafficBySectorRows(rows, layer, hourUtc),
    {
      ...TRAFFIC_BY_SECTOR_CHART,
      title: "Traffic by sector · " + hourLabel(hourUtc) + "Z",
    },
  );
}

// --- 4. Flight trajectory ---------------------------------------------------

/** Most flights to put in one trajectory chart. Excel draws a scatter series
 *  per flight and the legend, not the maths, is what gives out first. */
export const TRAJECTORY_MAX_FLIGHTS = 25;

/**
 * Flight tracks as X/Y pairs, one pair of columns per flight.
 *
 * The layout Excel wants for a scatter chart with several series: each flight
 * gets `lon_<callsign>` and `lat_<callsign>` side by side, and shorter flights
 * simply run out of rows rather than being padded — a padded cell would draw a
 * line back to (0,0), i.e. to the Gulf of Guinea.
 *
 * Points come from the event rows, so the track is the flight's own milestones
 * — takeoff, each filed fix, TOC/TOD, every sector boundary, landing — not a
 * resampled copy of the trajectory. That keeps the file small enough to chart
 * while still following the route.
 */
export function flightTrajectoryRows(
  events: FlightEventRow[],
  maxFlights = TRAJECTORY_MAX_FLIGHTS,
): Cell[][] {
  const byFlight = new Map<string, FlightEventRow[]>();
  for (const e of events) {
    const list = byFlight.get(e.callsign);
    if (list) list.push(e);
    else byFlight.set(e.callsign, [e]);
  }
  const flights = [...byFlight.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, maxFlights)
    .map(
      ([callsign, rows]) =>
        [
          callsign,
          [...rows].sort((a, b) => Date.parse(a.timeUtc) - Date.parse(b.timeUtc)),
        ] as const,
    );

  const header: string[] = [];
  for (const [callsign] of flights) header.push("lon_" + callsign, "lat_" + callsign);

  const depth = flights.reduce((m, [, rows]) => Math.max(m, rows.length), 0);
  const out: Cell[][] = [header];
  for (let i = 0; i < depth; i++) {
    const line: Cell[] = [];
    for (const [, rows] of flights) {
      const p = rows[i];
      line.push(p ? p.lonDeg : "", p ? p.latDeg : "");
    }
    out.push(line);
  }
  return out;
}

/** A trajectory is X/Y geography: a line chart would space the longitudes
 *  evenly and draw a different map. Scatter, joined, is the only honest one. */
export function flightTrajectoryChart(pairCount: number): ChartSpec {
  return {
    kind: "scatter",
    title: "Flight trajectories",
    xTitle: "Longitude (deg E)",
    yTitle: "Latitude (deg N)",
    pairs: Array.from({ length: pairCount }, (_, i) => ({
      xCol: i * 2,
      yCol: i * 2 + 1,
    })),
  };
}

export function flightTrajectoryCsv(
  events: FlightEventRow[],
  maxFlights = TRAJECTORY_MAX_FLIGHTS,
): string {
  return rowsCsv(flightTrajectoryRows(events, maxFlights));
}

export function flightTrajectoryXlsx(
  events: FlightEventRow[],
  maxFlights = TRAJECTORY_MAX_FLIGHTS,
): Uint8Array {
  const series = flightTrajectoryRows(events, maxFlights);
  return reportWithChart(
    "Flight events",
    flightEventsTable(events),
    series,
    flightTrajectoryChart(Math.floor(series[0].length / 2)),
  );
}
