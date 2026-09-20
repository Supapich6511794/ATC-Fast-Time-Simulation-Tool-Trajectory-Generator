"use client";

/**
 * Trajectory menu — the generated flights' profiles.
 *
 * Three destinations, all "every route at once": the overview (vertical profile
 * + summary stacked), the vertical profiles, and the trajectory summaries. It
 * drives the workspace rail (`NavView`), which is what those pages render into.
 *
 * There is deliberately no per-flight list (R1, R2, …) under them. It grew one
 * row per flight — a whole traffic sample made the dropdown a scroll box — and
 * the pages it led to are already searchable by callsign / airport pair and
 * expand one flight at a time, which is the better way to find one aircraft.
 */

import { memo } from "react";

import type { RouteSection } from "@/components/RouteResultTabs";
import type { NavView } from "@/components/nav/types";

export interface TrajectoryMenuProps {
  nav: NavView;
  onNavChange: (n: NavView) => void;
  /** Fired after any leaf is picked, so the bar can close the dropdown. */
  onPicked: () => void;
}

const ALL_VIEWS: {
  section: RouteSection | "both";
  dot: string;
  title: string;
  meta: string;
}[] = [
  { section: "both", dot: "ov", title: "Overview", meta: "vertical + summary" },
  {
    section: "vertical",
    dot: "vp",
    title: "Vertical profile",
    meta: "all routes · altitude",
  },
  {
    section: "summary",
    dot: "ts",
    title: "Trajectory summary",
    meta: "all routes · stats",
  },
];

function TrajectoryMenu({ nav, onNavChange, onPicked }: TrajectoryMenuProps) {
  const pickAll = (section: RouteSection | "both") => {
    onNavChange({ kind: "all", section });
    onPicked();
  };

  return (
    <ul className="tm-menu tm-menu-flat">
      <li className="tm-allgroup">
        <span className="tm-allgroup-label">All routes</span>
        {ALL_VIEWS.map((v) => (
          <button
            key={v.section}
            type="button"
            role="menuitem"
            className={
              nav?.kind === "all" && nav.section === v.section
                ? "active"
                : undefined
            }
            onClick={() => pickAll(v.section)}
          >
            <span className={`tm-dot ${v.dot}`} />
            <span className="tm-sub-text">
              <span className="tm-sub-title">{v.title}</span>
              <span className="tm-sub-meta">{v.meta}</span>
            </span>
          </button>
        ))}
      </li>
    </ul>
  );
}

export default memo(TrajectoryMenu);
