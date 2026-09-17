"use client";

/**
 * Layers menu — a way INTO the Layer Options panel, not a second copy of it.
 *
 * Every row opens the same panel on the tab it names, so the map layers keep
 * one implementation (LayerOptions) and the bar keeps one job: getting you
 * there in a click.
 */

import { memo } from "react";

import { LAYER_TABS, type LayerTabKey } from "@/components/LayerOptions";
import NavIcon from "@/components/nav/NavIcon";

export interface LayersMenuProps {
  onOpenLayers: (tab: LayerTabKey) => void;
  onPicked: () => void;
}

function LayersMenu({ onOpenLayers, onPicked }: LayersMenuProps) {
  return (
    <div className="mnav-group">
      {LAYER_TABS.map((t) => (
        <button
          key={t.key}
          type="button"
          role="menuitem"
          className="mnav-row"
          onClick={() => {
            onOpenLayers(t.key);
            onPicked();
          }}
        >
          <span className="mnav-row-ico">
            <NavIcon name={t.icon} size={15} />
          </span>
          <span className="mnav-row-text">
            <span className="mnav-row-title">{t.label}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

export default memo(LayersMenu);
