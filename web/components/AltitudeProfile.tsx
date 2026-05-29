"use client";

/**
 * AltitudeProfile — compact altitude-vs-time chart for a generated flight,
 * with a moving aircraft locked to the simulation clock.
 *
 * Renders the Phase 2 vertical profile (climb → cruise → descent) as a
 * filled area on an SVG canvas with dashed cruise-level + TOC/TOD
 * gridlines. The plane is driven by the SAME `simT` clock that animates the
 * map, so Play/Pause, the x1…x100 speed and the TOC/TOD crossings all stay
 * in lock-step with the map aircraft. The chart SVG is stretched with
 * preserveAspectRatio="none" (which would distort an icon drawn inside it),
 * so the plane is an absolutely-positioned overlay whose %-position maps
 * 1:1 onto the chart's viewBox.
 */

import { useMemo } from "react";

import type { TrajectoryResult } from "@/lib/trajectory/types";

interface Props {
  trajectory: TrajectoryResult;
  /** Width is taken from the container; height is fixed for visual rhythm. */
  height?: number;
  /** Current simulation clock (seconds since departure) for THIS route, or
   *  null/undefined when this route isn't the one being animated. Drives
   *  the plane so it advances with the map playback; parked at the start
   *  otherwise. */
  simT?: number | null;
}

const PAD_L = 36;
const PAD_R = 8;
const PAD_T = 10;
const PAD_B = 22;

interface AltSample {
  t: number;
  alt: number;
  phase: string;
}

/** Altitude + phase at elapsed time `tt`, linearly interpolated between the
 *  bracketing samples (matches the chart line the plane rides on). */
function altAt(samples: AltSample[], tt: number): { alt: number; phase: string } {
  if (samples.length === 0) return { alt: 0, phase: "climb" };
  if (tt <= samples[0].t) return samples[0];
  for (let i = 1; i < samples.length; i++) {
    if (tt <= samples[i].t) {
      const a = samples[i - 1];
      const b = samples[i];
      const f = (tt - a.t) / (b.t - a.t || 1);
      return {
        alt: a.alt + (b.alt - a.alt) * f,
        phase: f < 0.5 ? a.phase : b.phase,
      };
    }
  }
  return samples[samples.length - 1];
}

export default function AltitudeProfile({
  trajectory,
  height = 140,
  simT,
}: Props) {
  const samples = useMemo<AltSample[]>(() => {
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

  // Scales — guarded so they're safe to compute before the early return.
  const tMax = samples.length ? samples[samples.length - 1].t || 1 : 1;
  const altMax = samples.length ? Math.max(...samples.map((s) => s.alt)) : 0;
  // Round the y-axis up to the nearest 5000 ft so labels are tidy.
  const yMax = Math.max(5000, Math.ceil(altMax / 5000) * 5000);

  const w = 100;
  const h = height;
  const vbW = 320;

  const x = (t: number) => PAD_L + (t / tMax) * (vbW - PAD_L - PAD_R);
  const y = (alt: number) =>
    PAD_T + (1 - alt / yMax) * (h - PAD_T - PAD_B);

  // Static chart paths — memoised so the per-frame playback re-render (simT
  // changing 60×/s) doesn't rebuild the whole curve, only repositions the
  // plane.
  const { linePath, areaPath } = useMemo(() => {
    if (samples.length < 2) return { linePath: "", areaPath: "" };
    const line = samples
      .map(
        (s, i) =>
          `${i === 0 ? "M" : "L"} ${x(s.t).toFixed(2)} ${y(s.alt).toFixed(2)}`,
      )
      .join(" ");
    const area =
      line +
      ` L ${x(tMax).toFixed(2)} ${y(0).toFixed(2)}` +
      ` L ${x(0).toFixed(2)} ${y(0).toFixed(2)} Z`;
    return { linePath: line, areaPath: area };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [samples, tMax, yMax, h]);

  if (samples.length < 2) {
    return (
      <p className="alt-empty">
        No vertical profile (set an RFL to generate one).
      </p>
    );
  }

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

  // Plane position from the shared sim clock — clamped to this route's own
  // duration and parked at the start when it isn't being animated. Because
  // the profile's sample times share the sim clock's t0 (first point), the
  // plane lands exactly on the TOC/TOD markers when the map aircraft does.
  const planeT = Math.max(0, Math.min(tMax, simT ?? 0));
  const planePos = altAt(samples, planeT);
  const planeLeft = (x(planeT) / vbW) * 100;
  const planeTop = (y(planePos.alt) / h) * 100;
  // Material "flight" icon points north; +90° faces it along travel (east),
  // and a ± nudge lifts the nose in climb / drops it in descent.
  const planeRot =
    90 +
    (planePos.phase === "climb" ? -28 : planePos.phase === "descent" ? 28 : 0);

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
      <div className="alt-canvas">
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
              <text x={x(tocT) + 4} y={PAD_T + 10} className="alt-marker-lbl">
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

        {/* Aircraft — position/rotation driven by the shared sim clock so
            it tracks the map playback exactly (play / pause / speed). */}
        <span
          className="alt-plane"
          aria-hidden="true"
          style={{
            left: `${planeLeft}%`,
            top: `${planeTop}%`,
            transform: `translate(-50%, -50%) rotate(${planeRot}deg)`,
          }}
        >
          <svg viewBox="0 0 24 24">
            <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z" />
          </svg>
        </span>
      </div>
    </figure>
  );
}
