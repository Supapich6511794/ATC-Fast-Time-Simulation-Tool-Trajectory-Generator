/**
 * Dynamic sectorization — how many controller positions the traffic actually
 * needs, hour by hour.
 *
 * A published sector map is sized for the busy hour. At 0300Z the same map has
 * a controller sitting in front of two aircraft. Real ACCs band-box: adjacent
 * sectors are worked from one position while it is quiet, and split back when
 * the traffic returns. This module works out where that would have happened in
 * a run, and says so as an operational plan.
 *
 * What it is NOT
 * --------------
 * It does not touch the airspace. The published sectors in
 * `public/data/sectors_corrected` are the baseline and stay the baseline: every
 * result here is expressed as *groupings of* those sectors, every group can be
 * read back to its members, and nothing is written anywhere. A merged position
 * is a staffing decision — who works which airspace this hour — not a new
 * volume. The report says so in as many words, because a table of "sector A+B"
 * is otherwise easy to mistake for a redrawn map.
 *
 * Where the numbers come from
 * ---------------------------
 * `buildSectorHours` — the same table the sector-hour report and the Sector
 * information panel read, built from the same flight events. There is no second
 * traffic count here and there must not be one: two counters drift, and then
 * the tool argues with itself about how busy a sector was. This module consumes
 * `SectorHourRow.occupancy` (aircraft PRESENT in the hour, not just crossings
 * in) and adds only the grouping decision on top.
 *
 * The rule
 * --------
 * Greedy, adjacency-constrained, deterministic:
 *
 *   1. Every published sector of the layer starts as its own position, carrying
 *      its own traffic — including sectors with no traffic at all, which is
 *      exactly the case band-boxing exists for.
 *   2. Repeatedly merge the two ADJACENT positions whose combined traffic is
 *      smallest, so long as that combined traffic stays under `mergeBelow` and
 *      the position would not exceed `maxSectorsPerPosition`.
 *   3. Stop when no pair qualifies.
 *
 * A sector already at or above the threshold can never merge: its own traffic
 * alone fails the combined test. That falls out of the rule rather than being a
 * special case, which is why the rule is stated as a ceiling on the RESULT — a
 * position is judged by what one controller ends up holding, not by how quiet
 * the pieces were separately.
 */

import type { SectorHourRow } from "./flightEvents";
import type { SectorAdjacency } from "./sectorAdjacency";
import { sectorsOf } from "./sectorAdjacency";

export interface DynamicSectorConfig {
  /** Which airspace layer to plan. Only one layer is ever merged at a time: a
   *  TMA and an en-route sector are different jobs, not two halves of one. */
  layer: string;
  /** A position may be formed while its COMBINED traffic stays under this many
   *  aircraft in the hour. The operational knob. */
  mergeBelow: number;
  /** Most published sectors one position may hold. Three is already a wide
   *  band-box; the cap keeps a quiet night from collapsing a whole FIR onto one
   *  controller, which no ACC would do however low the count. */
  maxSectorsPerPosition: number;
}

export const DEFAULT_DYNAMIC_CONFIG: DynamicSectorConfig = {
  layer: "bacc",
  mergeBelow: 6,
  maxSectorsPerPosition: 3,
};

/** One controller position for one hour: the sectors worked together, and the
 *  traffic that put them there. */
export interface DynamicPosition {
  /** Published sectors worked as one, sorted. */
  sectors: string[];
  /** "1N+1S" for a band-box, "1N" for a sector worked on its own. */
  label: string;
  /** Distinct aircraft in the position over the hour. Not the sum of the member
   *  counts: an aircraft that crosses from one member to another is one
   *  aircraft to the controller who now holds both. */
  flights: number;
  /** What each member contributed, in the group's own order. */
  members: { sector: string; flights: number }[];
  merged: boolean;
}

export interface DynamicHour {
  hourUtc: string;
  layer: string;
  positions: DynamicPosition[];
  /** Published sectors considered — the baseline this hour is measured against. */
  baselineSectors: number;
  /** Positions actually opened. `baselineSectors - positionsOpen` is the saving. */
  positionsOpen: number;
  /** Sectors that were in a band-box last hour and are worked on their own now:
   *  the split-back, which is the half of the story a merge table usually
   *  leaves out. */
  splitBack: string[];
}

