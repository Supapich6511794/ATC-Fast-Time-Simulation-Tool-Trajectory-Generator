"use client";

/**
 * AltitudeLegend — floating legend that reads out the altitude → colour
 * scale used to paint every generated trajectory on the map. Mounted
 * only when at least one trajectory exists so it stays out of the way
 * during route building.
 */

const STOPS = [
  { ft: 40000, label: "FL400+" },
  { ft: 30000, label: "FL300" },
  { ft: 20000, label: "FL200" },
  { ft: 10000, label: "10k ft" },
  { ft: 0, label: "0" },
];

/** Mirror of LeafletMap.altitudeColor — kept in lock-step on purpose so
 *  the swatch the user reads here is the literal line colour they see. */
function altitudeColor(altFt: number): string {
  const f = Math.max(0, Math.min(1, altFt / 40000));
  const hue = 50 + f * 160;
  const light = 72 - f * 34;
  return `hsl(${hue.toFixed(0)}, 92%, ${light.toFixed(0)}%)`;
}

export default function AltitudeLegend() {
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
        <div
          className="alt-legend-bar"
          style={{ background: `linear-gradient(to bottom, ${gradient})` }}
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
