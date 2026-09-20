"use client";

/**
 * DynamicSectorPanel — how the airspace should be configured, hour by hour.
 *
 * Its own panel and its own button, deliberately apart from the conflict and
 * route checks. Those answer "is this flight plan safe to fly"; this answers
 * "how many controllers does this traffic need, and where should the boundaries
 * be" — a capacity question, asked of the whole sample rather than of one
 * aircraft. Sharing a panel with them would put a staffing proposal next to a
 * list of violations and invite reading the first as the second.
 *
 * Three answers, per hour:
 *
 *   * **Merge** — adjacent sectors quiet enough to be worked from one position.
 *   * **Split** — a sector over capacity, so a slice of its airspace goes to a
 *     neighbour with room. The boundary that moves is real geometry, drawn on
 *     the map, not a note.
 *   * **Unchanged** — traffic is ordinary and the published configuration
 *     stands. Said out loud, because "no proposal" and "nothing to propose" are
 *     different and only one of them means the tool has finished thinking.
 *
 * Nothing here alters the published airspace. Every position reads back to its
 * baseline sectors, and the panel says so where it cannot be missed.
 */

import { useMemo, useState, type ReactNode } from "react";

import {
  dynamicLog,
  dynamicSectorsCsv,
  leadTimeIssues,
  describePosition,
  hourRangeLabel,
  spanLabel,
  type DynamicLogEntry,
  type DynamicPlan,
  type DynamicSectorConfig,
  type HourDecision,
} from "@/lib/report/dynamicSectors";
import { dynamicSectorisationXlsx } from "@/lib/report/chartData";
import { XLSX_MIME } from "@/lib/report/xlsx";
import type { AreaTransfer } from "@/lib/report/dynamicArea";
import type { SectorHourRow } from "@/lib/report/flightEvents";
import { saveBinaryFile, saveTextFile } from "@/lib/saveFile";
import NavIcon from "@/components/nav/NavIcon";

interface Props {
  /** The recommendation, once Run has produced one. Null before that — this
   *  panel does not plan continuously in the background: a configuration is
   *  asked for, looked at, and then accepted or not. */
  plan: DynamicPlan | null;
  /** True once the shown plan has been accepted by the operator. */
  applied: boolean;
  /** The positions the applied configuration has open AT THE SIM CLOCK. Empty
   *  when nothing is applied, or when this hour is worked as published. What
   *  makes "applied" mean something the reader can see: these are the units the
   *  simulation is now attributing traffic and conflicts to. */
  inForce?: string[];
  /** Run the planner over the whole sample. */
  onRun: () => void;
  /** Accept what is on screen, or hand it back. */
  onApply: () => void;
  onRevert: () => void;
  /** True while the traffic has not been walked yet. */
  running: boolean;
  /** The traffic table the plan was built from, for the workbook's chart. */
  rows: SectorHourRow[] | null;
  loading: boolean;
  flightCount: number;
  config: DynamicSectorConfig;
  onConfig: (c: DynamicSectorConfig) => void;
  /** Show a piece of the configuration on the map — the sectors a band-box
   *  covers, or the airspace a re-cut hands over — or clear it. */
  onView: (
    v:
      | { kind: "transfer"; key: string; transfer: AreaTransfer }
      | { kind: "merge"; key: string; label: string; sectors: string[] }
      | null,
  ) => void;
  /** Which one is drawn right now. */
  shownKey: string | null;
  onClose: () => void;
}

const CHANGE_LABEL: Record<string, string> = {
  none: "Published configuration",
  merge: "Band-box",
  split: "Boundary change",
  "merge+split": "Band-box + boundary change",
};

function DownloadIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" className="si-dl-ico">
      <path
        d="M8 1.5v8m0 0L5 6.5m3 3 3-3M2.5 11v2.5h11V11"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The same question mark the download dialog uses for its notes. */
