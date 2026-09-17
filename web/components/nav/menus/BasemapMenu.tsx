"use client";

/**
 * Basemap menu — which tiles the map is drawn on.
 *
 * A one-of-N choice, so the picked row carries the accent fill; the rest of
 * the bar's menus are toggles and stay neutral.
 */

import { memo } from "react";

import NavIcon, { type NavIconName } from "@/components/nav/NavIcon";
import type { Basemap } from "@/lib/mapPrefs";

const OPTIONS: {
  key: Basemap;
  icon: NavIconName;
  label: string;
  meta: string;
}[] = [
  { key: "dark", icon: "moon", label: "Dark", meta: "night radar canvas" },
  { key: "light", icon: "sun", label: "Light", meta: "pale canvas + labels" },
  { key: "streets", icon: "street", label: "Street", meta: "OpenStreetMap" },
  { key: "satellite", icon: "satellite", label: "Satellite", meta: "Esri imagery" },
];

export interface BasemapMenuProps {
  basemap: Basemap;
  onBasemap: (b: Basemap) => void;
  onPicked: () => void;
}

function BasemapMenu({ basemap, onBasemap, onPicked }: BasemapMenuProps) {
  return (
    <div className="mnav-group">
      {OPTIONS.map((o) => (
        <button
          key={o.key}
          type="button"
          role="menuitemradio"
          aria-checked={basemap === o.key}
          className={`mnav-row${basemap === o.key ? " picked" : ""}`}
          onClick={() => {
            onBasemap(o.key);
            onPicked();
          }}
        >
          <span className="mnav-row-ico">
            <NavIcon name={o.icon} size={15} />
          </span>
          <span className="mnav-row-text">
            <span className="mnav-row-title">{o.label}</span>
            <span className="mnav-row-meta">{o.meta}</span>
          </span>
          {basemap === o.key && (
            <span className="mnav-row-state" aria-hidden>
              ●
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

export default memo(BasemapMenu);
