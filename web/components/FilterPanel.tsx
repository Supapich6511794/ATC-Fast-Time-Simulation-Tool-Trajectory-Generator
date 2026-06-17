"use client";

/**
 * FilterPanel — FlightRadar-style flight filter (the reference mockup).
 *
 * A floating right-hand panel with three tabs:
 *  • Filter   — free-text search (flight key / ACID), aircraft type, and a
 *               Flight-Level min/max band.
 *  • Route    — ADEP / ADES dropdowns built from the generated flights.
 *  • Airlines — checkbox list of airline codes (callsign prefix).
 *
 * The filter is non-destructive: it computes which flights MATCH, then
 * "Apply" hides everything else (via the shared hiddenKeys mechanism so it
 * composes with the per-route eye toggles). Show All / Hide All / Invert act
 * directly on visibility. The Results list mirrors the live state — click a
 * row to centre + follow that aircraft (ties into camera-follow).
 */

import { useMemo, useState } from "react";

import type { TrajectoryResult } from "@/lib/trajectory/types";

export interface FlightFilter {
  search: string;
  byKey: boolean;
  byAcid: boolean;
  type: string;
  flMin: number;
  flMax: number;
  adep: string;
  ades: string;
  airlines: string[];
}

export const EMPTY_FILTER: FlightFilter = {
  search: "",
  byKey: true,
  byAcid: true,
  type: "",
  flMin: 0,
  flMax: 450,
  adep: "",
  ades: "",
  airlines: [],
};

const FL_MAX = 450;

/** Cruise flight level (rounded to the nearest 100 ft → FL). */
function flightLevel(t: TrajectoryResult): number {
  const ft = t.stats.cruiseAltFt ?? t.stats.rflFt ?? 0;
  return Math.round(ft / 100);
}

/** Airline code = leading letters of the callsign (e.g. AAR741 → AAR). */
function airlineCode(t: TrajectoryResult): string {
  const m = t.meta.callsign.match(/^[A-Za-z]+/);
  return m ? m[0].toUpperCase() : "—";
}

function matches(t: TrajectoryResult, f: FlightFilter): boolean {
  const fl = flightLevel(t);
  if (fl < f.flMin || fl > f.flMax) return false;
  if (f.type && !(t.meta.aircraftType ?? "").toUpperCase().includes(f.type.toUpperCase()))
    return false;
  if (f.adep && t.meta.adep.toUpperCase() !== f.adep.toUpperCase()) return false;
  if (f.ades && t.meta.ades.toUpperCase() !== f.ades.toUpperCase()) return false;
  if (f.airlines.length && !f.airlines.includes(airlineCode(t))) return false;
  const q = f.search.trim().toUpperCase();
  if (q) {
    const inKey = f.byKey && t.meta.flightKey.toUpperCase().includes(q);
    const inAcid = f.byAcid && t.meta.callsign.toUpperCase().includes(q);
    if (!inKey && !inAcid) return false;
  }
  return true;
}

type Tab = "filter" | "route" | "airlines";

interface FilterPanelProps {
  open: boolean;
  onClose: () => void;
  trajectories: TrajectoryResult[];
  aircraftTypes: string[];
  filter: FlightFilter;
  onFilterChange: (patch: Partial<FlightFilter>) => void;
  /** flightKeys currently hidden on the map. */
  hiddenKeys: Set<string>;
  /** Hide every flight whose key is in the set, show the rest (Apply). */
  onApplyHidden: (hidden: Set<string>) => void;
  onShowAll: () => void;
  onHideAll: () => void;
  onInvert: () => void;
  onToggleHidden: (flightKey: string) => void;
  /** Centre + follow this flight (by index in trajectories). */
  onSelectFlight: (index: number) => void;
  /** Index of the flight currently driving playback (highlighted). */
  activeIndex: number | "all";
}

