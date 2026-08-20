"use client";

/**
 * ConflictPanel — the strategic Conflict Dashboard.
 *
 * Distinct from the realtime NotificationPanel: this is the whole-plan picture,
 * laid out in two columns like a controller's board:
 *
 *   ⛔ LOSS OF SEPARATION            ✓ FIXED
 *   every loss the filed plans       every conflict a resolution
 *   will produce across the whole    has been applied to (with the
 *   timeline — including future       maneuver used)
 *   ones that haven't alerted yet
 *
 * Clicking a loss row opens the before/after Preview & fix modal; clicking a
 * fixed row draws that fix's old and new routes on the map.
 */

import { fmtCountdown, fmtNm } from "@/lib/cdr/format";
import type { PlanConflict } from "@/lib/cdr/planScan";
import type { ConflictSector } from "@/lib/cdr/sector";
import type { AppliedFix } from "@/lib/cdr/types";

import SectorChip from "./SectorChip";

interface Props {
  planConflicts: PlanConflict[];
  /** Current absolute sim clock (s) for the countdowns. */
  simT: number;
  nameOf: (id: string) => string;
  appliedFixes: AppliedFix[];
  onClearFixes?: () => void;
  /** Open the before/after preview + fix modal for a conflict. */
  onOpenPreview: (conflictId: string) => void;
  /** Show a ✓ Fixed entry's before/after routes on the map. Omitted = the rows
   *  stay static (no click target). */
  onSelectFix?: (conflictId: string) => void;
  /** The fix currently drawn on the map, so its row reads as active. */
  selectedFixId?: string | null;
  /** The ATS unit responsible for a conflict — which sector has to work it. */
  sectorOf?: (c: PlanConflict) => ConflictSector | null;
  onClose: () => void;
}

export default function ConflictPanel({
  planConflicts,
  simT,
  nameOf,
  appliedFixes,
  onClearFixes,
  onOpenPreview,
  onSelectFix,
  selectedFixId,
  sectorOf,
  onClose,
}: Props) {
  // An APPLIED fix is authoritative: the pair is treated as resolved and shown
  // ONLY under ✓ Fixed — never under Loss of separation — even if the geometry
  // still trips the detector (e.g. a maneuver that reduces but doesn't fully
  // clear the CPA). This keeps the dashboard consistent with the realtime
  // notifications: fix it once, it's fixed everywhere.
  const fixedIds = new Set(appliedFixes.map((f) => f.conflictId));
  const fixedDone = appliedFixes;
  const definite = planConflicts.filter((c) => c.definite && !fixedIds.has(c.id));

  const lossRow = (c: PlanConflict) => {
    const targetAbs = c.losStartAbsSec ?? c.tCpaAbsSec;
    const rel = targetAbs - simT;
    const cpaRel = c.tCpaAbsSec - simT;
    const state = rel <= 0 && cpaRel >= -30 ? "now" : cpaRel < 0 ? "past" : "future";
    return (
      <li key={c.id} className={`cdr-row sev-los${state === "past" ? " past" : ""}`}>
        <button
          type="button"
          className="cdr-row-head"
          onClick={() => onOpenPreview(c.id)}
          title={`d_CPA ${fmtNm(c.dCpaNm)} — click to preview & fix`}
        >
          <span className="cdr-chip sev-los">LOS</span>
          <span className="cdr-row-pair">
            {nameOf(c.a)} <span className="cdr-row-x">↔</span> {nameOf(c.b)}
          </span>
          <span className="cdr-row-cd">
            {state === "now" ? "now" : state === "past" ? "passed" : fmtCountdown(rel)}
          </span>
        </button>
        <div className="cdr-fix-sub">
          <SectorChip sector={sectorOf?.(c)} ids={c} nameOf={nameOf} />
        </div>
      </li>
    );
  };

  return (
    <div className="cdr-panel cdr-dashboard" role="dialog" aria-label="Conflict dashboard">
      <div className="cdr-panel-head">
        <strong>⚡ Conflict Dashboard</strong>
        <button type="button" className="cdr-panel-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <div className="cdr-dash-cols">
        {/* Left: strategic losses of separation across the whole plan. */}
        <section className="cdr-dash-col los">
          <h3 className="cdr-dash-h">⛔ Loss of separation ({definite.length})</h3>
          {definite.length === 0 ? (
            <p className="cdr-panel-empty">No losses of separation in the filed plans.</p>
          ) : (
            <ul className="cdr-list">{definite.map(lossRow)}</ul>
          )}
        </section>

        {/* Right: everything a resolution has been applied to. */}
        <section className="cdr-dash-col fixed">
          <h3 className="cdr-dash-h">
            ✓ Fixed ({fixedDone.length})
            {onClearFixes && fixedDone.length > 0 && (
              <button type="button" className="cdr-section-clear" onClick={onClearFixes}>
                Clear
              </button>
            )}
          </h3>
          {fixedDone.length === 0 ? (
            <p className="cdr-panel-empty">Nothing fixed yet.</p>
          ) : (
            <ul className="cdr-list">
              {fixedDone.map((f) => {
                const pair = (
                  <>
                    <span className="cdr-chip fixed">✓</span>
                    <span className="cdr-row-pair">
                      {nameOf(f.a)} <span className="cdr-row-x">↔</span> {nameOf(f.b)}
                    </span>
                  </>
                );
                const active = selectedFixId === f.conflictId;
                return (
                  <li
                    key={f.conflictId}
                    className={`cdr-row fixed-row${active ? " selected" : ""}`}
                  >
                    {onSelectFix ? (
                      <button
                        type="button"
                        className="cdr-row-head"
                        onClick={() => onSelectFix(f.conflictId)}
                        aria-pressed={active}
                        title="Show the old and new routes on the map"
                      >
                        {pair}
                        <span className="cdr-row-cd">{active ? "shown" : "show"}</span>
                      </button>
                    ) : (
                      <div className="cdr-row-head static">{pair}</div>
                    )}
                    <div className="cdr-fix-sub">
                      {nameOf(f.target)} · {f.instruction}
                      {f.sector && (
                        <span
                          className="cdr-sector"
                          title={`Issued in ${f.sector}${
                            f.sectorCoordination
                              ? " — coordinated across a unit boundary"
                              : ""
                          }`}
                        >
                          {f.sector}
                          {f.sectorCoordination ? " ·coord" : ""}
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