function QuestionIcon() {
  return (
    <svg
      viewBox="0 0 1024 1024"
      width="1em"
      height="1em"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64zm0 820c-205.4 0-372-166.6-372-372s166.6-372 372-372 372 166.6 372 372-166.6 372-372 372z" />
      <path d="M623.6 316.7C593.6 290.4 554 276 512 276s-81.6 14.5-111.6 40.7C369.2 344 352 380.7 352 420v7.6c0 4.4 3.6 8 8 8h48c4.4 0 8-3.6 8-8V420c0-44.1 43.1-80 96-80s96 35.9 96 80c0 31.1-22 59.6-56.1 72.7-21.2 8.1-39.2 22.3-52.1 40.9-13.1 19-19.9 41.8-19.9 64.9V620c0 4.4 3.6 8 8 8h48c4.4 0 8-3.6 8-8v-22.7a48.3 48.3 0 0 1 30.9-44.8c59-22.7 97.1-74.7 97.1-132.5.1-39.3-17.1-76-48.3-103.3zM472 732a40 40 0 1 0 80 0 40 40 0 1 0-80 0z" />
    </svg>
  );
}

/**
 * A note on a setting, shown on hover.
 *
 * The browser's own tooltip, via `title` — the same thing the download dialog
 * does. A hand-rolled hover panel was tried here first and is not worth the
 * risk: it lives INSIDE the label, so any CSS that fails to reach it dumps the
 * whole explanation into the layout as visible text, which is exactly what it
 * did. A `title` cannot do that, cannot be clipped by the panel's scroll box,
 * and needs no positioning.
 */
function InfoTip({ title, text }: { title: string; text: string }) {
  return (
    <span
      className="dlm-note si-info"
      title={title + " — " + text}
      aria-label={title + ". " + text}
      // The marker sits inside a <label>, so a click would otherwise fall
      // through and focus the number input.
      onClick={(e) => e.preventDefault()}
    >
      <QuestionIcon />
    </span>
  );
}

/** "2026-09-07T03:00Z" -> "07 Sep". */
const dayLabel = (hourUtc: string) => {
  const t = Date.parse(hourUtc);
  return Number.isFinite(t) ? new Date(t).toUTCString().slice(5, 11) : "";
};

const hhmm = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(11, 16) + "Z" : iso;
};

