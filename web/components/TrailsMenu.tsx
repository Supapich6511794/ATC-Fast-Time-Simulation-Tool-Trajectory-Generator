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
import NavIcon from "@/components/nav/NavIcon";
import { DEFAULT_COLOR_BY, type ColorBy } from "@/lib/displayColors";

export interface TrailOpts {
  /** Draw the route path behind each aircraft. */
  show: boolean;
  /** Tint the path by altitude (flight level) instead of a flat colour. Only
   *  meaningful while `colorBy` is "altitude": by aircraft type the path is
   *  one flat colour per type whatever this says. */
  flColor: boolean;
  /** Tool menu → "Display by": what colours the aircraft symbol AND its trail. */
  colorBy: ColorBy;
  /** Trail window in flight-time seconds: 0 = "No decay" = the whole route
   *  drawn statically; a positive value = a recent trail of that length that
   *  follows the aircraft as it flies. */
  decaySec: number;
  /** Stroke weight (px) of the coloured trail line; the dark casing is drawn
   *  2 px wider. Lower = narrower lines. */
  weight: number;
}

export const DEFAULT_TRAIL_OPTS: TrailOpts = {
  show: true,
  flColor: true,
  colorBy: DEFAULT_COLOR_BY,
  decaySec: 0,
  weight: 2,
};

/** Trail-thickness bounds (px) for the slider. */
export const TRAIL_WEIGHT_MIN = 1;
export const TRAIL_WEIGHT_MAX = 6;

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

const CHECKS: { key: "show" | "flColor"; label: string }[] = [
  { key: "show", label: "Show Trails" },
  { key: "flColor", label: "FL Color Trails" },
];

export interface TrailsPanelProps {
  opts: TrailOpts;
  onChange: (next: TrailOpts) => void;
  /** Whether any aircraft tag field is shown (drives the Flight Tags row). */
  flightTagsOn: boolean;
  onFlightTagsToggle: (on: boolean) => void;
}

/**
 * The rows alone, with no button and no popover around them — so the global
 * Tool menu can show the same controls inline without a second copy of them.
 */
export function TrailsPanelBody({
  opts,
  onChange,
  flightTagsOn,
  onFlightTagsToggle,
}: TrailsPanelProps) {
  return (
    <>
      {CHECKS.map((r) => {
        // By aircraft type the trail is one flat colour per type, so a
        // flight-level gradient has nothing to switch: say why it is greyed
        // out rather than letting the box be ticked to no effect.
        const inert = r.key === "flColor" && opts.colorBy === "type";
        return (
          <label
            key={r.key}
            className={`flight-tags-row${inert ? " inert" : ""}`}
            title={
              inert
                ? "Trails follow Display by → Aircraft type. Switch to Altitude to colour them by flight level."
                : undefined
            }
          >
            <input
              type="checkbox"
              checked={opts[r.key]}
              disabled={inert}
              onChange={(e) => onChange({ ...opts, [r.key]: e.target.checked })}
            />
            <span>{r.label}</span>
          </label>
        );
      })}
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
      <div className="flight-tags-decay">
        <span className="flight-tags-decay-label">
          Trail Thickness ({opts.weight.toFixed(1)} px)
        </span>
        <input
          type="range"
          min={TRAIL_WEIGHT_MIN}
          max={TRAIL_WEIGHT_MAX}
          step={0.5}
          value={opts.weight}
          onChange={(e) => onChange({ ...opts, weight: Number(e.target.value) })}
          aria-label="Trail thickness"
        />
      </div>
    </>
  );
}

function TrailsMenu({
  opts,
  onChange,
  flightTagsOn,
  onFlightTagsToggle,
}: TrailsPanelProps) {
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
        <NavIcon name="trails" size={14} /> Trails
      </button>
      {open && (
        <div className="flight-tags-panel" role="menu">
          <TrailsPanelBody
            opts={opts}
            onChange={onChange}
            flightTagsOn={flightTagsOn}
            onFlightTagsToggle={onFlightTagsToggle}
          />
        </div>
      )}
    </div>
  );
}

export default memo(TrailsMenu);