/** A band-box that held together across consecutive hours. The report reads
 *  from these: a merge is an operational period, not an isolated hour. */
export interface DynamicSpan {
  label: string;
  sectors: string[];
  /** First hour of the band-box, and the first hour it was NO LONGER in force
   *  (exclusive), so `fromHourUtc` .. `toHourUtc` reads as a period. */
  fromHourUtc: string;
  toHourUtc: string;
  hours: number;
  /** Busiest hour the merged position saw — the headroom that was left. */
  peakFlights: number;
  /** Why it ended. `traffic` is the one that matters: the count reached the
   *  threshold and the sectors were split back. */
  endedBy: "traffic" | "regrouped" | "end-of-run";
}

export interface DynamicPlan {
  config: DynamicSectorConfig;
  hours: DynamicHour[];
  spans: DynamicSpan[];
  /** Published sectors of this layer, the baseline the plan never alters. */
  baseline: string[];
}

const labelOf = (sectors: string[]) => sectors.join("+");

interface Group {
  sectors: string[];
  /** Distinct callsigns across the members. */
  flights: Set<string>;
}

/** Traffic for one sector in one hour: aircraft present, and which. */
function trafficOf(row: SectorHourRow | undefined): string[] {
  return row ? row.occupancyFlights : [];
}

/**
 * Group one hour's sectors into positions.
 *
 * Exported for the tests, and because the hour is the unit a controller thinks
 * in — the whole-run plan is just this, repeated.
 */
export function planHour(
  hourUtc: string,
  rowsBySector: Map<string, SectorHourRow>,
  adjacency: SectorAdjacency,
  config: DynamicSectorConfig,
): Omit<DynamicHour, "splitBack"> {
  const baseline = sectorsOf(adjacency);
  const groups: Group[] = baseline.map((s) => ({
    sectors: [s],
    flights: new Set(trafficOf(rowsBySector.get(s))),
  }));

  const adjacent = (a: Group, b: Group) =>
    a.sectors.some((x) => b.sectors.some((y) => adjacency.get(x)?.has(y)));

  for (;;) {
    let best: { i: number; j: number; flights: number; label: string } | null = null;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const a = groups[i];
        const b = groups[j];
        if (a.sectors.length + b.sectors.length > config.maxSectorsPerPosition) continue;
        if (!adjacent(a, b)) continue;
        const union = new Set([...a.flights, ...b.flights]);
        if (union.size >= config.mergeBelow) continue;
        const label = labelOf([...a.sectors, ...b.sectors].sort());
        // Smallest combined position first; the label breaks ties so the same
        // traffic always yields the same plan. A plan that shuffles between
        // runs cannot be checked against anything.
        if (
          !best ||
          union.size < best.flights ||
          (union.size === best.flights && label < best.label)
        ) {
          best = { i, j, flights: union.size, label };
        }
      }
    }
    if (!best) break;
    const a = groups[best.i];
    const b = groups[best.j];
    groups.splice(best.j, 1);
    groups.splice(best.i, 1);
    groups.push({
      sectors: [...a.sectors, ...b.sectors].sort(),
      flights: new Set([...a.flights, ...b.flights]),
    });
  }

  const positions: DynamicPosition[] = groups
    .map((g) => ({
      sectors: g.sectors,
      label: labelOf(g.sectors),
      flights: g.flights.size,
      members: g.sectors.map((s) => ({
        sector: s,
        flights: trafficOf(rowsBySector.get(s)).length,
      })),
      merged: g.sectors.length > 1,
    }))
    .sort((x, y) => x.label.localeCompare(y.label));

  return {
    hourUtc,
    layer: config.layer,
    positions,
    baselineSectors: baseline.length,
    positionsOpen: positions.length,
  };
}

/**
 * Plan the whole run: one grouping per hour, plus the periods each band-box
 * held for.
 *
 * `rows` is the sector-hour table for the WHOLE run; rows of other layers are
 * ignored rather than rejected, so the caller can hand over the table it
 * already has.
 */
