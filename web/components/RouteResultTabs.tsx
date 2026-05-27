"use client";

/**
 * RouteResultTabs — per-route result block with two leaf sections:
 *   1. Vertical profile  (the altitude chart + TOC/TOD readouts)
 *   2. Trajectory summary (Phase 1 horizontal stats)
 *
 * Download is intentionally NOT a per-route view — it lives behind the
 * global "⬇ Download" button which opens a multi-route popup that lets
 * the user pick any subset of routes × formats. Keeping it global avoids
 * the user having to navigate per route to grab files.
 *
 * Mounted once per generated flight inside GeneratorPanel. The active
 * leaf can be either controlled internally (own tab strip) or driven by
 * a parent via `forceSection` — that's what the top-level "Generated ▾"
 * dropdown uses to navigate straight to e.g. "R1 → Trajectory summary".
 */

import { useEffect, useState } from "react";

import AltitudeProfile from "@/components/AltitudeProfile";
import type { TrajectoryResult } from "@/lib/trajectory/types";

export type RouteSection = "vertical" | "summary";

interface DownloadLinks {
  callsign: string;
  flightKey: string;
  route: string;
  gpkg: string;
  csv: string;
  geojson: string;
}

interface Props {
  trajectory: TrajectoryResult;
  download: DownloadLinks;
  /** 1-based route index in the multi-route list, or null when single. */
  routeIndex: number | null;
  onRemove: () => void;
  /** When set, hide the internal tab strip and render that section
   *  exclusively. Used when a parent navigation drives selection. */
  forceSection?: RouteSection;
  /** Render **both** sections one above the other instead of a tab
   *  strip. The "all routes" landing page uses this. */
  stacked?: boolean;
}

const TABS: { id: RouteSection; label: string }[] = [
  { id: "vertical", label: "Vertical profile" },
  { id: "summary", label: "Trajectory summary" },
];

/** Format an altitude as FL (above 10k) or feet (below). */
function fmtAlt(ft: number | null | undefined): string {
  if (ft == null) return "—";
  return ft >= 10000
    ? `FL${Math.round(ft / 100)}`
    : `${Math.round(ft).toLocaleString()} ft`;
}

export default function RouteResultTabs({
  trajectory,
  download,
  routeIndex,
  onRemove,
  forceSection,
  stacked,
}: Props) {
  const [tab, setTab] = useState<RouteSection>(forceSection ?? "vertical");
  // Keep the rendered tab in sync when the parent drives the choice.
  useEffect(() => {
    if (forceSection) setTab(forceSection);
  }, [forceSection]);
  const { stats, profile, meta } = trajectory;

  // Stacked mode shows both sections one above the other; the tab
  // strip is hidden and the boolean below gates per-section rendering.
  const showVertical = stacked || tab === "vertical";
  const showSummary = stacked || tab === "summary";

  return (
    <div className="gen-dl-route">
      <div className="gen-dl-head">
        <p className="gen-key">
          {routeIndex != null && (
            <span className="gen-route-tag">R{routeIndex}</span>
          )}
          {download.flightKey}
        </p>
        <button
          type="button"
          className="gen-dl-close"
          onClick={onRemove}
          title="Remove this flight from the map and downloads"
          aria-label={`Remove ${download.flightKey}`}
        >
          ✕
        </button>
      </div>
      <p className="gen-dl-rt" title={download.route}>
        ↳ {download.route}
      </p>

      {forceSection == null && !stacked && (
        <div className="rt-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? "active" : undefined}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      <div className="rt-tabpanel" role="tabpanel">
        {showVertical && (
          <>
            {stacked && (
              <h4 className="rt-section-title">Vertical profile</h4>
            )}
            <AltitudeProfile trajectory={trajectory} />
            <dl className="rt-vp-stats">
              <div>
                <dt>Cruise</dt>
                <dd>{fmtAlt(stats.cruiseAltFt)}</dd>
              </div>
              <div>
                <dt>Requested FL</dt>
                <dd>{fmtAlt(stats.rflFt)}</dd>
              </div>
              <div>
                <dt>TOC</dt>
                <dd>{fmtAlt(profile.toc?.altitudeFt ?? null)}</dd>
              </div>
              <div>
                <dt>TOD</dt>
                <dd>{fmtAlt(profile.tod?.altitudeFt ?? null)}</dd>
              </div>
            </dl>
          </>
        )}

        {showVertical && showSummary && <hr className="rt-section-sep" />}

        {showSummary && (
          <div className="rt-summary">
            {stacked && (
              <h4 className="rt-section-title">Trajectory summary</h4>
            )}
            {/* Big-number 2×2 grid: the four headline stats first, so a
                quick glance answers "how big is this flight". */}
            <dl className="rt-summary-grid">
              <div>
                <dt>Waypoints</dt>
                <dd>{stats.waypointCount}</dd>
              </div>
              <div>
                <dt>Points</dt>
                <dd>{stats.pointCount.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Distance</dt>
                <dd>
                  {stats.distanceNm}
                  <span className="rt-summary-unit"> NM</span>
                </dd>
              </div>
              <div>
                <dt>Flight time</dt>
                <dd>
                  {stats.timeMinutes}
                  <span className="rt-summary-unit"> min</span>
                </dd>
              </div>
            </dl>

            {/* Secondary metadata strip — single column, smaller text. */}
            <dl className="rt-summary-meta">
              <div>
                <dt>Callsign</dt>
                <dd>{meta.callsign}</dd>
              </div>
              <div>
                <dt>Aircraft</dt>
                <dd>{meta.aircraftType}</dd>
              </div>
              <div>
                <dt>Route</dt>
                <dd>
                  {meta.adep} <span className="rt-arrow">→</span> {meta.ades}
                </dd>
              </div>
            </dl>
          </div>
        )}

      </div>
    </div>
  );
}
