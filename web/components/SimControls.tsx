"use client";

/**
 * SimControls — playback bar for the aircraft animation.
 *
 * Sits at the bottom of the map. Play/pause/reset, a draggable time
 * scrubber, and the requested speed presets (x1 = real time … x100).
 * Hidden until a trajectory has been generated.
 */

import { SIM_SPEEDS, type SimPlayback } from "@/lib/useSimPlayback";

function mmss(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export default function SimControls({ sim }: { sim: SimPlayback }) {
  if (!sim.ready) return null;

  return (
    <div className="sim">
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

      <div className="sim-speeds">
        {SIM_SPEEDS.map((s) => (
          <button
            key={s}
            className={`sim-speed${s === sim.speed ? " active" : ""}`}
            onClick={() => sim.setSpeed(s)}
            title={s === 1 ? "Real time" : `${s}× faster`}
          >
            x{s}
          </button>
        ))}
      </div>
    </div>
  );
}
