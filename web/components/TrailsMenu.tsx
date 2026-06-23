"use client";

/**
 * TrailsMenu — a "Trails" button (mirrors FlightTagsMenu) that opens a
 * dropdown controlling how each generated route's path is drawn, matching the
 * flight-animation viewer:
 *   • Show Trails      — draw the route path at all (off = aircraft only).
 *   • FL Color Trails  — colour the path by flight level (altitude); off draws
 *                        a single solid colour per route.
 *   • Full Trails      — draw the whole route; off draws only a recent trail
 *                        behind the aircraft, limited by Trail Decay.
 *   • Flight Tags      — show the label beside each aircraft (callsign · FL).
 *   • Trail Decay      — how far back (in flight-time) the recent trail runs
 *                        when Full Trails is off (No decay = the whole flown
 *                        path so far).
 * State is lifted to MapApp and passed to LeafletMap, so toggling re-styles
 * the lines live. Closes on outside click.
 */

import { memo, useEffect, useRef, useState } from "react";

export interface TrailOpts {
  /** Draw the route path behind each aircraft. */
  show: boolean;
  /** Tint the path by altitude (flight level) instead of a flat colour. */
  flColor: boolean;
  /** Draw the whole route; off = only the recent trail (see `decaySec`). */
  full: boolean;
  /** Recent-trail window in flight-time seconds (0 = no decay = whole flown
   *  path). Ignored when `full` is on. */
  decaySec: number;
}

export const DEFAULT_TRAIL_OPTS: TrailOpts = {
  show: true,
  flColor: true,
  full: true,
  decaySec: 3600,
};

/** Trail-decay choices (label → seconds; 0 = no decay). */
const DECAY_OPTS: { label: string; sec: number }[] = [
  { label: "1 min", sec: 60 },
  { label: "2 min", sec: 120 },
  { label: "5 min", sec: 300 },
  { label: "10 min", sec: 600 },
  { label: "15 min", sec: 900 },
  { label: "30 min", sec: 1800 },
  { label: "1 hour", sec: 3600 },
  { label: "No decay", sec: 0 },
];

const CHECKS: { key: "show" | "flColor" | "full"; label: string }[] = [
  { key: "show", label: "Show Trails" },
  { key: "flColor", label: "FL Color Trails" },
  { key: "full", label: "Full Trails" },
];

function TrailsMenu({
  opts,
  onChange,
  flightTagsOn,
  onFlightTagsToggle,
}: {
  opts: TrailOpts;
  onChange: (next: TrailOpts) => void;
  /** Whether any aircraft tag field is shown (drives the Flight Tags row). */
  flightTagsOn: boolean;
  onFlightTagsToggle: (on: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="flight-tags" ref={ref}>
      <button
        type="button"
        className={`flight-tags-btn${open ? " open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="How the route trail is drawn"
      >
        <span aria-hidden>🪶</span> Trails
      </button>
      {open && (
        <div className="flight-tags-panel" role="menu">
          {CHECKS.map((r) => (
            <label key={r.key} className="flight-tags-row">
              <input
                type="checkbox"
                checked={opts[r.key]}
                onChange={(e) =>
                  onChange({ ...opts, [r.key]: e.target.checked })
                }
              />
              <span>{r.label}</span>
            </label>
          ))}
          <label className="flight-tags-row">
            <input
              type="checkbox"
              checked={flightTagsOn}
              onChange={(e) => onFlightTagsToggle(e.target.checked)}
            />
            <span>Flight Tags</span>
          </label>
          <div className="flight-tags-decay">
            <span className="flight-tags-decay-label">Trail Decay</span>
            <select
              value={opts.decaySec}
              disabled={opts.full}
              onChange={(e) =>
                onChange({ ...opts, decaySec: Number(e.target.value) })
              }
            >
              {DECAY_OPTS.map((d) => (
                <option key={d.sec} value={d.sec}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(TrailsMenu);
