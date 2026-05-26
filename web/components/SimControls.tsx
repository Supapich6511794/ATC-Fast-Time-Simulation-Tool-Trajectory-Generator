"use client";

/**
 * SimControls — playback bar for the aircraft animation.
 *
 * Sits at the bottom of the map. Play/pause/reset, a draggable time
 * scrubber, and the requested speed presets (x1 = real time … x100).
 * Hidden until a trajectory has been generated.
 */

import { useEffect, useRef, useState } from "react";

import {
  SIM_SPEEDS,
  type SimPlayback,
  type SimSpeed,
} from "@/lib/useSimPlayback";

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

export default function SimControls({ sim }: { sim: SimPlayback }) {
  if (!sim.ready) return null;
  const ac = sim.aircraft;

  return (
    <div className="sim">
      <div className="sim-live" aria-live="polite">
        <AltReadout ft={ac?.altitudeFt ?? null} />
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
