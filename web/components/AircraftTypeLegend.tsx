"use client";

/**
 * AircraftTypeLegend — the key for Tool → Display by → Aircraft type.
 *
 * Stands where the altitude scale stands (same bottom-left card) while the map
 * is displayed by type, and lists only the types actually on the map, so it
 * reads as "these are the aircraft here", not as the whole fleet table. The
 * swatch is `aircraftColor`, the very function the map paints the symbol and
 * trail with.
 */

import { memo, useMemo } from "react";

import { typeLegendEntries } from "@/lib/displayColors";

interface Props {
  /** One aircraft-type code per flight on the map (duplicates welcome — the
   *  count beside each swatch is how many of that type there are). */
  types: ReadonlyArray<string | undefined>;
}

function AircraftTypeLegend({ types }: Props) {
  const entries = useMemo(() => typeLegendEntries(types), [types]);
  if (entries.length === 0) return null;
  return (
    <div className="alt-legend" aria-label="Aircraft type colour key">
      <span className="alt-legend-title">Aircraft type</span>
      <ul className="alt-legend-types">
        {entries.map((e) => (
          <li key={e.type}>
            <span
              className="alt-legend-swatch"
              style={{ backgroundColor: e.color }}
              aria-hidden="true"
            />
            {e.type}
            <span className="alt-legend-count">{e.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default memo(AircraftTypeLegend);
