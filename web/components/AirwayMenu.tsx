"use client";

/**
 * AirwayMenu — a top-toolbar "Airway" button (mirrors the reference ATC
 * viewer) that opens a dropdown of the airway reference layers:
 *   • Labels     — the airway designator (e.g. "W18", "V3") beside each airway.
 *   • VOR        — VOR navaid points.
 *   • Reporting  — reporting/intersection points (heavy; zoom-gated on the map).
 *   • Opacity    — shared opacity for the lines, labels and points.
 * (The airway lines themselves toggle from the Layers panel's "Airway
 * network".) State is lifted to MapApp (the `AirwayExtra` flags) and flows to
 * LeafletMap, so toggling re-styles the map live. Closes on outside click.
 */

import { memo, useEffect, useRef } from "react";

import type { AirwayExtra } from "@/components/LayerOptions";

function AirwayMenu({
  open,
  onOpenChange,
  airway,
  onAirwayChange,
}: {
  /** Controlled open state — lifted to MapOverlay so opening this dropdown
   *  closes the Layers one (and vice-versa). */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  airway: AirwayExtra;
  onAirwayChange: (s: AirwayExtra) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onOpenChange(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, onOpenChange]);

  const active = airway.labels || airway.vor || airway.reporting;

  return (
    <div className="ov-layers-wrap" ref={ref}>
      <button
        type="button"
        className={`ov-chip${open || active ? " active" : ""}`}
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        title="Airway reference layers"
      >
        🛩 Airway
      </button>

      {open && (
        <div className="ov-airspace" role="menu">
          <label className="ov-air-item">
            <input
              type="checkbox"
              checked={airway.labels}
              onChange={(e) =>
                onAirwayChange({ ...airway, labels: e.target.checked })
              }
            />
            <span>Labels</span>
          </label>
          <label className="ov-air-item">
            <input
              type="checkbox"
              checked={airway.vor}
              onChange={(e) =>
                onAirwayChange({ ...airway, vor: e.target.checked })
              }
            />
            <span>VOR</span>
          </label>
          <label className="ov-air-item">
            <input
              type="checkbox"
              checked={airway.reporting}
              onChange={(e) =>
                onAirwayChange({ ...airway, reporting: e.target.checked })
              }
            />
            <span>Reporting</span>
          </label>

          <div className="aw-opacity">
            <div className="aw-opacity-head">
              <span>Opacity</span>
              <span className="aw-opacity-val">
                {Math.round(airway.opacity * 100)}%
              </span>
            </div>
            <input
              type="range"
              className="lo-slider"
              min={10}
              max={100}
              step={5}
              value={Math.round(airway.opacity * 100)}
              onChange={(e) =>
                onAirwayChange({
                  ...airway,
                  opacity: Number(e.target.value) / 100,
                })
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(AirwayMenu);
