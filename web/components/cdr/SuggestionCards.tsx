"use client";

/**
 * SuggestionCards — the ranked resolution advisories for the selected conflict.
 * Each card states the instruction ("Turn right 15°"), the outcome (d_CPA
 * before → after), and the cost (extra track miles / time, or the level
 * change), with Preview (draw the modified path dashed, uncommitted) and Apply
 * (write the maneuver into the flight) actions.
 *
 * Suggestions are recomputed every tick upstream, so what's shown is always
 * validated against the current traffic picture; a card that no longer clears
 * simply disappears on the next pass.
 */

import { fmtNm } from "@/lib/cdr/format";
import type { Maneuver } from "@/lib/cdr/types";

interface Props {
  suggestions: Maneuver[];
  nameOf: (id: string) => string;
  /** Index of the maneuver currently previewed on the map, or null. */
  previewIdx: number | null;
  onPreview: (idx: number | null) => void;
  onApply: (idx: number) => void;
}

const TYPE_LABEL: Record<Maneuver["type"], string> = {
  heading: "HDG",
  flightlevel: "LVL",
  route: "DCT",
  speed: "SPD",
  hold: "HOLD",
};

/** Compact cost string per maneuver kind. */
function costLabel(m: Maneuver): string {
  if (m.type === "flightlevel") {
    const sign = m.altChangeFt > 0 ? "+" : "−";
    return `${sign}${Math.abs(m.altChangeFt)} ft`;
  }
  const parts: string[] = [];
  if (Math.abs(m.extraDistanceNm) >= 0.1) {
    const sign = m.extraDistanceNm >= 0 ? "+" : "−";
    parts.push(`${sign}${Math.abs(m.extraDistanceNm).toFixed(1)} NM`);
  }
  if (Math.abs(m.extraTimeSec) >= 5) {
    const sign = m.extraTimeSec >= 0 ? "+" : "−";
    parts.push(`${sign}${(Math.abs(m.extraTimeSec) / 60).toFixed(1)} min`);
  }
  return parts.length ? parts.join(", ") : "negligible";
}

export default function SuggestionCards({
  suggestions,
  nameOf,
  previewIdx,
  onPreview,
  onApply,
}: Props) {
  if (suggestions.length === 0) {
    return (
      <p className="cdr-adv-empty">
        No clear resolution found within the maneuver envelope.
      </p>
    );
  }
  return (
    <div className="cdr-adv">
      <p className="cdr-adv-head">Resolution advisories</p>
      {suggestions.map((m, i) => {
        const previewing = previewIdx === i;
        return (
          <div key={`${m.target}-${m.type}-${m.value}`} className="cdr-card">
            <div className="cdr-card-top">
              <span className={`cdr-card-type type-${m.type}`}>
                {TYPE_LABEL[m.type]}
              </span>
              <span className="cdr-card-instr">
                <strong>{nameOf(m.target)}</strong> {m.instruction}
              </span>
            </div>
            <div className="cdr-card-meta">
              <span className="cdr-card-outcome">
                d_CPA {fmtNm(m.origDCpaNm)} → <strong>{fmtNm(m.newDCpaNm)}</strong>
              </span>
              <span className="cdr-card-cost">{costLabel(m)}</span>
            </div>
            <div className="cdr-card-actions">
              <button
                type="button"
                className={`cdr-card-btn${previewing ? " active" : ""}`}
                onClick={() => onPreview(previewing ? null : i)}
                aria-pressed={previewing}
              >
                {previewing ? "Hide preview" : "Preview"}
              </button>
              <button
                type="button"
                className="cdr-card-btn apply"
                onClick={() => onApply(i)}
              >
                Apply
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
