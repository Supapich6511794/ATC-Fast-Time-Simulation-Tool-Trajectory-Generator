/**
 * The contract between the console tab and a report tab.
 *
 * A run report is built in the browser, out of trajectories, airspace polygons
 * and a conflict log that only the console tab holds — there is no URL that
 * describes one, and no server that could render it. So the report tab is
 * opened empty and the console hands it the finished tables over
 * `postMessage`.
 *
 * Two things make that awkward, and both are handled here rather than in the
 * components:
 *
 *   * **The window has to be opened before the data exists.** `window.open`
 *     only counts as user-initiated inside the click that caused it; open it
 *     after `await buildReportData(...)` and the pop-up blocker eats it. So the
 *     console opens the tab immediately and posts later, and the tab shows a
 *     "building" state in between.
 *
 *   * **Neither side knows which is ready first.** The tab may mount before the
 *     console has built anything, or long after it finished. The tab therefore
 *     KEEPS SAYING HELLO until it is answered, and the console answers any
 *     hello whose nonce it has a payload for. No ordering assumption, and a
 *     console that was reloaded in the meantime simply never answers — which
 *     the tab reports rather than hanging.
 *
 * The nonce ties a tab to the report that opened it: two report tabs from the
 * same console must not be handed each other's tables.
 */

import type { Cell, ChartSpec } from "./xlsx";

/** Which run-level report a tab is showing. Mirrors DownloadModal's own. */
export type ReportViewKind = "events" | "sectors" | "dynamic";

/**
 * What the tab draws: the report's headline chart, and nothing else.
 *
 * The tables are deliberately not in here. The tab is for LOOKING at the run,
 * the .csv / .xlsx in the Download dialog are for the rows, and a flight-events
 * table over a traffic day is 60,000+ rows that the console would have to
 * build, clone across to this tab and index — all to sit under a chart that is
 * the reason anyone opened it.
 */
export interface ReportPayload {
  kind: ReportViewKind;
  /** Heading, and the browser tab's title. */
  title: string;
  /** One line under the heading: what run this is, and how big. */
  subtitle: string;
  /** The headline chart's series, header row first, already in axis order. */
  series: Cell[][];
  /** How to draw them — the SAME spec the .xlsx chart is built from, so the
   *  picture on screen and the picture in the workbook cannot drift apart. */
  spec: ChartSpec;
}

/** Tab → console: "I am up, send me the report for this nonce." */
export interface ReportHello {
  channel: typeof REPORT_CHANNEL;
  type: "hello";
  nonce: string;
}

/** Console → tab: the report, or the reason there isn't one. */
export interface ReportDelivery {
  channel: typeof REPORT_CHANNEL;
  type: "payload" | "error";
  nonce: string;
  payload?: ReportPayload;
  error?: string;
}

export const REPORT_CHANNEL = "ftg-report" as const;

/** How often the tab re-asks, and how long it keeps asking. A report over a
 *  whole traffic day is a few seconds of work, so the window has to be
 *  generous; past it, the console is gone rather than slow. */
export const HELLO_EVERY_MS = 400;
export const HELLO_GIVE_UP_MS = 120_000;

export function isHello(d: unknown): d is ReportHello {
  const m = d as ReportHello | null;
  return (
    !!m && m.channel === REPORT_CHANNEL && m.type === "hello" && typeof m.nonce === "string"
  );
}

export function isDelivery(d: unknown, nonce: string): d is ReportDelivery {
  const m = d as ReportDelivery | null;
  return (
    !!m &&
    m.channel === REPORT_CHANNEL &&
    (m.type === "payload" || m.type === "error") &&
    m.nonce === nonce
  );
}

/** A nonce that is unique per opened tab without needing a counter shared
 *  across them. `crypto.randomUUID` is not on older Safari, hence the fallback. */
export function newNonce(): string {
  const c = globalThis.crypto;
  if (c && "randomUUID" in c) return c.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * The URL a report tab is opened at.
 *
 * The kind is in the query only so the tab can title itself before the tables
 * arrive — the payload is what it draws. The theme is there for the same
 * reason and matters more: the tab renders a "building…" card first, and a
 * white flash before a dark report is the sort of thing that looks like a bug.
 */
export function reportUrl(
  kind: ReportViewKind,
  nonce: string,
  theme: "dark" | "light",
): string {
  return (
    `/report?kind=${encodeURIComponent(kind)}` +
    `&n=${encodeURIComponent(nonce)}&theme=${theme}`
  );
}
