"use client";

/**
 * AltitudeLegend — floating legend that reads out the altitude → colour
 * scale used to paint every generated trajectory on the map. Mounted
 * only when at least one trajectory exists so it stays out of the way
 * during route building.
 */

import { memo } from "react";

// The SAME function the map paints with (lib/displayColors), so the swatch read
// here is the literal colour drawn on the line and the aircraft.
import { altitudeColor } from "@/lib/displayColors";

const STOPS = [
  { ft: 40000, label: "FL400+" },
  { ft: 30000, label: "FL300" },
  { ft: 20000, label: "FL200" },
  { ft: 10000, label: "10k ft" },
  { ft: 0, label: "0" },
];

// Memoised: it takes no props, so it never needs to re-render with the
// parent (MapApp re-renders ~60×/sec while the aircraft animation plays).
function AltitudeLegend() {
  // Build a vertical gradient that matches altitudeColor() sampled at 12
  // stops — visually identical to what the polylines render.
  const gradient = Array.from({ length: 12 }, (_, i) => {
    const f = i / 11;
    const ft = (1 - f) * 40000;
    return `${altitudeColor(ft)} ${(f * 100).toFixed(0)}%`;
  }).join(", ");

  return (
    <div className="alt-legend" aria-label="Altitude colour scale">
      <span className="alt-legend-title">Altitude</span>
      <div className="alt-legend-body">
        {/* backgroundImage, NOT the `background` shorthand: the shorthand resets
            every background longhand to its initial value, and at inline
            specificity that would beat the `background-origin` / `-repeat` the
            stylesheet sets to keep the gradient off the border. */}
        <div
          className="alt-legend-bar"
          style={{ backgroundImage: `linear-gradient(to bottom, ${gradient})` }}
        />
        <ul className="alt-legend-ticks">
          {STOPS.map((s) => (
            <li key={s.ft}>{s.label}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default memo(AltitudeLegend);
