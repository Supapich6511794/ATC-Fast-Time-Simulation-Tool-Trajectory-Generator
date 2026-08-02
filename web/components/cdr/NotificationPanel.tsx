"use client";

/**
 * NotificationPanel — the realtime conflict-alert STACK.
 *
 * Distinct from the strategic Dashboard: this lists the LIVE conflicts the
 * detector currently sees within its look-ahead (LOS → STCA → MTCD). Entries
 * appear, escalate and clear as the geometry evolves.
 *
 * REALTIME only — it shows the LIVE conflicts and nothing else. A live conflict
 * that gets fixed is marked "✓ Fixed" (and locked — no re-fix) while it is still
 * clearing, then simply drops off as it leaves the look-ahead. It does NOT keep
 * a persistent "Fixed" history — that lives in the Dashboard. A conflict fixed
 * before it ever alerted (from the Dashboard, while still far away) never
 * appears here at all.
 */

import type { ReactNode } from "react";

import { SEVERITY_LABEL, fmtCountdown, fmtNm } from "@/lib/cdr/format";
import type { TrackedConflict } from "@/lib/cdr/lifecycle";
import type { AppliedFix, Severity } from "@/lib/cdr/types";

interface Props {
  conflicts: TrackedConflict[];
  nameOf: (id: string) => string;
  /** Selecting a conflict expands its inline resolution cards (Preview/Apply). */
  selectedId: string | null;
  onSelect: (conflictId: string | null) => void;
  onClose: () => void;
  /** Applied-fix log (shared with the Dashboard) — drives the ✓ Fixed state. */
  appliedFixes: AppliedFix[];
  /** Inline resolution cards for the selected conflict (Preview = dashed path on
   *  the main map, Apply = commit) — the same flow as before, no popup. */
  renderAdvisory?: (conflictId: string) => ReactNode;
}

const SEV_SHORT: Record<Severity, string> = { LOS: "LOS", STCA: "STCA", MTCD: "MTCD" };
const SEV_ICON: Record<Severity, string> = { LOS: "⛔", STCA: "⚠", MTCD: "◆" };

export default function NotificationPanel({
  conflicts,
  nameOf,
  selectedId,
  onSelect,
  onClose,
  appliedFixes,
  renderAdvisory,
}: Props) {
  const fixedById = new Map(appliedFixes.map((f) => [f.conflictId, f]));
  const unresolved = conflicts.filter((c) => !fixedById.has(c.id)).length;

  return (
    <div className="cdr-panel cdr-notif" role="dialog" aria-label="Conflict notifications">
      <div className="cdr-panel-head">
        <strong>🔔 Conflict notifications ({unresolved})</strong>
        <button type="button" className="cdr-panel-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <div className="cdr-panel-body">
        {conflicts.length === 0 ? (
          <p className="cdr-panel-empty">
            No active alerts. Live conflicts within the look-ahead appear here as
            they arise, escalate and clear.
          </p>
        ) : (
          <ul className="cdr-list">
            {conflicts.map((c) => {
              const fix = fixedById.get(c.id);
              const selected = !fix && c.id === selectedId;
              return (
                <li
                  key={c.id}
                  className={`cdr-row sev-${c.severity.toLowerCase()}${
                    fix ? " fixed" : ""
                  }${selected ? " selected" : ""}${
                    fix || c.clearTicks > 0 ? " clearing" : ""
                  }`}
                >
                  <button
                    type="button"
                    className="cdr-row-head"
                    // A fixed conflict is locked — no re-fix offered.
                    onClick={() => !fix && onSelect(selected ? null : c.id)}
                    aria-expanded={selected}
                    disabled={!!fix}
                    title={fix ? "Resolution applied" : SEVERITY_LABEL[c.severity]}
                  >
                    {fix ? (
                      // Resolved by an applied fix — show it as CLEARED, never as
                      // a red loss chip (the pair is handled; it lingers only for
                      // a brief confirmation before dropping off the realtime list).
                      <span className="cdr-chip fixed">
                        <span aria-hidden>✓</span> FIXED
                      </span>
                    ) : (
                      <span className={`cdr-chip sev-${c.severity.toLowerCase()}`}>
                        <span aria-hidden>{SEV_ICON[c.severity]}</span>{" "}
                        {SEV_SHORT[c.severity]}
                      </span>
                    )}
                    <span className="cdr-row-pair">
                      {nameOf(c.a)} <span className="cdr-row-x">↔</span> {nameOf(c.b)}
                    </span>
                    {fix ? (
                      <span className="cdr-row-cd cdr-clearing">resolved</span>
                    ) : (
                      <span className="cdr-row-cd">
                        {c.severity === "LOS" ? "now" : fmtCountdown(c.tToLosSec)}
                      </span>
                    )}
                  </button>
                  <div className="cdr-notif-sub">
                    {fix ? (
                      <>
                        {nameOf(fix.target)} · {fix.instruction}
                      </>
                    ) : (
                      <>
                        CPA {fmtNm(c.dCpa)}
                        {c.clearTicks > 0 && <em className="cdr-clearing"> · clearing…</em>}
                      </>
                    )}
                  </div>
                  {selected && <div className="cdr-detail">{renderAdvisory?.(c.id)}</div>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
