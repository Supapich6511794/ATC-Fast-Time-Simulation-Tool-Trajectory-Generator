"use client";

/**
 * Conflicts menu — everything that answers "is this plan safe to fly".
 *
 * Moved verbatim from the map's Conflict Detection dropdown, with the
 * departure-conflict check folded in (it used to be a separate chip because it
 * comes out of the PLANS rather than the traffic, and had to be reachable
 * before anything was generated — under one tab that distinction is a row, not
 * a second button).
 *
 * Two neighbours are deliberately NOT here. Arrival sequencing has its own
 * tab, being about the landing order rather than about separation; sector
 * information and dynamic sectorisation have the Sector tab, being about the
 * workload the airspace carries rather than about whether a plan is safe.
 */

import { memo } from "react";

import NavIcon from "@/components/nav/NavIcon";
import type {
  AutoModeOption,
  AutoResolveMode,
  CdrView,
} from "@/components/nav/types";

export interface ConflictsMenuProps {
  cdrView: CdrView;
  onOpenView: (v: CdrView) => void;
  /** Live monitoring only runs in "all routes" playback. */
  monitoring: boolean;
  unresolvedCount: number;
  logCount: number;
  pdrActionable: number;
  /** Departure conflicts come from the filed plans, not from the replay. */
  depConflictCount: number;
  depPanelOpen: boolean;
  onOpenDepartures: () => void;
  autoResolve: boolean;
  autoResolveMode: AutoResolveMode;
  autoModeOptions: readonly AutoModeOption[];
  onAutoResolveMode: (mode: AutoResolveMode) => void;
  /** Re-run the up-front pass when "Before replay" is picked again. */
  onRerunAutoPass: () => void;
  autoPass: { fixed: number; unfixed: number; done: boolean } | null;
  /** Fired after a view is picked, so the bar can close the dropdown. */
  onPicked: () => void;
}

function ConflictsMenu({
  cdrView,
  onOpenView,
  monitoring,
  unresolvedCount,
  logCount,
  pdrActionable,
  depConflictCount,
  depPanelOpen,
  onOpenDepartures,
  autoResolve,
  autoResolveMode,
  autoModeOptions,
  onAutoResolveMode,
  onRerunAutoPass,
  autoPass,
  onPicked,
}: ConflictsMenuProps) {
  const pick = (v: CdrView) => {
    onOpenView(v);
    onPicked();
  };

  return (
    <div className="cdr-menu cdr-menu-flat">
      <button
        type="button"
        role="menuitem"
        className={cdrView === "notifications" ? "active" : ""}
        onClick={() => pick("notifications")}
      >
        <NavIcon name="bell" size={15} />
        Conflict notifications
        {monitoring && unresolvedCount > 0 && (
          <span className="cdr-menu-count">{unresolvedCount}</span>
        )}
      </button>
      <button
        type="button"
        role="menuitem"
        className={cdrView === "dashboard" ? "active" : ""}
        onClick={() => pick("dashboard")}
      >
        <NavIcon name="conflicts" size={15} />
        Conflict dashboard
      </button>
      <button
        type="button"
        role="menuitem"
        className={cdrView === "log" ? "active" : ""}
        onClick={() => pick("log")}
        title="Every encounter of the run: when, who, what kind, and what resolved it"
      >
        <NavIcon name="log" size={15} />
        Conflict log
        {logCount > 0 && <span className="cdr-menu-count">{logCount}</span>}
      </button>
      {/* Departure conflicts come out of the PLANS, so this row works before
          anything has been generated — unlike the rows above it, which need
          traffic on the clock. */}
      <button
        type="button"
        role="menuitem"
        className={depPanelOpen ? "active" : ""}
        disabled={depConflictCount === 0}
        onClick={() => {
          onOpenDepartures();
          onPicked();
        }}
        title={
          depConflictCount === 0
            ? "No filed departure can't be cleared as it stands"
            : `${depConflictCount} filed departures cannot be cleared as they stand`
        }
      >
        <NavIcon name="departure" size={15} />
        Departure conflict
        {depConflictCount > 0 && (
          <span className="cdr-menu-count">{depConflictCount}</span>
        )}
      </button>
      <button
        type="button"
        role="menuitem"
        className={cdrView === "pdr" ? "active" : ""}
        onClick={() => pick("pdr")}
        title="Check each filed route against the Prohibited/Danger/Restricted areas and the published preferred routes (PDR, ENR 1.10)"
      >
        <NavIcon name="restricted" size={15} />
        Route &amp; area check
        {pdrActionable > 0 && (
          <span className="cdr-menu-count">{pdrActionable}</span>
        )}
      </button>

      <div className="cdr-menu-sep" role="separator" />

      {/* Auto-resolve is a three-way choice, not a switch: the operator picks
          WHEN the resolver works — up front over the whole filed plan, or live
          as the replay runs. */}
      <div className="cdr-auto-head">
        <span>
          <NavIcon name="auto" size={15} /> Auto-resolve conflicts
        </span>
        <span className={`cdr-auto-pill${autoResolve ? " on" : ""}`}>
          {autoResolve ? "ON" : "OFF"}
        </span>
      </div>
      <div
        className="cdr-auto-modes"
        role="group"
        aria-label="Auto-resolve conflicts"
      >
        {autoModeOptions.map((o) => (
          <button
            key={o.mode}
            type="button"
            role="menuitemradio"
            aria-checked={autoResolveMode === o.mode}
            className={`cdr-auto-mode${
              autoResolveMode === o.mode ? " active" : ""
            }`}
            onClick={() => {
              // Re-picking "Before replay" re-runs the pass over whatever is
              // still unresolved.
              if (o.mode === "before" && autoResolveMode === "before") {
                onRerunAutoPass();
              } else {
                onAutoResolveMode(o.mode);
              }
            }}
            title={o.hint}
          >
            <span className="cdr-auto-radio" aria-hidden>
              {autoResolveMode === o.mode ? "●" : "○"}
            </span>
            <span>{o.label}</span>
          </button>
        ))}
      </div>
      {autoResolveMode === "before" && autoPass && (
        <div className="cdr-auto-status" role="status" aria-live="polite">
          {autoPass.done
            ? `Plan deconflicted · ${autoPass.fixed} fixed${
                autoPass.unfixed > 0
                  ? ` · ${autoPass.unfixed} need manual action`
                  : ""
              } — pick again to re-run`
            : `Resolving the filed plan… ${autoPass.fixed} fixed`}
        </div>
      )}
    </div>
  );
}

export default memo(ConflictsMenu);
