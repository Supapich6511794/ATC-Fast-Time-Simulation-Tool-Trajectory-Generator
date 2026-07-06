"use client";

/**
 * LayerOptions — the map's "Layer Options" panel (tabbed), modelled on the
 * reference ATC viewer. Tabs: Airports, SID, STAR, PBN, ILS (all fully wired
 * to their GeoJSON layers), plus Gates / Airway. (Airspace sectors moved to
 * their own toolbar dropdown beside the Layers button — see AirspaceMenu.)
 *
 * Pure presentational + local UI state (open dropdowns); all layer state is
 * lifted to MapApp so LeafletMap can render from it.
 */

import { memo, useMemo, useState } from "react";

import type { PanelAirport } from "@/lib/atcLayers";
import type { ProcedureDto } from "@/lib/api";

/** Visibility + style state for one procedure layer (SID or STAR). */
export interface ProcLayerState {
  routes: boolean;
  waypoints: boolean;
  /** Airport ICAO filter — empty Set = all airports. */
  airports: Set<string>;
  /** Procedure-name filter — empty Set = all procedures. */
  procedures: Set<string>;
  opacity: number; // 0..1
  thickness: number; // px
}

export const DEFAULT_PROC_LAYER: ProcLayerState = {
  routes: false,
  waypoints: false,
  airports: new Set(),
  procedures: new Set(),
  opacity: 0.65,
  thickness: 2,
};

type TabKey =
  | "airports"
  | "gates"
  | "sid"
  | "star"
  | "pbn"
  | "ils"
  | "airway";

/** Airway-tab layer flags (lines opacity is shared with the points). */
export interface AirwayExtra {
  /** Draw the airway designator (e.g. "W18", "V3") beside each airway. */
  labels: boolean;
  vor: boolean;
  reporting: boolean;
  opacity: number;
}

// Full layer set: Airports, Gates, SID, STAR, PBN, ILS terminal procedures,
// plus the Airway reference layers. (Airspace sectors live in their own
// toolbar dropdown beside the Layers button.)
const TABS: { key: TabKey; icon: string; label: string }[] = [
  { key: "airports", icon: "✈", label: "Airports" },
  { key: "gates", icon: "🚪", label: "Gates" },
  { key: "sid", icon: "🛫", label: "SID" },
  { key: "star", icon: "🛬", label: "STAR" },
  { key: "pbn", icon: "📍", label: "PBN" },
  { key: "ils", icon: "📡", label: "ILS" },
  { key: "airway", icon: "🛩", label: "Airway" },
];

/** One procedure-style layer's wiring (shared by SID/STAR/PBN/ILS). */
export interface ProcLayerWiring {
  state: ProcLayerState;
  onChange: (s: ProcLayerState) => void;
  airportOpts: string[];
  procOpts: string[];
  /** Cascading lookup index: airport → procedure → [transitions]. */
  index: Record<string, Record<string, string[]>>;
  /** Resolve one procedure's legs + constraints via the API. */
  lookup: (
    airport: string,
    name: string,
    transition: string | null,
  ) => Promise<ProcedureDto>;
}

interface Props {
  open: boolean;
  onClose: () => void;
  // Airports
  airportList: PanelAirport[];
  hiddenAirports: Set<string>;
  onToggleAirport: (code: string) => void;
  onShowAllAirports: () => void;
  onHideAllAirports: () => void;
  showRunways: boolean;
  onShowRunways: (on: boolean) => void;
  // Gates
  gatesOn: boolean;
  onGatesOn: (on: boolean) => void;
  // Airway reference layers
  airwaysOn: boolean;
  onAirwaysOn: (on: boolean) => void;
  airway: AirwayExtra;
  onAirwayChange: (s: AirwayExtra) => void;
  /** Highlight a looked-up procedure on the map (null clears it). */
  onProcHighlight: (data: ProcedureDto | null) => void;
  // Procedure layers
  sid: ProcLayerWiring;
  star: ProcLayerWiring;
  pbn: ProcLayerWiring;
  ils: ProcLayerWiring;
}

