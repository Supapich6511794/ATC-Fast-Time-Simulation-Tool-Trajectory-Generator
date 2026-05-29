"use client";

/**
 * NavToolbar — floating tool menu at the top-left of the map.
 *
 * Three top-level actions: Generator (opens the flight-plan form),
 * Generated ▾ (cascading multi-level menu of generated routes →
 * Vertical / Trajectory leaves), and Download (opens the export modal).
 *
 * The dropdown uses pure CSS :hover to reveal submenus, matching the
 * cascading desktop-menu pattern (single horizontal track, sub-menus
 * fly out to the right of the parent item).
 */

import { useEffect, useRef, useState } from "react";

import type { RouteSection } from "@/components/RouteResultTabs";
import type { TrajectoryResult } from "@/lib/trajectory/types";

import type { DownloadInfo } from "@/components/DownloadModal";

export type NavView =
  | { kind: "generator" }
  /** "All routes" view. `section` chooses what each route card shows:
   *  "both" = Vertical + Summary stacked (the landing/overview),
   *  "vertical" = every route's Vertical profile only,
   *  "summary" = every route's Trajectory summary only. All three are
   *  searchable by callsign / ADEP-ADES / route. */
  | { kind: "all"; section: RouteSection | "both" }
  | { kind: "route"; routeIdx: number; section: RouteSection }
  | null;

interface Props {
  nav: NavView;
  onNavChange: (n: NavView) => void;
  results: TrajectoryResult[];
  downloads: DownloadInfo[];
  generatedOpen: boolean;
  onGeneratedOpenChange: (open: boolean) => void;
  onOpenDownload: () => void;
}

export default function NavToolbar({
  nav,
  onNavChange,
  results,
  downloads,
  generatedOpen,
  onGeneratedOpenChange,
  onOpenDownload,
}: Props) {
  const ddRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const generatedCount = results.length;
  /** Click-to-expand state: only one route's leaf-menu is open at a
   *  time. Far more reliable than CSS hover-cascade — and works the
   *  same on touch devices. */
  const [expanded, setExpanded] = useState<number | null>(null);
  /** Mobile: the three top-level items collapse behind a ☰ button; this
   *  toggles the vertical menu. Ignored on desktop (CSS shows the items
   *  inline regardless). */
  const [mobileOpen, setMobileOpen] = useState(false);

  // Click outside the Generated dropdown closes it.
  useEffect(() => {
    if (!generatedOpen) return;
    const onDown = (e: MouseEvent) => {
      if (ddRef.current && !ddRef.current.contains(e.target as Node)) {
        onGeneratedOpenChange(false);
        setExpanded(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [generatedOpen, onGeneratedOpenChange]);

  // Click outside the whole nav closes the mobile menu.
  useEffect(() => {
    if (!mobileOpen) return;
    const onDown = (e: MouseEvent) => {
      if (navRef.current && !navRef.current.contains(e.target as Node)) {
        setMobileOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [mobileOpen]);

  // Pre-expand the currently-viewed route when the menu opens.
  useEffect(() => {
    if (!generatedOpen) return;
    if (nav?.kind === "route") setExpanded(nav.routeIdx);
  }, [generatedOpen, nav]);

  const handleLeafClick = (routeIdx: number, section: RouteSection) => {
    onNavChange({ kind: "route", routeIdx, section });
    onGeneratedOpenChange(false);
    setExpanded(null);
    setMobileOpen(false);
  };

  const handleAllClick = (section: RouteSection | "both") => {
    onNavChange({ kind: "all", section });
    onGeneratedOpenChange(false);
    setExpanded(null);
    setMobileOpen(false);
  };

  return (
    <nav
      className={`tool-menu${mobileOpen ? " mobile-open" : ""}`}
      aria-label="Application menu"
      ref={navRef}
    >
      {/* Mobile-only ☰ — collapses the three items into a vertical menu.
          Hidden on desktop (CSS), where the items render inline. */}
      <button
        className="tool-hamburger"
        onClick={() => setMobileOpen((v) => !v)}
        aria-label="Toggle menu"
        aria-expanded={mobileOpen}
      >
        <span className="tool-ico">{mobileOpen ? "✕" : "☰"}</span>
        <span className="tool-hamburger-label">Menu</span>
        {generatedCount > 0 && (
          <span className="tool-count">{generatedCount}</span>
        )}
      </button>

      <div className={`tool-items${mobileOpen ? " open" : ""}`}>
      <button
        className={`tool-item${nav?.kind === "generator" ? " active" : ""}`}
        onClick={() => {
          onNavChange({ kind: "generator" });
          onGeneratedOpenChange(false);
          setMobileOpen(false);
        }}
        title="Edit the flight plan"
      >
        <span className="tool-ico">⌨</span>
        <span className="tool-label">Generator</span>
      </button>

      <div
        className={`tool-item tool-dd${
          nav?.kind === "route" || nav?.kind === "all" ? " active" : ""
        }${generatedOpen ? " open" : ""}`}
        ref={ddRef}
      >
        <button
          className="tool-dd-trigger"
          onClick={() => {
            // Clicking the chip both navigates to the "all routes"
            // overview AND toggles the dropdown. The dropdown is a
            // shortcut for jumping to an all-routes section or a
            // specific route+section.
            if (generatedCount > 0) onNavChange({ kind: "all", section: "both" });
            onGeneratedOpenChange(!generatedOpen);
          }}
          disabled={generatedCount === 0}
          aria-haspopup="menu"
          aria-expanded={generatedOpen}
          title={
            generatedCount === 0
              ? "Generate a trajectory first"
              : "Show generated routes"
          }
        >
          <span className="tool-ico">✈</span>
          <span className="tool-label">Route Profile</span>
          {generatedCount > 0 && (
            <span className="tool-count">{generatedCount}</span>
          )}
          <span className="tool-caret">▾</span>
        </button>

        {generatedOpen && generatedCount > 0 && (
          <ul className="tm-menu" role="menu">
            {/* All-routes section views — every route at once, searchable. */}
            <li className="tm-allgroup">
              <span className="tm-allgroup-label">All routes</span>
              <button
                type="button"
                role="menuitem"
                className={
                  nav?.kind === "all" && nav.section === "both"
                    ? "active"
                    : undefined
                }
                onClick={() => handleAllClick("both")}
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
                onClick={() => handleAllClick("vertical")}
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
                onClick={() => handleAllClick("summary")}
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
                  className={`tm-item has-sub${
                    isCurrent ? " current" : ""
                  }${isExpanded ? " expanded" : ""}`}
                  role="menuitem"
                  aria-haspopup="menu"
                  aria-expanded={isExpanded}
                >
                  {/* Tooltip on hover surfaces the full route string; the
                      label itself stays compact even with long routes. */}
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
                          onClick={() => handleLeafClick(i, "vertical")}
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
                          onClick={() => handleLeafClick(i, "summary")}
                        >
                          <span className="tm-dot ts" />
                          <span className="tm-sub-text">
                            <span className="tm-sub-title">Trajectory summary</span>
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
        )}
      </div>

      <button
        className="tool-item"
        onClick={() => {
          onOpenDownload();
          setMobileOpen(false);
        }}
        disabled={generatedCount === 0}
        title={
          generatedCount === 0
            ? "Generate a trajectory first"
            : "Open download dialog"
        }
      >
        <span className="tool-ico">⬇</span>
        <span className="tool-label">Download</span>
      </button>
      </div>
    </nav>
  );
}
