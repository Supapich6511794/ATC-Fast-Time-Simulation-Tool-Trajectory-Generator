"use client";

/**
 * SimControls — playback bar for the aircraft animation.
 *
 * Sits at the bottom of the map. Play/pause/reset, a draggable time
 * scrubber, and the requested speed presets (x1 = real time … x100).
 * Hidden until a trajectory has been generated.
 */

import { useEffect, useRef, useState } from "react";

import type { TrajectoryResult } from "@/lib/trajectory/types";
import {
  SIM_SPEEDS,
  type SimPlayback,
  type SimSpeed,
} from "@/lib/useSimPlayback";

export type PlaybackSource = number | "all";

function mmss(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Speed picker as a drop-up menu (the bar sits at the screen bottom). */
function SpeedMenu({
  speed,
  setSpeed,
}: {
  speed: SimSpeed;
  setSpeed: (s: SimSpeed) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="sim-speed-menu" ref={ref}>
      <button
        className="sim-speed-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Playback speed"
      >
        x{speed} <span className="caret">{open ? "▾" : "▴"}</span>
      </button>
      {open && (
        <ul className="sim-speed-pop" role="listbox">
          {[...SIM_SPEEDS]
            .slice()
            .reverse()
            .map((s) => (
              <li key={s} role="option" aria-selected={s === speed}>
                <button
                  className={s === speed ? "active" : undefined}
                  onClick={() => {
                    setSpeed(s);
                    setOpen(false);
                  }}
                  title={s === 1 ? "Real time" : `${s}× faster`}
                >
                  x{s}
                  {s === 1 ? "  (real time)" : ""}
                </button>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

/** Coloured chip showing the current vertical phase. */
function PhaseChip({ phase }: { phase: "climb" | "cruise" | "descent" }) {
  const label = phase[0].toUpperCase() + phase.slice(1);
  return <span className={`sim-phase ph-${phase}`}>{label}</span>;
}

/** Live altitude readout (formatted as FL above the transition altitude). */
function AltReadout({ ft }: { ft: number | null | undefined }) {
  if (ft == null) {
    return <span className="sim-alt">—</span>;
  }
  const ftInt = Math.round(ft);
  // Show FLxxx above 10,000 ft (typical ATC transition); altitude in ft below.
  const display =
    ftInt >= 10000 ? `FL${Math.round(ftInt / 100)}` : `${ftInt.toLocaleString()} ft`;
  return (
    <span className="sim-alt" title={`${ftInt.toLocaleString()} ft AMSL`}>
      {display}
    </span>
  );
}

/** Live ground-speed / true-airspeed pill. */
function SpeedReadout({
  gsKt,
  tasKt,
}: {
  gsKt: number | null | undefined;
  tasKt: number | null | undefined;
}) {
  if (gsKt == null) return null;
  const gs = Math.round(gsKt);
  return (
    <span
      className="sim-speed"
      title={
        tasKt != null
          ? `GS ${gs} kt · TAS ${Math.round(tasKt)} kt`
          : `GS ${gs} kt`
      }
    >
      <strong>{gs}</strong> kt
    </span>
  );
}

/** Compact dropdown to pick which generated route the playback engine
 *  is bound to. Hidden when there's only one route — the dropdown
 *  isn't useful for a single-flight playback. */
function RouteSourcePicker({
  trajectories,
  playbackIdx,
  onChange,
}: {
  trajectories: TrajectoryResult[];
  playbackIdx: PlaybackSource;
  onChange: (next: PlaybackSource) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (trajectories.length < 2) return null;

  const label =
    playbackIdx === "all"
      ? `All routes`
      : `R${playbackIdx + 1}`;

  return (
    <div className="sim-route-picker" ref={ref}>
      <button
        type="button"
        className="sim-route-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Replay source"
      >
        <span className="sim-route-label">{label}</span>
        <span className="caret">{open ? "▾" : "▴"}</span>
      </button>
      {open && (
        <ul className="sim-route-menu" role="listbox">
          {trajectories.map((t, i) => (
            <li key={t.meta.flightKey} role="option" aria-selected={playbackIdx === i}>
              <button
                type="button"
                className={playbackIdx === i ? "active" : undefined}
                onClick={() => {
                  onChange(i);
                  setOpen(false);
                }}
                title={t.meta.flightKey}
              >
                <span className="sim-route-tag">R{i + 1}</span>
                <span className="sim-route-key">{t.meta.callsign}</span>
                <span className="sim-route-meta">
                  {t.stats.timeMinutes} min
                </span>
              </button>
            </li>
          ))}
          <li role="option" aria-selected={playbackIdx === "all"}>
            <button
              type="button"
              className={playbackIdx === "all" ? "active" : undefined}
              onClick={() => {
                onChange("all");
                setOpen(false);
              }}
              title="Play every route together on the longest timeline"
            >
              <span className="sim-route-tag all">∗</span>
              <span className="sim-route-key">All routes</span>
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}

interface SimControlsProps {
  sim: SimPlayback;
  trajectories?: TrajectoryResult[];
  playbackIdx?: PlaybackSource;
  onPlaybackIdxChange?: (next: PlaybackSource) => void;
}

export default function SimControls({
  sim,
  trajectories = [],
  playbackIdx = 0,
  onPlaybackIdxChange,
}: SimControlsProps) {
  if (!sim.ready) return null;
  const ac = sim.aircraft;
  const activeLabel = (() => {
    if (trajectories.length < 2) return null;
    if (playbackIdx === "all") return "Playing: all routes";
    const t = trajectories[playbackIdx as number];
    return t ? `Playing: R${(playbackIdx as number) + 1} · ${t.meta.callsign}` : null;
  })();

  return (
    <div className="sim">
      {onPlaybackIdxChange && trajectories.length >= 2 && (
        <RouteSourcePicker
          trajectories={trajectories}
          playbackIdx={playbackIdx}
          onChange={onPlaybackIdxChange}
        />
      )}

      <div className="sim-live" aria-live="polite" title={activeLabel ?? undefined}>
        <AltReadout ft={ac?.altitudeFt ?? null} />
        <SpeedReadout gsKt={ac?.gsKt ?? null} tasKt={ac?.tasKt ?? null} />
        {ac && <PhaseChip phase={ac.phase} />}
      </div>

      <button
        className="sim-btn primary"
        onClick={sim.toggle}
        aria-label={sim.playing ? "Pause" : "Play"}
        title={sim.playing ? "Pause" : "Play"}
      >
        {sim.playing ? "❚❚" : "►"}
      </button>
      <button
        className="sim-btn"
        onClick={sim.reset}
        aria-label="Reset"
        title="Reset to start"
      >
        ↺
      </button>

      <span className="sim-time">{mmss(sim.simT)}</span>

      <input
        className="sim-scrub"
        type="range"
        min={0}
        max={Math.max(1, Math.round(sim.total))}
        step={1}
        value={Math.round(sim.simT)}
        onChange={(e) => sim.seek(Number(e.target.value))}
        aria-label="Timeline"
      />

      <span className="sim-time">{mmss(sim.total)}</span>

      <SpeedMenu speed={sim.speed} setSpeed={sim.setSpeed} />
    </div>
  );
}