function LayerOptions({
  open,
  onClose,
  airportList,
  hiddenAirports,
  onToggleAirport,
  onShowAllAirports,
  onHideAllAirports,
  showRunways,
  onShowRunways,
  gatesOn,
  onGatesOn,
  airwaysOn,
  onAirwaysOn,
  airway,
  onAirwayChange,
  onProcHighlight,
  sid,
  star,
  pbn,
  ils,
}: Props) {
  const [tab, setTab] = useState<TabKey>("airports");
  if (!open) return null;

  const PROC: Record<"sid" | "star" | "pbn" | "ils", ProcLayerWiring> = {
    sid,
    star,
    pbn,
    ils,
  };

  return (
    <div className="lo-panel" role="dialog" aria-label="Layer Options">
      <div className="lo-head">
        <strong>⚙ Layer Options</strong>
        <button className="lo-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <div className="lo-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`lo-tab${tab === t.key ? " active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            <span className="lo-tab-ico" aria-hidden>
              {t.icon}
            </span>
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      <div className="lo-body">
        {tab === "airports" && (
          <AirportsTab
            airportList={airportList}
            hiddenAirports={hiddenAirports}
            onToggleAirport={onToggleAirport}
            onShowAllAirports={onShowAllAirports}
            onHideAllAirports={onHideAllAirports}
            showRunways={showRunways}
            onShowRunways={onShowRunways}
          />
        )}
        {tab === "gates" && (
          <>
            <label className="lo-check">
              <span>Show Gates</span>
              <input
                type="checkbox"
                checked={gatesOn}
                onChange={(e) => onGatesOn(e.target.checked)}
              />
            </label>
            <p className="lo-empty">
              Gates are displayed at airports when zoomed in. Toggle visibility
              above.
            </p>
          </>
        )}
        {tab === "airway" && (
          <>
            <label className="lo-check">
              <span>Airways</span>
              <input
                type="checkbox"
                checked={airwaysOn}
                onChange={(e) => onAirwaysOn(e.target.checked)}
              />
            </label>
            <label className="lo-check">
              <span>Labels</span>
              <input
                type="checkbox"
                checked={airway.labels}
                onChange={(e) =>
                  onAirwayChange({ ...airway, labels: e.target.checked })
                }
              />
            </label>
            <label className="lo-check">
              <span>VOR</span>
              <input
                type="checkbox"
                checked={airway.vor}
                onChange={(e) =>
                  onAirwayChange({ ...airway, vor: e.target.checked })
                }
              />
            </label>
            <label className="lo-check">
              <span>Reporting</span>
              <input
                type="checkbox"
                checked={airway.reporting}
                onChange={(e) =>
                  onAirwayChange({ ...airway, reporting: e.target.checked })
                }
              />
            </label>
            <Slider
              label="OPACITY"
              value={Math.round(airway.opacity * 100)}
              min={10}
              max={100}
              step={5}
              suffix="%"
              onChange={(v) => onAirwayChange({ ...airway, opacity: v / 100 })}
            />
            <p className="lo-empty">
              Reporting points (~35k) appear only when zoomed in.
            </p>
          </>
        )}
        {(tab === "sid" || tab === "star" || tab === "pbn" || tab === "ils") && (
          <ProcTab
            kind={tab.toUpperCase() as "SID" | "STAR" | "PBN" | "ILS"}
            state={PROC[tab].state}
            onChange={PROC[tab].onChange}
            airportOpts={PROC[tab].airportOpts}
            procOpts={PROC[tab].procOpts}
            index={PROC[tab].index}
            lookup={PROC[tab].lookup}
            onHighlight={onProcHighlight}
          />
        )}
      </div>
    </div>
  );
}

/* --- Airports tab --------------------------------------------------------- */

function AirportsTab({
  airportList,
  hiddenAirports,
  onToggleAirport,
  onShowAllAirports,
  onHideAllAirports,
  showRunways,
  onShowRunways,
}: Pick<
  Props,
  | "airportList"
  | "hiddenAirports"
  | "onToggleAirport"
  | "onShowAllAirports"
  | "onHideAllAirports"
  | "showRunways"
  | "onShowRunways"
>) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const needle = q.trim().toUpperCase();
    return needle
      ? airportList.filter(
          (a) =>
            a.code.includes(needle) || a.name.toUpperCase().includes(needle),
        )
      : airportList;
  }, [airportList, q]);

  const row = (a: PanelAirport) => (
    <label key={a.code} className="lo-ap-row">
      <input
        type="checkbox"
        checked={!hiddenAirports.has(a.code)}
        onChange={() => onToggleAirport(a.code)}
      />
      <span className="lo-ap-name">{a.name}</span>
      <span className="lo-ap-code">{a.code}</span>
    </label>
  );

  return (
    <>
      <label className="lo-check">
        <span>Show Runways</span>
        <input
          type="checkbox"
          checked={showRunways}
          onChange={(e) => onShowRunways(e.target.checked)}
        />
      </label>
      <input
        className="lo-search"
        placeholder="Search airports…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="lo-ap-actions">
        <button onClick={onShowAllAirports}>Show All</button>
        <button onClick={onHideAllAirports}>Hide All</button>
      </div>
      {filtered.length > 0 ? (
        <>
          <p className="lo-ap-group">Airport ({filtered.length})</p>
          {filtered.map(row)}
        </>
      ) : (
        <p className="lo-empty">No airports match “{q}”.</p>
      )}
    </>
  );
}

/* --- SID / STAR tab ------------------------------------------------------- */

function ProcTab({
  kind,
  state,
  onChange,
  airportOpts,
  procOpts,
  index,
  lookup,
  onHighlight,
}: {
  kind: "SID" | "STAR" | "PBN" | "ILS";
  state: ProcLayerState;
  onChange: (s: ProcLayerState) => void;
  airportOpts: string[];
  procOpts: string[];
  index: Record<string, Record<string, string[]>>;
  lookup: (
    airport: string,
    name: string,
    transition: string | null,
  ) => Promise<ProcedureDto>;
  onHighlight: (data: ProcedureDto | null) => void;
}) {
  const set = (patch: Partial<ProcLayerState>) =>
    onChange({ ...state, ...patch });

  // Wrapper keeps every procedure tab (SID/STAR/PBN/ILS) the same card height,
  // so PBN/ILS — which have no "look up a procedure" form — don't render as a
  // visibly shorter card than SID/STAR.
  return (
    <div className="lo-proc">
      <label className="lo-check">
        <span>{kind} Routes</span>
        <input
          type="checkbox"
          checked={state.routes}
          onChange={(e) => set({ routes: e.target.checked })}
        />
      </label>
      <label className="lo-check">
        <span>Waypoints</span>
        <input
          type="checkbox"
          checked={state.waypoints}
          onChange={(e) => set({ waypoints: e.target.checked })}
        />
      </label>

      <MultiSelect
        label="AIRPORT"
        options={airportOpts}
        selected={state.airports}
        onChange={(s) => set({ airports: s })}
      />
      <MultiSelect
        label="PROCEDURE"
        options={procOpts}
        selected={state.procedures}
        onChange={(s) => set({ procedures: s })}
      />

      <Slider
        label="OPACITY"
        value={Math.round(state.opacity * 100)}
        min={10}
        max={100}
        step={5}
        suffix="%"
        onChange={(v) => set({ opacity: v / 100 })}
      />
      <Slider
        label="LINE THICKNESS"
        value={state.thickness}
        min={1}
        max={8}
        step={1}
        suffix="PX"
        onChange={(v) => set({ thickness: v })}
      />

      {/* The direct "look up a procedure" form is only useful for the terminal
          procedures the user routes through (SID/STAR). PBN/ILS show just the
          layer + style controls. */}
      {(kind === "SID" || kind === "STAR") && (
        <ProcLookup
          kind={kind}
          index={index}
          lookup={lookup}
          onHighlight={onHighlight}
        />
      )}
    </div>
  );
}

/* --- Direct procedure lookup form (airport → procedure → transition) ------ */

const fmtAlt = (c: ProcedureDto["legs"][number]["altitude"]): string => {
  const a1 = c.alt1_ft ?? null;
  const a2 = c.alt2_ft ?? null;
  switch (c.type) {
    case "AT":
      return a1 != null ? `${a1}ft` : "";
    case "AT_OR_ABOVE":
      return a1 != null ? `≥${a1}ft` : "";
    case "AT_OR_BELOW":
      return a1 != null ? `≤${a1}ft` : "";
    case "BETWEEN":
      return `${a2 ?? "?"}–${a1 ?? "?"}ft`;
    default:
      return "";
  }
};
const fmtSpd = (c: ProcedureDto["legs"][number]["speed"]): string => {
  const s = c.speed_kt ?? null;
  if (s == null) return "";
  if (c.type === "AT_OR_ABOVE") return `≥${s}kt`;
  if (c.type === "AT") return `${s}kt`;
  return `≤${s}kt`;
};

function ProcLookup({
  kind,
  index,
  lookup,
  onHighlight,
}: {
  kind: string;
  index: Record<string, Record<string, string[]>>;
  lookup: (
    airport: string,
    name: string,
    transition: string | null,
  ) => Promise<ProcedureDto>;
  onHighlight: (data: ProcedureDto | null) => void;
}) {
  const [airport, setAirport] = useState("");
  const [proc, setProc] = useState("");
  const [trans, setTrans] = useState("");
  const [res, setRes] = useState<{
    loading?: boolean;
    data?: ProcedureDto;
    error?: string;
  } | null>(null);

  const airports = useMemo(() => Object.keys(index).sort(), [index]);
  const procs = useMemo(
    () => (airport && index[airport] ? Object.keys(index[airport]).sort() : []),
    [index, airport],
  );
  const transitions = useMemo(
    () => (airport && proc ? index[airport]?.[proc] ?? [] : []),
    [index, airport, proc],
  );

  const run = () => {
    if (!airport || !proc) return;
    setRes({ loading: true });
    lookup(airport, proc, trans || null)
      .then((data) => {
        setRes({ data });
        onHighlight(data); // light up the path on the map
      })
      .catch((e: unknown) =>
        setRes({ error: e instanceof Error ? e.message : "Lookup failed" }),
      );
  };

  return (
    <div className="lo-lookup">
      <p className="lo-label">LOOK UP A {kind}</p>
      <select
        className="lo-lk-select"
        value={airport}
        onChange={(e) => {
          setAirport(e.target.value);
          setProc("");
          setTrans("");
          setRes(null);
          onHighlight(null);
        }}
      >
        <option value="">Airport…</option>
        {airports.map((a) => (
          <option key={a} value={a}>
            {a}
          </option>
        ))}
      </select>
      <select
        className="lo-lk-select"
        value={proc}
        disabled={!airport}
        onChange={(e) => {
          setProc(e.target.value);
          setTrans("");
          setRes(null);
        }}
      >
        <option value="">Procedure…</option>
        {procs.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <select
        className="lo-lk-select"
        value={trans}
        disabled={!proc}
        onChange={(e) => setTrans(e.target.value)}
      >
        <option value="">All transitions (auto)</option>
        {transitions.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="lo-lk-btn"
        disabled={!airport || !proc}
        onClick={run}
      >
        Show legs
      </button>

      {res?.loading && <p className="lo-empty">Loading legs…</p>}
      {res?.error && <p className="lo-empty">{res.error}</p>}
      {res?.data && (
        <>
          <p className="lo-lk-sub">
            {res.data.airport}
            {res.data.runway ? ` · ${res.data.runway}` : ""}
            {res.data.transition ? ` · ${res.data.transition}` : ""}
          </p>
          <ol className="lo-lk-legs">
            {res.data.legs.map((lg, i) => (
              <li key={`${lg.seqno}-${i}`}>
                <span className="lo-lk-term">{lg.path_terminator}</span>
                <span className="lo-lk-ident">{lg.ident ?? "—"}</span>
                <span className="lo-lk-con">
                  {fmtAlt(lg.altitude)}
                  {fmtSpd(lg.speed) ? ` · ${fmtSpd(lg.speed)}` : ""}
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

/* --- shared controls ------------------------------------------------------ */

function MultiSelect({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: string[];
  selected: Set<string>;
  onChange: (s: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const text = selected.size === 0 ? "ALL" : `${selected.size} SELECTED`;

  // Type-ahead filter over the option list (case-insensitive substring).
  const filtered = useMemo(() => {
    const needle = query.trim().toUpperCase();
    return needle
      ? options.filter((o) => o.toUpperCase().includes(needle))
      : options;
  }, [options, query]);

  const toggle = () => {
    if (open) setQuery(""); // reset the search when collapsing
    setOpen((v) => !v);
  };

  const flip = (o: string) => {
    const next = new Set(selected);
    if (next.has(o)) next.delete(o);
    else next.add(o);
    onChange(next);
  };

  return (
    <div className="lo-field">
      <span className="lo-label">{label}</span>
      <div className="lo-select">
        <button className="lo-select-btn" onClick={toggle}>
          <span>{text}</span>
          <span className="lo-caret" aria-hidden>
            ▾
          </span>
        </button>
        {open && (
          <div className="lo-select-menu">
            <input
              className="lo-opt-search"
              placeholder={`Search ${label.toLowerCase()}…`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
            <button
              type="button"
              className="lo-select-all"
              onClick={() => onChange(new Set())}
            >
              All ({options.length})
            </button>
            <div className="lo-opt-list">
              {options.length === 0 && <p className="lo-empty">No options.</p>}
              {options.length > 0 && filtered.length === 0 && (
                <p className="lo-empty">No matches for “{query}”.</p>
              )}
              {filtered.map((o) => (
                <label key={o} className="lo-opt">
                  <input
                    type="checkbox"
                    checked={selected.has(o)}
                    onChange={() => flip(o)}
                  />
                  <span>{o}</span>
                </label>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="lo-field">
      <div className="lo-slider-head">
        <span className="lo-label">{label}</span>
        <span className="lo-slider-val">
          {value}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        className="lo-slider"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

export default memo(LayerOptions);
