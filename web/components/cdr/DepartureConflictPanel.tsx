"use client";

/**
 * DepartureConflictPanel — filed plans that cannot both be cleared off the
 * runway as filed (ICAO Doc 4444 §5.6 / §5.8.3 / §7.9.2 / §8.7.3).
 *
 * This is the pre-departure half of conflict management, and it sits beside
 * the other CD&R panels on purpose: same right-hand rail, same shape, one
 * place to look. What makes it different is WHEN it applies — nothing has been
 * generated yet, so there are no 4D paths to detect against; the pairs come
 * out of the plans themselves the moment a file is imported.
 *
 * Each row names the pair, the rule and the shortfall. "Fix" asks which of the
 * two flights to move and then hands the user to that plan's own tab, where
 * its EOBT field carries the suggested time. "Auto fix all" does the same for
 * every pair without asking, which is the only workable option once an import
 * brings in a hundred of them.
 */

import {
  fmtInterval,
  hhmmZ,
  resolvedEobtMs,
  type DepartureConflict,
} from "@/lib/departureSeparation";

interface Props {
  conflicts: DepartureConflict[];
  onClose: () => void;
  /** Dismiss one pair / every pair currently listed. */
  onIgnore: (conflictId: string) => void;
  onIgnoreAll: (conflictIds: string[]) => void;
  /** Take the user to that plan's tab with the suggested EOBT attached. */
  onFix: (conflictId: string, planId: string) => void;
  /** Re-time every pair at once, moving one side of each. */
  onAutoFixAll: () => void;
  /** Which pair's "which FPL?" chooser is open. */
  choiceFor: string | null;
  onChoiceFor: (conflictId: string | null) => void;
}

/** Listed in full before the rest are summarised — a 2000-flight import can
 *  produce a hundred, and this is a warning, not a report. */
const SHOWN = 8;

export default function DepartureConflictPanel({
  conflicts,
  onClose,
  onIgnore,
  onIgnoreAll,
  onFix,
  onAutoFixAll,
  choiceFor,
  onChoiceFor,
}: Props) {
  return (
    <div
      className="cdr-panel dep-panel"
      role="dialog"
      aria-label="Departure conflicts"
    >
      <div className="cdr-panel-head">
        <strong>🛫 Departure Conflict</strong>
        <button
          type="button"
          className="cdr-panel-close"
          onClick={onClose}
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      {conflicts.length === 0 ? (
        <p className="cdr-panel-empty">
          No departure conflicts. Every filed plan has the interval it needs
          behind the one ahead of it on its runway.
        </p>
      ) : (
        <>
          <div className="dep-panel-bar">
            <span className="dep-panel-count">
              {conflicts.length} pair{conflicts.length === 1 ? "" : "s"} — same
              aerodrome, same runway
            </span>
            <div className="dep-panel-acts">
              <button
                type="button"
                className="dep-conf-fix"
                onClick={onAutoFixAll}
                title="Re-time every pair to the Doc 4444 minimum, without asking which side to move"
              >
                Auto fix all
              </button>
              <button
                type="button"
                className="dep-conf-ignore"
                onClick={() => onIgnoreAll(conflicts.map((c) => c.id))}
              >
                Ignore all
              </button>
            </div>
          </div>
          {/* The one thing a controller must know before pressing it: the tool
              picks a side at random, so the bank comes out legal but not
              sequenced to anyone's intent. */}
          <p className="dep-panel-note">
            Auto fix all: random FPL to fix — for each pair one of the two
            flights is picked at random and moved to the required time. Anything
            still short after that is pushed behind the aircraft ahead of it, so
            the whole bank ends up clear.
          </p>

          <div className="dep-panel-body">
            {conflicts.slice(0, SHOWN).map((c) => (
              <div key={c.id} className="dep-conf-row">
                <p className="dep-conf-text">
                  <b>{c.leader.callsign}</b> ({c.leader.adep}→{c.leader.ades})
                  {" and "}
                  <b>{c.follower.callsign}</b> ({c.follower.adep}→
                  {c.follower.ades}) both depart {c.adep} {c.runway} at{" "}
                  <b>{hhmmZ(c.leader.eobtMs ?? 0)}</b>
                  {c.gapSec > 0 && (
                    <> / <b>{hhmmZ(c.follower.eobtMs ?? 0)}</b></>
                  )}
                  {" — "}
                  {c.gapSec > 0
                    ? `only ${fmtInterval(c.gapSec)} apart, `
                    : "at the same time, "}
                  {fmtInterval(c.requiredSec)} required: {c.reason}.
                  {c.runwayAssumed && (
                    <span className="dep-conf-assumed">
                      {" "}
                      Runway is Auto on both plans, so they share the
                      aerodrome&apos;s default one.
                    </span>
                  )}
                </p>
                <div className="dep-conf-btns">
                  <button
                    type="button"
                    className="dep-conf-ignore"
                    onClick={() => {
                      onIgnore(c.id);
                      onChoiceFor(null);
                    }}
                  >
                    Ignore
                  </button>
                  <button
                    type="button"
                    className="dep-conf-fix"
                    onClick={() => onChoiceFor(choiceFor === c.id ? null : c.id)}
                  >
                    Fix
                  </button>
                </div>
                {choiceFor === c.id && (
                  <div className="dep-conf-choice">
                    <span className="dep-conf-choice-q">
                      Which FPL do you want to fix?
                    </span>
                    {[c.leader, c.follower].map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        className="dep-conf-pick"
                        onClick={() => onFix(c.id, f.id)}
                      >
                        ▸ {f.callsign} {f.adep} to {f.ades}
                        <span className="dep-conf-pick-t">
                          {f.eobtMs != null ? hhmmZ(f.eobtMs) : "—"} →{" "}
                          {(() => {
                            const ms = resolvedEobtMs(c, f.id);
                            return ms == null ? "—" : hhmmZ(ms);
                          })()}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {conflicts.length > SHOWN && (
              <p className="dep-conf-more">
                + {conflicts.length - SHOWN} more, worst first.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
