"use client";

/**
 * Trajectory menu — the generated flights' profiles.
 *
 * Lifted out of the old "Route Profile" toolbar dropdown unchanged: the
 * all-routes sections first, then one expandable row per flight whose leaves
 * are that flight's Vertical profile and Trajectory summary. It still drives
 * the workspace rail (`NavView`), which is what those pages render into.
 */

import { memo, useEffect, useState } from "react";

import type { DownloadInfo } from "@/components/DownloadModal";
import type { RouteSection } from "@/components/RouteResultTabs";
import type { NavView } from "@/components/nav/types";

export interface TrajectoryMenuProps {
  nav: NavView;
  onNavChange: (n: NavView) => void;
  downloads: DownloadInfo[];
  /** Fired after any leaf is picked, so the bar can close the dropdown. */
  onPicked: () => void;
}

function TrajectoryMenu({
  nav,
  onNavChange,
  downloads,
  onPicked,
}: TrajectoryMenuProps) {
  /** Click-to-expand: only one flight's leaf menu is open at a time. Far more
   *  reliable than a CSS hover cascade — and works the same on touch. */
  const [expanded, setExpanded] = useState<number | null>(null);

  // Pre-expand the flight currently being viewed.
  useEffect(() => {
    if (nav?.kind === "route") setExpanded(nav.routeIdx);
  }, [nav]);

  const pickAll = (section: RouteSection | "both") => {
    onNavChange({ kind: "all", section });
    setExpanded(null);
    onPicked();
  };

  const pickRoute = (routeIdx: number, section: RouteSection) => {
    onNavChange({ kind: "route", routeIdx, section });
    setExpanded(null);
    onPicked();
  };

  return (
    <ul className="tm-menu tm-menu-flat">
      {/* All-routes section views — every route at once, searchable. */}
      <li className="tm-allgroup">
        <span className="tm-allgroup-label">All routes</span>
        <button
          type="button"
          role="menuitem"
          className={
            nav?.kind === "all" && nav.section === "both" ? "active" : undefined
          }
          onClick={() => pickAll("both")}
        >
          <span className="tm-dot ov" />
          <span className="tm-sub-text">
            <span className="tm-sub-title">Overview</span>
            <span className="tm-sub-meta">vertical + summary</span>
          </span>
        </button>
        <button
          type="button"
          role="menuitem"
          className={
            nav?.kind === "all" && nav.section === "vertical"
              ? "active"
              : undefined
          }
          onClick={() => pickAll("vertical")}
        >
          <span className="tm-dot vp" />
          <span className="tm-sub-text">
            <span className="tm-sub-title">Vertical profile</span>
            <span className="tm-sub-meta">all routes · altitude</span>
          </span>
        </button>
        <button
          type="button"
          role="menuitem"
          className={
            nav?.kind === "all" && nav.section === "summary"
              ? "active"
              : undefined
          }
          onClick={() => pickAll("summary")}
        >
          <span className="tm-dot ts" />
          <span className="tm-sub-text">
            <span className="tm-sub-title">Trajectory summary</span>
            <span className="tm-sub-meta">all routes · stats</span>
          </span>
        </button>
      </li>
      <li className="tm-allgroup-sep" aria-hidden="true" />
      {/* Per-route list — capped to ~4 rows; the rest scroll. */}
      <li className="tm-routes-wrap">
        <ul className="tm-routes" role="menu">
          {downloads.map((d, i) => {
            const isCurrent = nav?.kind === "route" && nav.routeIdx === i;
            const isExpanded = expanded === i;
            return (
              <li
                key={d.flightKey}
                className={`tm-item has-sub${isCurrent ? " current" : ""}${
                  isExpanded ? " expanded" : ""
                }`}
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={isExpanded}
              >
                {/* Tooltip on hover surfaces the full route string; the label
                    itself stays compact even with long routes. */}
                <button
                  type="button"
                  className="tm-row"
                  title={`Route: ${d.route}`}
                  onClick={() => setExpanded(isExpanded ? null : i)}
                >
                  <span className="tm-tag">R{i + 1}</span>
                  <span className="tm-key">{d.flightKey}</span>
                  <span className="tm-arrow">{isExpanded ? "▾" : "▸"}</span>
                </button>

                {isExpanded && (
                  <ul className="tm-submenu" role="menu">
                    <li className="tm-sub-route" title={d.route}>
                      <span className="tm-sub-label">Route</span>
                      <span className="tm-sub-routestr">{d.route}</span>
                    </li>
                    <li className="tm-sub-divider" />
                    <li>
                      <button
                        type="button"
                        role="menuitem"
                        className={
                          isCurrent &&
                          nav?.kind === "route" &&
                          nav.section === "vertical"
                            ? "active"
                            : undefined
                        }
                        onClick={() => pickRoute(i, "vertical")}
                      >
                        <span className="tm-dot vp" />
                        <span className="tm-sub-text">
                          <span className="tm-sub-title">Vertical profile</span>
                          <span className="tm-sub-meta">altitude graph</span>
                        </span>
                      </button>
                    </li>
                    <li>
                      <button
                        type="button"
                        role="menuitem"
                        className={
                          isCurrent &&
                          nav?.kind === "route" &&
                          nav.section === "summary"
                            ? "active"
                            : undefined
                        }
                        onClick={() => pickRoute(i, "summary")}
                      >
                        <span className="tm-dot ts" />
                        <span className="tm-sub-text">
                          <span className="tm-sub-title">
                            Trajectory summary
                          </span>
                          <span className="tm-sub-meta">
                            points · distance · time
                          </span>
                        </span>
                      </button>
                    </li>
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </li>
    </ul>
  );
}

export default memo(TrajectoryMenu);
