/**
 * The conflict log as a Word report — the file a fast-time study is written
 * from.
 *
 * The CSV next to it is for counting; this one is for reading and handing in:
 * a title, the totals, then one table per outcome so the encounters that still
 * need an answer are on the first page and the history follows. Every number
 * is the one the panel shows, so the report cannot drift from the screen it
 * was saved off.
 *
 * Pure: given the log and a clock formatter it returns the .docx bytes. The
 * panel only saves them.
 */

import {
  buildDocx,
  para,
  table,
  PAGE_WIDTH_TWIPS,
  type TableCell,
} from "@/lib/docx";

import {
  conflictLogCounts,
  type ConflictLogEntry,
  type ConflictOutcome,
} from "./conflictLog";

/** Section order — what still needs an answer leads, exactly as the panel
 *  sorts, with the line under each title saying what the group means. */
const SECTIONS: {
  outcome: ConflictOutcome;
  title: string;
  note: string;
}[] = [
  {
    outcome: "unresolved",
    title: "Unresolved",
    note: "Loss of separation with no instruction issued.",
  },
  {
    outcome: "advisory",
    title: "Advisory",
    note: "Came inside the advisory buffer; the minima were kept and nothing had to be issued.",
  },
  {
    outcome: "resolved",
    title: "Resolved",
    note: "An instruction was issued and the pair was separated.",
  },
  {
    outcome: "cleared",
    title: "Cleared",
    note: "No longer in the plan, but nothing was issued for it — another aircraft's change moved it away.",
  },
];

/** Time · Pair · Encounter · Closest · Minima · What was done. The widths sum
 *  to the text width of the page. */
const COLUMNS = ["Time (UTC)", "Pair", "Encounter", "Closest", "Minima", "What was done"];
const WIDTHS = [1900, 1500, 1300, 1300, 1200, 2438];

const INK = {
  bad: "B71C1C",
  ok: "1B5E20",
  muted: "607D8B",
} as const;

/** The window an encounter occupies, collapsed to the CPA when the two ends
 *  are the same instant (a pass that never held a window open). */
function when(e: ConflictLogEntry, utc: (sec: number) => string): string {
  return e.fromSec === e.toSec
    ? utc(e.tCpaSec)
    : `${utc(e.fromSec)}–${utc(e.toSec)}`;
}

/** The "what was done" cell: the instruction for a resolved pair, otherwise
 *  the reason there is none. */
function action(e: ConflictLogEntry, utc: (sec: number) => string): string {
  if (e.outcome === "resolved" && e.resolution) {
    const r = e.resolution;
    const gain =
      r.beforeNm != null && r.afterNm != null
        ? ` (${r.beforeNm.toFixed(1)} → ${r.afterNm.toFixed(1)} NM)`
        : "";
    const sector = r.sector ? ` [${r.sector}]` : "";
    return `${utc(r.atSec)} ${r.targetCallsign}: ${r.instruction}${gain}${sector}`;
  }
  if (e.outcome === "cleared") return "Nothing issued — removed by another change";
  if (e.outcome === "advisory") return "Nothing issued — minima kept";
  return "NO INSTRUCTION ISSUED";
}

function row(e: ConflictLogEntry, utc: (sec: number) => string): TableCell[] {
  const angle =
    e.crossingDeg != null && e.geometry !== "unknown"
      ? ` ${Math.round(e.crossingDeg)}°`
      : "";
  const tone =
    e.outcome === "unresolved"
      ? { color: INK.bad, bold: true }
      : e.outcome === "resolved"
        ? { color: INK.ok }
        : { color: INK.muted };
  return [
    { text: when(e, utc) },
    { text: `${e.aCallsign} × ${e.bCallsign}`, style: { bold: true } },
    { text: `${e.geometry}${angle}${e.definite ? "" : " (buffer)"}` },
    {
      text: `${e.minHNm.toFixed(1)} NM / ${Math.round(e.minVFt)} ft`,
      style: e.definite ? { color: INK.bad } : undefined,
    },
    { text: `${e.shNm} NM / ${Math.round(e.svFt)} ft`, style: { color: INK.muted } },
    { text: action(e, utc), style: tone },
  ];
}

/**
 * The whole log as a .docx.
 *
 * `generatedAt` is passed in rather than read from the clock so the report is
 * reproducible (and the builder testable).
 */
export function conflictLogDocx(
  log: ConflictLogEntry[],
  utc: (sec: number) => string,
  generatedAt: string,
): Uint8Array {
  const c = conflictLogCounts(log);
  const body: string[] = [
    para("Conflict Log", { style: { bold: true, size: 18 }, spaceAfterPt: 2 }),
    para("ATC Fast-Time Simulation — Conflict Detection & Resolution", {
      style: { size: 10.5, color: INK.muted },
      spaceAfterPt: 1,
    }),
    para(`Generated ${generatedAt}`, {
      style: { size: 9, color: INK.muted },
      spaceAfterPt: 10,
    }),
    para("Summary", { style: { bold: true, size: 12 }, spaceAfterPt: 3, keepNext: true }),
    table(
      [
        [
          { text: "Encounters" },
          { text: "Unresolved" },
          { text: "Resolved" },
          { text: "Advisory" },
          { text: "Cleared" },
        ],
        [
          { text: String(c.total), style: { bold: true } },
          {
            text: String(c.unresolved),
            style: { bold: true, color: c.unresolved > 0 ? INK.bad : INK.ok },
          },
          { text: String(c.resolved), style: { color: INK.ok } },
          { text: String(c.advisory) },
          { text: String(c.cleared) },
        ],
      ],
      // Five even columns across the same text width.
      [1928, 1928, 1928, 1927, 1927],
      { headerRow: true },
    ),
  ];

  if (log.length === 0) {
    body.push(
      para(""),
      para("No conflicts were recorded during this run.", {
        style: { italic: true, color: INK.muted },
      }),
    );
    return buildDocx(body.join(""));
  }

  for (const s of SECTIONS) {
    const rows = log.filter((e) => e.outcome === s.outcome);
    if (rows.length === 0) continue;
    body.push(
      para(""),
      para(`${s.title} (${rows.length})`, {
        style: { bold: true, size: 12 },
        spaceAfterPt: 1,
        keepNext: true,
      }),
      para(s.note, {
        style: { size: 8.5, color: INK.muted, italic: true },
        spaceAfterPt: 3,
        keepNext: true,
      }),
      table(
        [COLUMNS.map((text) => ({ text })), ...rows.map((e) => row(e, utc))],
        WIDTHS,
        { headerRow: true },
      ),
    );
  }
  return buildDocx(body.join(""));
}

/** Exported for the tests that check the table spans the page exactly. */
export const REPORT_TABLE_WIDTH = PAGE_WIDTH_TWIPS;
