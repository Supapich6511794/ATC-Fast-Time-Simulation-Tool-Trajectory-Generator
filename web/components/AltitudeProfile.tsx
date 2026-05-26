"use client";

/**
 * AltitudeProfile — compact altitude-vs-time chart for a generated flight.
 *
 * Renders the Phase 2 vertical profile (climb → cruise → descent) as a
 * filled area on an SVG canvas with dashed cruise-level + TOC/TOD
 * gridlines. Scales to its container width — no canvas/recharts dep.
 */

import { useMemo } from "react";

import type { TrajectoryResult } from "@/lib/trajectory/types";

interface Props {
  trajectory: TrajectoryResult;
  /** Width is taken from the container; height is fixed for visual rhythm. */
  height?: number;
}

const PAD_L = 36;
const PAD_R = 8;
const PAD_T = 10;
const PAD_B = 22;

export default function AltitudeProfile({ trajectory, height = 140 }: Props) {
  const samples = useMemo(() => {
    const pts = trajectory.points;
    if (pts.length === 0) return [];
    const t0 = new Date(pts[0].epoch_ts).getTime();
    return pts
      .filter((p) => p.altitude_ft != null)
      .map((p) => ({
        t: (new Date(p.epoch_ts).getTime() - t0) / 1000,
        alt: p.altitude_ft as number,
        phase: p.phase,
      }));
  }, [trajectory.points]);

  if (samples.length < 2) {
    return (
      <p className="alt-empty">
        No vertical profile (set an RFL to generate one).
      </p>
    );
  }

  const tMax = samples[samples.length - 1].t || 1;
  const altMax = Math.max(...samples.map((s) => s.alt));
  // Round the y-axis up to the nearest 5000 ft so labels are tidy.
  const yMax = Math.max(5000, Math.ceil(altMax / 5000) * 5000);

  const w = 100;
  const h = height;
  const vbW = 320;

  const x = (t: number) => PAD_L + (t / tMax) * (vbW - PAD_L - PAD_R);
  const y = (alt: number) =>
    PAD_T + (1 - alt / yMax) * (h - PAD_T - PAD_B);

  const linePath = samples
    .map((s, i) => `${i === 0 ? "M" : "L"} ${x(s.t).toFixed(2)} ${y(s.alt).toFixed(2)}`)
    .join(" ");
  const areaPath =
    linePath +
    ` L ${x(tMax).toFixed(2)} ${y(0).toFixed(2)}` +
    ` L ${x(0).toFixed(2)} ${y(0).toFixed(2)} Z`;

  const toc = trajectory.profile?.toc ?? null;
  const tod = trajectory.profile?.tod ?? null;
  const t0Iso = trajectory.points[0]?.epoch_ts;
  const t0 = t0Iso ? new Date(t0Iso).getTime() : 0;
  const tocT = toc ? (new Date(toc.epochTs).getTime() - t0) / 1000 : null;
  const todT = tod ? (new Date(tod.epochTs).getTime() - t0) / 1000 : null;

  const cruiseAlt = trajectory.stats.cruiseAltFt;
  const rflFt = trajectory.stats.rflFt;
  const fmtFL = (ft: number) => `FL${Math.round(ft / 100)}`;

  // Y-axis gridlines at 0, 25 %, 50 %, 75 %, 100 %.
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);

  return (
    <figure className="alt-fig">
      <div className="alt-head">
        <span className="alt-title">Altitude profile</span>
        {cruiseAlt != null && (
          <span className="alt-sub">
            Cruise {fmtFL(cruiseAlt)}
            {rflFt && Math.abs(cruiseAlt - rflFt) > 100
              ? ` (req. ${fmtFL(rflFt)})`
              : ""}
          </span>
        )}
      </div>
      <svg
        className="alt-svg"
        viewBox={`0 0 ${vbW} ${h}`}
        width={`${w}%`}
        height={h}
        preserveAspectRatio="none"
        role="img"
        aria-label="Altitude over time"
      >
        {/* Y-axis grid + labels */}
        {yTicks.map((tick) => (
          <g key={`y-${tick}`}>
            <line
              x1={PAD_L}
              x2={vbW - PAD_R}
              y1={y(tick)}
              y2={y(tick)}
              className="alt-grid"
            />
            <text x={4} y={y(tick) + 3} className="alt-axis">
              {tick >= 10000 ? `FL${tick / 100}` : `${tick / 1000}k`}
            </text>
          </g>
        ))}

        {/* Climb/cruise/descent area fill */}
        <path d={areaPath} className="alt-area" />
        <path d={linePath} className="alt-line" />

        {/* TOC + TOD markers */}
        {tocT != null && (
          <g>
            <line
              x1={x(tocT)}
              x2={x(tocT)}
              y1={PAD_T}
              y2={h - PAD_B}
              className="alt-marker-line"
            />
            <circle
              cx={x(tocT)}
              cy={y(toc!.altitudeFt)}
              r={3.5}
              className="alt-marker"
            />
            <text
              x={x(tocT) + 4}
              y={PAD_T + 10}
              className="alt-marker-lbl"
            >
              TOC
            </text>
          </g>
        )}
        {todT != null && (
          <g>
            <line
              x1={x(todT)}
              x2={x(todT)}
              y1={PAD_T}
              y2={h - PAD_B}
              className="alt-marker-line"
            />
            <circle
              cx={x(todT)}
              cy={y(tod!.altitudeFt)}
              r={3.5}
              className="alt-marker"
            />
            <text
              x={x(todT) - 4}
              y={PAD_T + 10}
              textAnchor="end"
              className="alt-marker-lbl"
            >
              TOD
            </text>
          </g>
        )}

        {/* X-axis baseline + time labels */}
        <line
          x1={PAD_L}
          x2={vbW - PAD_R}
          y1={h - PAD_B}
          y2={h - PAD_B}
          className="alt-axisline"
        />
        <text x={PAD_L} y={h - 6} className="alt-axis">
          0
        </text>
        <text x={vbW - PAD_R} y={h - 6} textAnchor="end" className="alt-axis">
          {Math.round(tMax / 60)} min
        </text>
      </svg>
    </figure>
  );
}