export function planDynamicSectors(
  rows: SectorHourRow[],
  adjacency: SectorAdjacency,
  config: DynamicSectorConfig = DEFAULT_DYNAMIC_CONFIG,
): DynamicPlan {
  const baseline = sectorsOf(adjacency);
  const mine = rows.filter((r) => r.layer === config.layer);
  const hoursUtc = [...new Set(mine.map((r) => r.hourUtc))].sort();

  const byHour = new Map<string, Map<string, SectorHourRow>>();
  for (const r of mine) {
    const m = byHour.get(r.hourUtc) ?? new Map<string, SectorHourRow>();
    m.set(r.sector, r);
    byHour.set(r.hourUtc, m);
  }

  const hours: DynamicHour[] = [];
  let previouslyMerged = new Set<string>();
  for (const hourUtc of hoursUtc) {
    const planned = planHour(
      hourUtc,
      byHour.get(hourUtc) ?? new Map(),
      adjacency,
      config,
    );
    const mergedNow = new Set<string>();
    for (const p of planned.positions) {
      if (p.merged) for (const s of p.sectors) mergedNow.add(s);
    }
    const splitBack = [...previouslyMerged].filter((s) => !mergedNow.has(s)).sort();
    hours.push({ ...planned, splitBack });
    previouslyMerged = mergedNow;
  }

  return { config, hours, spans: buildSpans(hours), baseline };
}

/** Collapse the per-hour groupings into the periods each band-box held for. */
function buildSpans(hours: DynamicHour[]): DynamicSpan[] {
  const spans: DynamicSpan[] = [];
  const open = new Map<string, { span: DynamicSpan; index: number }>();

  const close = (
    key: string,
    entry: { span: DynamicSpan; index: number },
    toHourUtc: string,
    endedBy: DynamicSpan["endedBy"],
  ) => {
    entry.span.toHourUtc = toHourUtc;
    entry.span.endedBy = endedBy;
    spans.push(entry.span);
    open.delete(key);
  };

  hours.forEach((h, i) => {
    const merged = new Map(h.positions.filter((p) => p.merged).map((p) => [p.label, p]));
    // Band-boxes that did not survive into this hour.
    for (const [key, entry] of [...open]) {
      if (merged.has(key)) continue;
      // Split because the traffic rose, or re-grouped with a different
      // neighbour? Both end the span, and they are not the same event.
      const sectors = new Set(entry.span.sectors);
      const stillMergedElsewhere = h.positions.some(
        (p) => p.merged && p.sectors.some((s) => sectors.has(s)),
      );
      close(key, entry, h.hourUtc, stillMergedElsewhere ? "regrouped" : "traffic");
    }
    for (const [key, pos] of merged) {
      const entry = open.get(key);
      if (entry) {
        entry.span.hours = i - entry.index + 1;
        entry.span.peakFlights = Math.max(entry.span.peakFlights, pos.flights);
      } else {
        open.set(key, {
          index: i,
          span: {
            label: pos.label,
            sectors: [...pos.sectors],
            fromHourUtc: h.hourUtc,
            toHourUtc: h.hourUtc,
            hours: 1,
            peakFlights: pos.flights,
            endedBy: "end-of-run",
          },
        });
      }
    }
  });

  // Whatever is still band-boxed when the sample stops was not split back — the
  // run ended, which is a different statement from "the traffic stayed low".
  const last = hours.at(-1);
  for (const [key, entry] of [...open]) {
    close(key, entry, last ? nextHour(last.hourUtc) : entry.span.toHourUtc, "end-of-run");
  }

  return spans.sort(
    (a, b) => a.fromHourUtc.localeCompare(b.fromHourUtc) || a.label.localeCompare(b.label),
  );
}

function nextHour(hourUtc: string): string {
  const ms = Date.parse(hourUtc);
  return Number.isFinite(ms)
    ? new Date(ms + 3600000).toISOString().slice(0, 13) + ":00Z"
    : hourUtc;
}

// --- saying it in words -----------------------------------------------------

