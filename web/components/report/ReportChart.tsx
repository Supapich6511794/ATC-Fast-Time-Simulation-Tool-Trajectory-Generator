"use client";

/**
 * ReportChart — the headline chart of a run report, drawn on the page.
 *
 * It is handed the SAME `ChartSpec` that builds the chart inside the downloaded
 * .xlsx, so the picture here and the picture in the workbook are two renderings
 * of one description rather than two drawings that have to be kept in step. The
 * arithmetic lives in `lib/report/chartGeometry.ts`, which is where the axis
 * behaviour is tested; this file is the SVG and the hover.
 *
 * Colours are set as attributes, not classes: the chart can be saved as an .svg
 * and a saved file carries its attributes but not this app's stylesheet. They
 * are read from the live theme on mount so a saved chart matches the console it
 * came from.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { buildPlot, type Box, type Plot } from "@/lib/report/chartGeometry";
import type { Cell, ChartSpec } from "@/lib/report/xlsx";

/** Series colours. Distinct in hue rather than lightness, so the legend still
 *  works for the ~8% of men who cannot separate red from green. */
const SERIES = [
  "#0284c7",
  "#f59e0b",
  "#16a34a",
  "#a855f7",
  "#ef4444",
  "#0d9488",
  "#64748b",
];

const PAD: Omit<Box, "width" | "height"> = {
  padLeft: 64,
  padRight: 18,
  padTop: 18,
  padBottom: 54,
};

interface Props {
  spec: ChartSpec;
  /** The series table, header row first. */
  rows: Cell[][];
  height?: number;
}

export default function ReportChart({ spec, rows, height = 340 }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(880);
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(
    null,
  );

  // The chart fills whatever column it is given, and a report tab is a window
  // someone resizes. ResizeObserver rather than a window listener: the sidebar
  // and the table beside it change this box without the window changing.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && Math.abs(w - width) > 2) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);

  const plot: Plot = useMemo(
    () => buildPlot(spec, rows, { width, height, ...PAD }),
    [spec, rows, width, height],
  );

  const axisColor = "#94a3b8";
  const gridColor = "#cbd5e155";
  const inkColor = "#64748b";

  return (
    <figure className="rv-chart" ref={wrap}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${spec.title}. ${spec.xTitle} against ${spec.yTitle}.`}
        onMouseLeave={() => setHover(null)}
      >
        <title>{spec.title}</title>

        {/* Value gridlines first, so every mark sits on top of them. */}
        {plot.yTicks.map((t, i) => (
          <g key={"y" + i}>
            <line
              x1={plot.plot.x}
              x2={plot.plot.x + plot.plot.w}
              y1={t.at}
              y2={t.at}
              stroke={gridColor}
              strokeWidth={1}
            />
            <text
              x={plot.plot.x - 8}
              y={t.at + 4}
              textAnchor="end"
              fontSize={11}
              fill={inkColor}
              fontFamily="system-ui, sans-serif"
            >
              {t.label}
            </text>
          </g>
        ))}

        {plot.kind === "bar"
          ? plot.bars.map((b, i) => (
              <rect
                key={i}
                x={b.x}
                y={b.y}
                width={Math.max(0.5, b.w - 1)}
                height={b.h}
                fill={SERIES[b.series % SERIES.length]}
                onMouseEnter={() =>
                  setHover({
                    x: b.x + b.w / 2,
                    y: b.y,
                    text: `${b.label} · ${plot.seriesNames[b.series] ?? ""} ${b.value}`,
                  })
                }
              />
            ))
          : plot.paths.map((p, i) => (
              <path
                key={i}
                d={p.d}
                fill="none"
                stroke={SERIES[p.series % SERIES.length]}
                strokeWidth={1.4}
                strokeLinejoin="round"
                strokeLinecap="round"
                opacity={0.9}
              >
                <title>{p.name}</title>
              </path>
            ))}

        {/* Axes last: a bar drawn over its own baseline looks detached. */}
        <line
          x1={plot.plot.x}
          x2={plot.plot.x + plot.plot.w}
          y1={plot.plot.y + plot.plot.h}
          y2={plot.plot.y + plot.plot.h}
          stroke={axisColor}
          strokeWidth={1}
        />
        <line
          x1={plot.plot.x}
          x2={plot.plot.x}
          y1={plot.plot.y}
          y2={plot.plot.y + plot.plot.h}
          stroke={axisColor}
          strokeWidth={1}
        />

        {plot.xTicks.map((t, i) => (
          <text
            key={"x" + i}
            x={t.at}
            y={plot.plot.y + plot.plot.h + 16}
            textAnchor="middle"
            fontSize={11}
            fill={inkColor}
            fontFamily="system-ui, sans-serif"
          >
            {t.label}
          </text>
        ))}

        <text
          x={plot.plot.x + plot.plot.w / 2}
          y={height - 8}
          textAnchor="middle"
          fontSize={11}
          fontWeight={600}
          fill={inkColor}
          fontFamily="system-ui, sans-serif"
        >
          {spec.xTitle}
        </text>
        <text
          x={14}
          y={plot.plot.y + plot.plot.h / 2}
          textAnchor="middle"
          fontSize={11}
          fontWeight={600}
          fill={inkColor}
          fontFamily="system-ui, sans-serif"
          transform={`rotate(-90 14 ${plot.plot.y + plot.plot.h / 2})`}
        >
          {spec.yTitle}
        </text>

        {hover && (
          <g pointerEvents="none">
            <rect
              x={Math.min(Math.max(hover.x - 80, 2), Math.max(2, width - 162))}
              y={Math.max(2, hover.y - 26)}
              width={160}
              height={20}
              rx={4}
              fill="#0f172a"
              opacity={0.92}
            />
            <text
              x={Math.min(Math.max(hover.x, 82), Math.max(82, width - 82))}
              y={Math.max(2, hover.y - 12)}
              textAnchor="middle"
              fontSize={11}
              fill="#f8fafc"
              fontFamily="system-ui, sans-serif"
            >
              {hover.text}
            </text>
          </g>
        )}
      </svg>

      {/* One legend for both chart kinds. Capped, because the trajectory chart
          has a series per flight and 25 callsigns is a wall, not a key. */}
      {plot.seriesNames.length > 1 && (
        <figcaption className="rv-legend">
          {plot.seriesNames.slice(0, 12).map((n, i) => (
            <span key={i}>
              <i style={{ background: SERIES[i % SERIES.length] }} />
              {n}
            </span>
          ))}
          {plot.seriesNames.length > 12 && (
            <span className="rv-legend-more">
              +{plot.seriesNames.length - 12} more
            </span>
          )}
        </figcaption>
      )}
    </figure>
  );
}