export default function DynamicSectorPanel({
  plan,
  applied,
  inForce,
  onRun,
  onApply,
  onRevert,
  running,
  rows,
  loading,
  flightCount,
  config,
  onConfig,
  onView,
  shownKey,
  onClose,
}: Props) {
  const [hour, setHour] = useState<string>("");

  const hours = useMemo(() => plan?.hours.map((h) => h.hourUtc) ?? [], [plan]);
  const current = useMemo(
    () => plan?.hours.find((h) => h.hourUtc === hour) ?? plan?.hours[0] ?? null,
    [plan, hour],
  );

  /** The run in one line: how much staffing the traffic actually asked for. */
  const summary = useMemo(() => {
    if (!plan || plan.hours.length === 0) return null;
    const baseline = plan.hours[0].baselineSectors;
    const openHours = plan.hours.reduce((n, h) => n + h.positionsOpen, 0);
    return {
      hours: plan.hours.length,
      baseline,
      saved: baseline * plan.hours.length - openHours,
      merges: plan.hours.filter((h) => h.change.includes("merge")).length,
      splits: plan.hours.filter((h) => h.change.includes("split")).length,
      unchanged: plan.hours.filter((h) => h.change === "none").length,
      blocked: plan.hours.reduce((n, h) => n + h.blocked.length, 0),
    };
  }, [plan]);

  const log = useMemo(() => (plan ? dynamicLog(plan) : []), [plan]);
  /** Changes the lead time leaves no room to issue. Empty on an ordinary plan,
   *  which is why it can be shown as a warning rather than a standing note. */
  const leadIssues = useMemo(() => (plan ? leadTimeIssues(plan) : []), [plan]);

  /** The key a log line is drawn under. Stable across re-renders so the ticked
   *  row and the shape on the map cannot drift apart. */
  const keyOf = (e: DynamicLogEntry) =>
    e.hourUtc + "#" + e.seq + ":" + e.kind + ":" + e.label;

  /** Show a log line on the map, and bring its hour forward so the detail above
   *  matches what is highlighted. */
  const view = (e: DynamicLogEntry) => {
    const key = keyOf(e);
    if (shownKey === key) {
      onView(null);
      return;
    }
    setHour(e.hourUtc);
    if (e.transfer) onView({ kind: "transfer", key, transfer: e.transfer });
    else if (e.sectors.length > 0) {
      onView({ kind: "merge", key, label: e.label, sectors: e.sectors });
    } else onView(null);
  };

  const download = () => {
    if (!plan) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const base = "dynamic_sectorisation_" + stamp;
    // The workbook holds all four tables as tabs plus the chart; the CSV is the
    // plan on its own, for anything that reads tables rather than workbooks.
    saveBinaryFile(dynamicSectorisationXlsx(plan, rows ?? []), base + ".xlsx", XLSX_MIME);
    saveTextFile(dynamicSectorsCsv(plan), base + ".csv");
  };

  return (
    <div className="cdr-panel dynsec" role="dialog" aria-label="Dynamic sectorisation">
      <div className="cdr-panel-head">
        <strong>
          <NavIcon name="grid" size={14} /> Dynamic sectorisation
        </strong>
        <span className="cdr-head-actions">
          <button
            type="button"
            className="si-dl"
            onClick={download}
            disabled={!plan}
            title="Save the plan, the boundary changes and the configuration timeline — as a workbook with the chart, plus the plan on its own as CSV"
          >
            <DownloadIcon />
            <span>Plan</span>
            <span className="si-dl-ext">XLSX+CSV</span>
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

      {/* Who decides, then the one button that does the work. The button does
          NOT ask the operator to choose merge or split — it asks the system to
          work the whole sample out and propose a configuration. */}
      <div className="dynsec-mode">
        <span className="dynsec-mode-h">Mode</span>
        <label>
          <input
            type="radio"
            name="dynsec-mode"
            checked={config.mode === "auto"}
            onChange={() => onConfig({ ...config, mode: "auto" })}
          />
          <span>
            <b>Auto</b>
            <em>the traffic decides each hour</em>
          </span>
        </label>
        <label>
          <input
            type="radio"
            name="dynsec-mode"
            checked={config.mode === "manual"}
            onChange={() => onConfig({ ...config, mode: "manual" })}
          />
          <span>
            <b>Manual</b>
            <em>keep the published configuration unless told otherwise</em>
          </span>
        </label>
      </div>

      <button
        type="button"
        className="generate dynsec-run"
        onClick={onRun}
        disabled={running || flightCount === 0}
      >
        {running ? "Analysing…" : "▶ Run dynamic sectorisation"}
      </button>

      {loading && <p className="cdr-panel-empty">Walking the traffic sample…</p>}

      {!loading && flightCount === 0 && (
        <p className="cdr-panel-empty">
          Nothing to plan yet. The configuration is worked out from the FLOWN
          trajectories, so press <b>Generate all</b> first, then reopen this.
        </p>
      )}

      {!loading && !running && flightCount > 0 && !plan && (
        <p className="cdr-panel-empty">
          Ready. <b>Run dynamic sectorisation</b> walks all {flightCount}{" "}
          flights hour by hour and proposes a configuration — merging the quiet
          sectors, re-cutting the ones over capacity, and leaving the rest as
          published.
        </p>
      )}

      {!loading && plan && (
        <>
          <div className="si-dyn-cfg dynsec-cfg">
            <label className="si-num">
              <span className="si-num-lbl">
                Merge below
                <InfoTip
                  title="Merge below"
                  text={
                    "adjacent sectors are worked from one position while their " +
                    "COMBINED traffic stays under this many aircraft in the hour."
                  }
                />
              </span>
              <input
                type="number"
                min={1}
                max={99}
                value={config.mergeBelow}
                onChange={(e) =>
                  onConfig({
                    ...config,
                    mergeBelow: Math.max(1, Math.min(99, Number(e.target.value) || 1)),
                  })
                }
              />
              <span className="si-num-hint">quiet enough to share</span>
            </label>
            <label className="si-num">
              <span className="si-num-lbl">
                Split above
                <InfoTip
                  title="Split above"
                  text={
                    "at or above this many aircraft in the hour a sector is over " +
                    "capacity, and a slice of its airspace is offered to an " +
                    "adjacent sector with room."
                  }
                />
              </span>
              <input
                type="number"
                min={2}
                max={99}
                value={config.splitAbove}
                onChange={(e) =>
                  onConfig({
                    ...config,
                    splitAbove: Math.max(2, Math.min(99, Number(e.target.value) || 2)),
                  })
                }
              />
              <span className="si-num-hint">over capacity at</span>
            </label>
            <label className="si-num">
              <span className="si-num-lbl">
                Max sectors
                <InfoTip
                  title="Max sectors per position"
                  text={
                    "the most published sectors one controller may be given, " +
                    "however quiet they are."
                  }
                />
              </span>
              <input
                type="number"
                min={2}
                max={6}
                value={config.maxSectorsPerPosition}
                onChange={(e) =>
                  onConfig({
                    ...config,
                    maxSectorsPerPosition: Math.max(
                      2,
                      Math.min(6, Number(e.target.value) || 2),
                    ),
                  })
                }
              />
              <span className="si-num-hint">per position</span>
            </label>
            <label className="si-num">
              <span className="si-num-lbl">
                Lead time
                <InfoTip
                  title="Lead time"
                  text={
                    "the least notice that has to be given before a sector " +
                    "configuration change takes effect, to brief the handover " +
                    "and re-draw the radar labels.\n\nExample: a change due at " +
                    "01:00Z with " +
                    config.leadTimeMin +
                    " min of lead has to be decided by " +
                    hhmm(
                      new Date(
                        Date.UTC(2000, 0, 1, 1, 0) - config.leadTimeMin * 60000,
                      ).toISOString(),
                    ) +
                    "."
                  }
                />
              </span>
              <input
                type="number"
                min={0}
                max={120}
                step={5}
                value={config.leadTimeMin}
                onChange={(e) =>
                  onConfig({
                    ...config,
                    leadTimeMin: Math.max(0, Math.min(120, Number(e.target.value) || 0)),
                  })
                }
              />
              <span className="si-num-hint">minimum notice before change</span>
            </label>
          </div>

          <div className={"dynsec-accept" + (applied ? " on" : "")}>
            {applied ? (
              <>
                <span className="dynsec-accept-state">
                  ✔ Configuration applied
                  {plan.appliedAt ? " at " + hhmm(plan.appliedAt) : ""}
                  {inForce && inForce.length > 0 ? (
                    <em className="dynsec-inforce">
                      In force now: {inForce.join(", ")} — conflicts and traffic
                      counts are attributed to these positions
                    </em>
                  ) : (
                    <em className="dynsec-inforce">
                      This hour is worked as published
                    </em>
                  )}
                </span>
                <button type="button" className="dynsec-revert" onClick={onRevert}>
                  ↩ Revert to published
                </button>
              </>
            ) : (
              <>
                <span className="dynsec-accept-state">
                  Recommended configuration — not yet applied
                </span>
                <button
                  type="button"
                  className="generate dynsec-apply"
                  onClick={onApply}
                >
                  ✓ Apply configuration
                </button>
              </>
            )}
          </div>

          {summary && (
            <div className="si-stats dynsec-stats">
              <div className="si-stat">
                <span className="si-num">{summary.merges}</span>
                <span className="si-lbl">hours merging</span>
                <span className="si-sub">quiet</span>
              </div>
              <div className="si-stat">
                <span className="si-num">{summary.splits}</span>
                <span className="si-lbl">hours splitting</span>
                <span className="si-sub">over capacity</span>
              </div>
              <div className="si-stat">
                <span className="si-num">{summary.unchanged}</span>
                <span className="si-lbl">unchanged</span>
                <span className="si-sub">of {summary.hours} hours</span>
              </div>
            </div>
          )}

          <div className="dynsec-picks">
            <label className="si-pick">
              <span>Hour (UTC)</span>
              <select
                value={current?.hourUtc ?? ""}
                onChange={(e) => setHour(e.target.value)}
              >
                {hours.map((h) => (
                  <option key={h} value={h}>
                    {dayLabel(h)} {hourRangeLabel(h)}
                  </option>
                ))}
              </select>
            </label>
            {/* The per-hour decision. Manual mode only: in Auto the traffic
                decides, and a control that contradicted that would be worse
                than absent — the planner ignores stored overrides there for the
                same reason. */}
            {config.mode === "manual" && (
            <label className="si-pick">
              <span>This hour</span>
              <select
                value={current ? (config.overrides?.[current.hourUtc] ?? "") : ""}
                onChange={(e) => {
                  if (!current) return;
                  const next = { ...(config.overrides ?? {}) };
                  if (e.target.value === "") delete next[current.hourUtc];
                  else next[current.hourUtc] = e.target.value as HourDecision;
                  onConfig({ ...config, overrides: next });
                }}
              >
                <option value="">Keep published (default)</option>
                <option value="auto">Decide from the traffic</option>
                <option value="merge">Merge only</option>
                <option value="split">Re-cut only</option>
                <option value="keep">Force: keep published</option>
              </select>
            </label>
            )}
          </div>

          {/* Only when the arithmetic says a change cannot be issued in time.
              Lead time is not a note on the report: it decides whether a
              recommendation is usable, so this earns the space when it fires
              and takes none when it does not. */}
          {leadIssues.length > 0 && (
            <div className="dynsec-lead-warn" role="alert">
              <b>
                ⚠ {leadIssues.length} change
                {leadIssues.length === 1 ? "" : "s"} cannot be briefed in time
              </b>
              {leadIssues.map((w) => (
                <p key={w.hourUtc + w.notifyBy}>
                  <span className="dynsec-lead-when">
                    {hourRangeLabel(w.hourUtc)}
                  </span>{" "}
                  — {w.reason}.
                </p>
              ))}
              <em>
                Shorten the lead time, or accept that this change has to be
                planned before the run.
              </em>
            </div>
          )}

          {config.mode === "auto" && (
            <p className="dynsec-auto-note">
              Auto decides every hour from the traffic. To set an hour yourself,
              switch to <b>Manual</b>.
            </p>
          )}

          {current && (
            <div className="si-body">
              <p className="si-head">
                {/* "merge+split" is a fine class in HTML and a nuisance in a CSS
                    selector, where the + would need escaping. */}
                <span
                  className={"dynsec-chip " + current.change.replace("+", "-")}
                >
                  {CHANGE_LABEL[current.change]}
                </span>
                {current.positionsOpen} position
                {current.positionsOpen === 1 ? "" : "s"} for{" "}
                {current.baselineSectors} sectors
                {current.manual && (
                  <span className="dynsec-manual" title="An operator override, not the automatic decision">
                    operator
                  </span>
                )}
              </p>

              {current.change === "none" && current.overloaded.length === 0 && (
                <p className="si-note">
                  {current.decision === "keep"
                    ? "This hour is set to keep the published configuration."
                    : "Traffic is within the normal band in every sector this hour: nothing to merge, nothing over capacity. The published configuration stands."}
                </p>
              )}

              {/* --- merges --- */}
              {current.positions.filter((p) => p.merged).length > 0 && (
                <>
                  <h4 className="pdr-group-h">Merge — quiet enough to share</h4>
                  {current.positions
                    .filter((p) => p.merged)
                    .map((p) => (
                      <p key={p.label} className="si-dyn-merge">
                        {describePosition(p)}
                      </p>
                    ))}
                </>
              )}

              {/* --- splits --- */}
              {current.transfers.length > 0 && (
                <>
                  <h4 className="pdr-group-h">Split — over capacity</h4>
                  {current.transfers.map((t) => {
                    const key = current.hourUtc + ">" + t.from + ">" + t.to;
                    const shown = shownKey === key;
                    return (
                      <div key={key} className="dynsec-transfer">
                        <p className="si-dyn-split">
                          <b>{t.from}</b> cedes its <b>{t.quadrant}</b> airspace
                          to <b>{t.to}</b> — {t.flights.length} aircraft,{" "}
                          {t.areaNm2} NM². {t.from} then holds {t.fromAfter},{" "}
                          {t.to} holds {t.toAfter}.
                        </p>
                        <button
                          type="button"
                          className={"dynsec-view split" + (shown ? " on" : "")}
                          onClick={() =>
                            onView(shown ? null : { kind: "transfer", key, transfer: t })
                          }
                        >
                          {shown ? "◉ Hide boundary" : "⌖ Show boundary"}
                        </button>
                      </div>
                    );
                  })}
                </>
              )}

              {/* --- overloads nobody could relieve --- */}
              {current.blocked.length > 0 && (
                <>
                  <h4 className="pdr-group-h">Over capacity, not relieved</h4>
                  {current.blocked.map((b) => (
                    <p key={b.sector} className="si-note warn">
                      <b>{b.sector}</b> holds {b.flights} — {b.reason}.
                    </p>
                  ))}
                </>
              )}

              {current.splitBack.length > 0 && (
                <p className="si-dyn-split">
                  ↩ Split back this hour: {current.splitBack.join(", ")}.
                </p>
              )}
            </div>
          )}

          {/* --- when to change --- */}
          {plan.transitions.length > 0 && (
            <>
              <h4 className="pdr-group-h">When to change configuration</h4>
              <ul className="dynsec-timeline">
                {plan.transitions.map((t, i) => (
                  <li key={t.hourUtc + i} className={"kind-" + t.kind}>
                    <span className="dynsec-when">
                      {dayLabel(t.hourUtc)} {hourRangeLabel(t.hourUtc)}
                    </span>
                    <span className="dynsec-what">{t.detail}</span>
                    <span className="dynsec-notify">
                      brief by {hhmm(t.notifyBy)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {/* The log: every configuration action over the run, with a way to
              see each one on the map. The timeline above says WHEN things
              change; this says what was in force and where. */}
          {log.length > 0 && (
            <>
              <h4 className="pdr-group-h">
                Configuration log ({log.length})
              </h4>
              <ul className="dynsec-log">
                {log.map((e) => {
                  const key = keyOf(e);
                  const shown = shownKey === key;
                  const canView = e.sectors.length > 0;
                  return (
                    <li key={key} className={"log-" + e.kind}>
                      <span className="dynsec-log-when">
                        {hourRangeLabel(e.hourUtc).replace(" UTC", "")}
                      </span>
                      <span className={"dynsec-log-kind " + e.kind}>
                        {e.kind === "overload" ? "OVER" : e.kind.toUpperCase()}
                      </span>
                      <span className="dynsec-log-what">
                        <b>{e.label}</b>
                        <em>{e.detail}</em>
                      </span>
                      {canView ? (
                        <button
                          type="button"
                          className={
                            "dynsec-view " + e.kind + (shown ? " on" : "")
                          }
                          onClick={() => view(e)}
                          title={
                            e.transfer
                              ? "Show the airspace that changes hands"
                              : "Show the sectors worked from one position"
                          }
                        >
                          {shown ? "◉ Hide" : "⌖ View"}
                        </button>
                      ) : (
                        <span />
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          {plan.spans.length > 0 && (
            <p className="si-note">
              Band-boxes held:{" "}
              {plan.spans.map((s) => s.label + " " + spanLabel(s)).join(" · ")}
            </p>
          )}

          <p className="si-note si-dyn-basis">
            This is a <b>dynamic operational configuration</b> — who works which
            airspace, and where the working boundaries sit, for this traffic
            sample. The published sector map is unchanged: every position reads
            back to the same {summary?.baseline ?? 0} baseline sectors, and
            nothing here is written to the airspace definition. Coverage of ceded
            airspace is assumed within {config.maxCedeNm} NM of the receiving
            sector — this dataset carries no radar coverage to check it against.
          </p>
        </>
      )}
    </div>
  );
}
