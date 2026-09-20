/**
 * Which tab of the PDR panel a flight belongs on.
 *
 * The panel's own vocabulary, kept in one place so the list, the tab counts and
 * the per-row chip cannot disagree about a flight:
 *
 *   * rejected — the plan breaches a published restriction and cannot be filed
 *                as it stands (some finding is a violation);
 *   * check    — something to look at, but nothing outright forbidden (only
 *                cautions);
 *   * clear    — nothing to act on. Info-level notes do NOT count: they are
 *                context, and a flight carrying only them has passed;
 *   * pending  — the scan has not reached the flight yet. It has NO verdict and
 *                must not be shown as clear — an unchecked flight used to fall
 *                through to "clear", which made it indistinguishable from one
 *                that had passed.
 */

import type { PdrReport } from "@/lib/pdr/detect";

export type PdrVerdict = "clear" | "check" | "rejected" | "pending";

export function pdrVerdict(report: PdrReport | undefined): PdrVerdict {
  if (!report) return "pending";
  let check = false;
  for (const f of report.findings) {
    if (f.severity === "violation") return "rejected";
    if (f.severity === "caution") check = true;
  }
  return check ? "check" : "clear";
}

/** The tabs, in display order. "all" is every flight, pending ones included. */
export type PdrTab = "all" | "clear" | "check" | "rejected";

export const PDR_TABS: readonly { id: PdrTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "clear", label: "Clear" },
  { id: "check", label: "Check" },
  { id: "rejected", label: "Rejected" },
];

/** How many flights each tab holds. A pending flight is in "all" only. */
export function pdrTabCounts(
  verdicts: readonly PdrVerdict[],
): Record<PdrTab, number> {
  const n: Record<PdrTab, number> = { all: verdicts.length, clear: 0, check: 0, rejected: 0 };
  for (const v of verdicts) if (v !== "pending") n[v] += 1;
  return n;
}

export function inPdrTab(verdict: PdrVerdict, tab: PdrTab): boolean {
  return tab === "all" || verdict === tab;
}