export default function FilterPanel({
  open,
  onClose,
  trajectories,
  aircraftTypes,
  filter,
  onFilterChange,
  hiddenKeys,
  onApplyHidden,
  onShowAll,
  onHideAll,
  onInvert,
  onToggleHidden,
  onSelectFlight,
  activeIndex,
}: FilterPanelProps) {
  const [tab, setTab] = useState<Tab>("filter");
  // Quick filter for the Results list — searches by ICAO designator
  // (callsign / flight key). Independent of the Apply filter above.
  const [resultQuery, setResultQuery] = useState("");

  // Distinct ADEP / ADES / airline codes from the generated flights.
  const adeps = useMemo(
    () => Array.from(new Set(trajectories.map((t) => t.meta.adep))).sort(),
    [trajectories],
  );
  const adess = useMemo(
    () => Array.from(new Set(trajectories.map((t) => t.meta.ades))).sort(),
    [trajectories],
  );
  const airlines = useMemo(
    () => Array.from(new Set(trajectories.map(airlineCode))).sort(),
    [trajectories],
  );

  // Which flights match the current (unapplied) filter — drives the Apply
  // count and the Results dots.
  const matchedKeys = useMemo(() => {
    const s = new Set<string>();
    for (const t of trajectories) if (matches(t, filter)) s.add(t.meta.flightKey);
    return s;
  }, [trajectories, filter]);

  // Rows shown in the Results list — the quick ICAO-designator search
  // narrows them without touching the Apply filter / map visibility.
  const shown = useMemo(() => {
    const q = resultQuery.trim().toUpperCase();
    const rows = trajectories.map((t, i) => ({ t, i }));
    if (!q) return rows;
    return rows.filter(
      ({ t }) =>
        t.meta.callsign.toUpperCase().includes(q) ||
        t.meta.flightKey.toUpperCase().includes(q),
    );
  }, [trajectories, resultQuery]);

  if (!open) return null;

  const apply = () => {
    const hide = new Set<string>();
    for (const t of trajectories)
      if (!matchedKeys.has(t.meta.flightKey)) hide.add(t.meta.flightKey);
    onApplyHidden(hide);
  };

  return (
    <aside className="filter-panel" aria-label="Filter flights">
      <header className="fp-head">
        <span className="fp-title">🔎 Filter Flights</span>
        <button
          type="button"
          className="fp-close"
          onClick={onClose}
          aria-label="Close filter panel"
        >
          ✕
        </button>
      </header>

      <nav className="fp-tabs" role="tablist">
        {(["filter", "route", "airlines"] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? "active" : undefined}
            onClick={() => setTab(t)}
          >
            {t === "filter" ? "Filter" : t === "route" ? "Route" : "Airlines"}
          </button>
        ))}
      </nav>

      <div className="fp-body">
        {tab === "filter" && (
          <>
            <label className="fp-section-label">Search</label>
            <input
              type="text"
              className="fp-input"
              value={filter.search}
              onChange={(e) => onFilterChange({ search: e.target.value })}
              placeholder="Flight key or ACID…"
            />
            <div className="fp-checks">
              <label>
                <input
                  type="checkbox"
                  checked={filter.byKey}
                  onChange={(e) => onFilterChange({ byKey: e.target.checked })}
                />
                Key
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={filter.byAcid}
                  onChange={(e) => onFilterChange({ byAcid: e.target.checked })}
                />
                ACID
              </label>
            </div>

            <label className="fp-section-label">Aircraft type</label>
            <select
              className="fp-input"
              value={filter.type}
              onChange={(e) => onFilterChange({ type: e.target.value })}
            >
              <option value="">ACTYPE — any</option>
              {aircraftTypes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>

            <label className="fp-section-label">Flight level</label>
            <div className="fp-slider-row">
              <span>Min</span>
              <input
                type="range"
                min={0}
                max={FL_MAX}
                step={10}
                value={filter.flMin}
                onChange={(e) =>
                  onFilterChange({
                    flMin: Math.min(Number(e.target.value), filter.flMax),
                  })
                }
              />
              <span className="fp-slider-val">{filter.flMin}</span>
            </div>
            <div className="fp-slider-row">
              <span>Max</span>
              <input
                type="range"
                min={0}
                max={FL_MAX}
                step={10}
                value={filter.flMax}
                onChange={(e) =>
                  onFilterChange({
                    flMax: Math.max(Number(e.target.value), filter.flMin),
                  })
                }
              />
              <span className="fp-slider-val">{filter.flMax}</span>
            </div>
          </>
        )}

        {tab === "route" && (
          <>
            <label className="fp-section-label">Departure (ADEP)</label>
            <select
              className="fp-input"
              value={filter.adep}
              onChange={(e) => onFilterChange({ adep: e.target.value })}
            >
              <option value="">Any departure</option>
              {adeps.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <label className="fp-section-label">Destination (ADES)</label>
            <select
              className="fp-input"
              value={filter.ades}
              onChange={(e) => onFilterChange({ ades: e.target.value })}
            >
              <option value="">Any destination</option>
              {adess.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </>
        )}

        {tab === "airlines" && (
          <>
            <label className="fp-section-label">Airlines</label>
            {airlines.length === 0 && <p className="fp-empty">No flights yet.</p>}
            <div className="fp-airlines">
              {airlines.map((code) => {
                const on = filter.airlines.includes(code);
                return (
                  <label key={code}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) =>
                        onFilterChange({
                          airlines: e.target.checked
                            ? [...filter.airlines, code]
                            : filter.airlines.filter((c) => c !== code),
                        })
                      }
                    />
                    {code}
                  </label>
                );
              })}
            </div>
          </>
        )}
      </div>

      <div className="fp-actions">
        <button type="button" className="fp-apply" onClick={apply}>
          Apply ({matchedKeys.size})
        </button>
        <button
          type="button"
          className="fp-clear"
          onClick={() => onFilterChange(EMPTY_FILTER)}
        >
          Clear
        </button>
      </div>
      <div className="fp-actions">
        <button type="button" onClick={onShowAll}>
          Show All
        </button>
        <button type="button" onClick={onHideAll}>
          Hide All
        </button>
        <button type="button" onClick={onInvert}>
          Invert
        </button>
      </div>

      <div className="fp-results-head">
        <span>Results ({shown.length})</span>
        <input
          type="search"
          className="fp-results-search"
          value={resultQuery}
          onChange={(e) => setResultQuery(e.target.value)}
          placeholder="ICAO designator…"
          aria-label="Search results by ICAO designator"
        />
      </div>
      <ul className="fp-results">
        {shown.length === 0 && <li className="fp-empty">No matching flights.</li>}
        {shown.map(({ t, i }) => {
          const key = t.meta.flightKey;
          const hidden = hiddenKeys.has(key);
          const matched = matchedKeys.has(key);
          const active = activeIndex === i;
          return (
            <li
              key={key}
              className={`fp-row${active ? " active" : ""}${hidden ? " hidden" : ""}`}
            >
              <button
                type="button"
                className="fp-row-main"
                onClick={() => onSelectFlight(i)}
                title="Centre and follow this aircraft"
              >
                <span
                  className={`fp-dot${matched ? " match" : ""}`}
                  aria-hidden
                />
                <span className="fp-row-text">
                  <span className="fp-row-key">{t.meta.callsign}</span>
                  <span className="fp-row-route">
                    {t.meta.adep} → {t.meta.ades}
                  </span>
                </span>
              </button>
              <button
                type="button"
                className={`fp-row-eye${hidden ? " off" : ""}`}
                aria-pressed={!hidden}
                title={hidden ? "Show on map" : "Hide on map"}
                onClick={() => onToggleHidden(key)}
              >
                {hidden ? "🚫" : "👁"}
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
