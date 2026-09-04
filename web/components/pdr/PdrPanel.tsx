"use client";

/**
 * PdrPanel — the PDR (Prohibited / Danger / Restricted) conflict check.
 *
 * Left column: every generated flight with its worst finding, so a bank can be
 * scanned at a glance. Right column: the selected flight's findings, each with
 * the published rule it breaches, and the alternative routes ENR 1.10 offers.
 *
 * The Apply action deliberately does NOT re-fly the flight. It stages the
 * suggested route into that flight's plan in the generator and stops there, so
 * the controller reads the routing, presses Generate themselves, and stays the
 * one who decides. A route that changed itself the moment the tool suggested it
 * would be a different (and much worse) tool.
 */

import type { PdrFinding, PdrReport, RouteSuggestion } from "@/lib/pdr/detect";
import type { PdrArea } from "@/lib/pdr/types";

export interface PdrFlightRow {
  flightKey: string;
  callsign: string;
  adep: string;
  ades: string;
}

interface Props {
  flights: PdrFlightRow[];
  reports: Map<string, PdrReport>;
  loading: boolean;
  error: string | null;
  /** AIRAC window the activity data covers, for the staleness banner. */
  validFrom: string | null;
  validTo: string | null;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  /** Stage a suggested route into that flight's plan (no regeneration). */
  onUseRoute: (flightKey: string, route: string) => void;
  /** Centre the map on an area named by a finding. */
  onFocusArea?: (area: PdrArea) => void;
  onClose: () => void;
}

const SEVERITY_LABEL = {
  violation: "CONFLICT",
  caution: "CHECK",
  info: "NOTE",
} as const;

function severityChip(sev: PdrFinding["severity"]) {
  return <span className={"pdr-chip sev-" + sev}>{SEVERITY_LABEL[sev]}</span>;
}

/** Is the plan being checked outside the AIRAC cycle the data came from? */
function staleNote(validTo: string | null): string | null {
  if (!validTo) return null;
  const end = Date.parse(validTo);
  if (!Number.isFinite(end) || Date.now() <= end) return null;
  return (
    "The PDR activity data is from the AIRAC cycle that ended " +
    validTo.slice(0, 10) +
    ". Activity times may have changed; re-run scripts/extract_aixm_restricted_areas.py against the current export."
  );
}

function SuggestionCard({
  s,
  onUse,
}: {
  s: RouteSuggestion;
  onUse: () => void;
}) {
  return (
    <div className="pdr-sugg">
      <div className="pdr-sugg-top">
        <code className="pdr-sugg-route">{s.route}</code>
        <span className="pdr-sugg-tag">{s.rnav ? "RNAV" : "Non-RNAV"}</span>
      </div>
      <p className="pdr-sugg-why">{s.why}</p>
      {s.condition && (
        <p className={"pdr-sugg-cond state-" + s.condition.state}>
          {s.condition.state === "met" ? "Condition met: " : "Condition: "}
          {s.condition.detail}
        </p>
      )}
      <div className="pdr-sugg-meta">
        {s.distanceNm != null && <span>{s.distanceNm.toFixed(0)} NM</span>}
        {s.clears.length > 0 && <span>clears {s.clears.join(", ")}</span>}
        {s.activeAreas.length > 0 && (
          <span className="warn">still crosses {s.activeAreas.join(", ")}</span>
        )}
      </div>
      <button
        type="button"
        className="pdr-sugg-apply"
        onClick={onUse}
        title="Put this routing in the flight's plan for review — it is not generated until you press Generate"
      >
        Use this route →
      </button>
    </div>
  );
}

