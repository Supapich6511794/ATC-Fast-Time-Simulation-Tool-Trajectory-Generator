"use client";

/**
 * Sector menu — what the traffic asks of the airspace, rather than of itself.
 *
 * Both rows used to hang off the Conflicts tab, and that was the wrong home:
 * a conflict check answers "is this plan safe to fly", while these two answer
 * "how much work is each sector carrying, and how should the airspace be
 * split to carry it". The Airspace tab is not their home either — that one
 * draws the PUBLISHED sectors on the map and changes nothing about them.
 *
 * The two rows are one after the other on purpose: the sector-hour table is
 * what the dynamic planner reads, so the first row is the evidence and the
 * second is what to do about it.
 */

import { memo } from "react";

import NavIcon from "@/components/nav/NavIcon";
import type { CdrView } from "@/components/nav/types";

export interface SectorMenuProps {
  cdrView: CdrView;
  onOpenView: (v: CdrView) => void;
  /** Fired after a view is picked, so the bar can close the dropdown. */
  onPicked: () => void;
}

function SectorMenu({ cdrView, onOpenView, onPicked }: SectorMenuProps) {
  const pick = (v: CdrView) => {
    onOpenView(v);
    onPicked();
  };

  return (
    <div className="cdr-menu cdr-menu-flat">
      <button
        type="button"
        role="menuitem"
        className={cdrView === "sectorinfo" ? "active" : ""}
        onClick={() => pick("sectorinfo")}
        title="Per sector, per hour: aircraft entering, conflicts, and how many ATC resolved"
      >
        <NavIcon name="chart" size={15} />
        Sector information
      </button>
      <button
        type="button"
        role="menuitem"
        className={cdrView === "dynsector" ? "active" : ""}
        onClick={() => pick("dynsector")}
        title="Work out, hour by hour, which sectors should be band-boxed, which are over capacity and should cede airspace, and when the configuration should change"
      >
        <NavIcon name="grid" size={15} />
        Dynamic sectorisation
      </button>
    </div>
  );
}

export default memo(SectorMenu);
