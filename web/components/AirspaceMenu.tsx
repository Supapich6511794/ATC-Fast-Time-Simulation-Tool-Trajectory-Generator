"use client";

/**
 * AirspaceMenu — a top-toolbar "Airspace" button (sits beside Layers) that
 * opens a dropdown of the airspace sector layers (BACC sectors/subsectors,
 * CTR, TMA, PDR). Moved out of the Layer Options panel so the sector toggles
 * are one click away from the map. State is lifted to MapApp (the `sectorsOn`
 * flags) and flows to LeafletMap, so toggling shows/hides the polygons live.
 * Closes on outside click.
 */

import { memo, useEffect, useRef } from "react";

import { SECTORS, type SectorKey } from "@/lib/geojson";

function AirspaceMenu({
  open,
  onOpenChange,
  sectorsOn,
  onToggleSector,
}: {
  /** Controlled open state — lifted to MapOverlay so opening this dropdown
   *  closes the Layers one (and vice-versa). */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sectorsOn: Record<SectorKey, boolean>;
  onToggleSector: (key: SectorKey) => void;
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

  const active = SECTORS.some((s) => sectorsOn[s.key]);

  return (
    <div className="ov-layers-wrap" ref={ref}>
      <button
        type="button"
        className={`ov-chip${open || active ? " active" : ""}`}
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        title="Airspace sectors"
      >
        ▱ Airspace
      </button>

      {open && (
        <div className="ov-airspace" role="menu">
          {SECTORS.map((s) => (
            <label key={s.key} className="ov-air-item">
              <input
                type="checkbox"
                checked={sectorsOn[s.key]}
                onChange={() => onToggleSector(s.key)}
              />
              <span
                aria-hidden
                style={{
                  display: "inline-block",
                  width: 10,
                  height: 10,
                  marginRight: 2,
                  borderRadius: 2,
                  background: s.color,
                  verticalAlign: "middle",
                }}
              />
              <span>{s.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export default memo(AirspaceMenu);