/** "1N: 2 flights + 1S: 3 flights → merged as 1N+1S" — the merge, in the form a
 *  watch supervisor would write it. */
export function describePosition(p: DynamicPosition): string {
  const parts = p.members.map((m) => m.sector + ": " + m.flights + " flight" + (m.flights === 1 ? "" : "s"));
  if (!p.merged) return parts[0] + " → worked on its own";
  return parts.join(" + ") + " → merged as " + p.label + " (" + p.flights + " total)";
}

/** "0000-0100 UTC" for one hour bucket. */
export function hourRangeLabel(hourUtc: string): string {
  const start = Date.parse(hourUtc);
  if (!Number.isFinite(start)) return hourUtc;
  const hh = (ms: number) => new Date(ms).toISOString().slice(11, 16).replace(":", "");
  return hh(start) + "-" + hh(start + 3600000) + " UTC";
}

/** "07 Sep 0000-0300 UTC (3 h)" for a whole band-box period. */
export function spanLabel(s: DynamicSpan): string {
  const day = new Date(Date.parse(s.fromHourUtc)).toUTCString().slice(5, 11);
  const hhmm = (t: string) => new Date(Date.parse(t)).toISOString().slice(11, 16).replace(":", "");
  return (
    day +
    " " +
    hhmm(s.fromHourUtc) +
    "-" +
    hhmm(s.toHourUtc) +
    " UTC (" +
    s.hours +
    " h)"
  );
}

// --- CSV --------------------------------------------------------------------

function csvField(v: string | number): string {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function csv(header: string[], rows: (string | number)[][]): string {
  return (
    "﻿" +
    [header, ...rows].map((r) => r.map(csvField).join(",")).join("\r\n") +
    "\r\n"
  );
}

/**
 * The plan as a flat table: one row per published sector per hour.
 *
 * Every row names the sector it is about AND the position it was worked from,
 * so the file can be read either way round — "what happened to 1N all day", or
 * "what did the 1N+1S position hold at 0300". `basis` repeats on every row that
 * this is an operational grouping over an unchanged sector map, because a
 * column called `position` is otherwise one screenshot away from being read as
 * a new airspace design.
 */
export function dynamicSectorsTable(plan: DynamicPlan): (string | number)[][] {
  const rows: (string | number)[][] = [];
  for (const h of plan.hours) {
    const splitBack = new Set(h.splitBack);
    for (const p of h.positions) {
      for (const m of p.members) {
        rows.push([
          h.hourUtc,
          hourRangeLabel(h.hourUtc),
          h.layer,
          m.sector,
          m.flights,
          p.label,
          p.sectors.length,
          p.flights,
          p.merged ? "MERGED" : splitBack.has(m.sector) ? "SPLIT_BACK" : "STANDALONE",
          plan.config.mergeBelow,
          h.baselineSectors,
          h.positionsOpen,
          h.baselineSectors - h.positionsOpen,
          "dynamic operational configuration - published sectors unchanged",
        ]);
      }
    }
  }
  return [DYNAMIC_HEADER, ...rows];
}

const DYNAMIC_HEADER = [
  "hour_utc",
  "hour",
  "layer",
  "sector",
  "sector_flights",
  "position",
  "position_sectors",
  "position_flights",
  "status",
  "merge_below",
  "baseline_sectors",
  "positions_open",
  "positions_saved",
  "basis",
];

export function dynamicSectorsCsv(plan: DynamicPlan): string {
  const [head, ...body] = dynamicSectorsTable(plan);
  return csv(head as string[], body);
}

/** The band-box periods on their own — the "when was this in force" table. */
export function dynamicSpansCsv(plan: DynamicPlan): string {
  return csv(
    [
      "position",
      "sectors",
      "from_hour_utc",
      "to_hour_utc",
      "hours",
      "peak_flights",
      "merge_below",
      "ended_by",
    ],
    plan.spans.map((s) => [
      s.label,
      s.sectors.join(" "),
      s.fromHourUtc,
      s.toHourUtc,
      s.hours,
      s.peakFlights,
      plan.config.mergeBelow,
      s.endedBy,
    ]),
  );
}