export default function PdrPanel({
  flights,
  reports,
  loading,
  error,
  validFrom,
  validTo,
  selectedKey,
  onSelect,
  onUseRoute,
  onFocusArea,
  onClose,
}: Props) {
  const selected = selectedKey ? reports.get(selectedKey) : undefined;
  const selectedFlight = flights.find((f) => f.flightKey === selectedKey);
  const stale = staleNote(validTo);

  return (
    <div className="cdr-panel pdr-panel" role="dialog" aria-label="PDR conflict check">
      <div className="cdr-panel-head">
        <strong>🚫 PDR Conflict Check</strong>
        <button
          type="button"
          className="cdr-panel-close"
          onClick={onClose}
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      {loading && <p className="cdr-panel-empty">Loading AIP restricted-area data…</p>}
      {error && (
        <p className="cdr-panel-empty pdr-error">
          Could not load the PDR data: {error}. No areas were checked.
        </p>
      )}
      {stale && <p className="pdr-stale">⚠ {stale}</p>}

      {!loading && !error && flights.length === 0 && (
        <p className="cdr-panel-empty">
          Generate a flight to check it against the restricted areas.
        </p>
      )}

      {!loading && !error && flights.length > 0 && (
        <div className="pdr-cols">
          <section className="pdr-list">
            <h3 className="cdr-dash-h">Flights ({flights.length})</h3>
            <ul>
              {flights.map((f) => {
                const r = reports.get(f.flightKey);
                const worst = r?.worst ?? null;
                const actionable =
                  r?.findings.filter((x) => x.severity !== "info").length ?? 0;
                return (
                  <li key={f.flightKey}>
                    <button
                      type="button"
                      className={
                        "pdr-flight" +
                        (selectedKey === f.flightKey ? " active" : "") +
                        (worst ? " sev-" + worst : "")
                      }
                      onClick={() =>
                        onSelect(selectedKey === f.flightKey ? null : f.flightKey)
                      }
                    >
                      <span className="pdr-flight-cs">{f.callsign}</span>
                      <span className="pdr-flight-pair">
                        {f.adep}→{f.ades}
                      </span>
                      <span className="pdr-flight-state">
                        {actionable > 0
                          ? severityChip(worst ?? "caution")
                          : <span className="pdr-ok">clear</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="pdr-detail">
            {!selected && (
              <p className="cdr-panel-empty">Select a flight to see its check.</p>
            )}

            {selected && (
              <>
                <h3 className="cdr-dash-h">
                  {selectedFlight?.callsign} — {selected.areasChecked} areas checked
                </h3>

                {selected.areasChecked === 0 && (
                  <p className="pdr-stale">
                    ⚠ No restricted-area polygons were loaded, so airspace was not
                    checked at all.
                  </p>
                )}

                {selected.findings.length === 0 ? (
                  <p className="cdr-panel-empty">
                    No conflicts. The filed route clears every published area and
                    matches ENR 1.10 for this pair.
                  </p>
                ) : (
                  <ul className="pdr-findings">
                    {selected.findings.map((f) => (
                      <li key={f.id} className={"pdr-finding sev-" + f.severity}>
                        <div className="pdr-finding-head">
                          {severityChip(f.severity)}
                          <span className="pdr-finding-title">{f.title}</span>
                          {f.incursion && onFocusArea && (
                            <button
                              type="button"
                              className="pdr-finding-locate"
                              onClick={() => onFocusArea(f.incursion!.area)}
                              title="Centre the map on this area"
                            >
                              ⌖
                            </button>
                          )}
                        </div>
                        <p className="pdr-finding-reason">{f.reason}</p>
                        <p className="pdr-finding-src">{f.source}</p>
                      </li>
                    ))}
                  </ul>
                )}

                {selected.suggestions.length > 0 && (
                  <>
                    <h3 className="cdr-dash-h">
                      Suggested routes ({selected.suggestions.length})
                    </h3>
                    <p className="pdr-sugg-note">
                      Published ENR 1.10 routes for this pair. Choosing one fills the
                      flight&apos;s route field — nothing is re-flown until you press
                      Generate.
                    </p>
                    {selected.suggestions.map((s) => (
                      <SuggestionCard
                        key={s.route + (s.rnav ? "-R" : "-N")}
                        s={s}
                        onUse={() => onUseRoute(selectedKey!, s.route)}
                      />
                    ))}
                  </>
                )}

                {selected.suggestions.length === 0 &&
                  selected.findings.some((f) => f.severity !== "info") && (
                    <p className="cdr-panel-empty">
                      No published alternative is available for this pair at this
                      time. The routing needs coordination rather than a re-file.
                    </p>
                  )}

                {validFrom && validTo && (
                  <p className="pdr-src-note">
                    Activity times: AIXM export valid {validFrom.slice(0, 10)} to{" "}
                    {validTo.slice(0, 10)}.
                  </p>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
