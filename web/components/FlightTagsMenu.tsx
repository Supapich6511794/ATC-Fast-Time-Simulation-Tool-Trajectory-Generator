"use client";

/**
 * FlightTagsMenu — a "Flight Tags" button that opens a dropdown of
 * checkboxes (Callsign / FL / IAS / HDG). Each checkbox toggles whether
 * that field appears in the aircraft label drawn beside every plane on the
 * map. Toggling updates the labels in real time (the state is lifted to
 * MapApp and passed straight to LeafletMap). Closes on outside click.
 */

import { memo, useEffect, useRef, useState } from "react";
import NavIcon from "@/components/nav/NavIcon";

export interface TagFields {
  callsign: boolean;
  fl: boolean;
  ias: boolean;
  hdg: boolean;
  airspace: boolean;
}

const ROWS: { key: keyof TagFields; label: string }[] = [
  { key: "callsign", label: "Callsign" },
  { key: "fl", label: "FL" },
  { key: "ias", label: "IAS" },
  { key: "hdg", label: "HDG" },
  { key: "airspace", label: "Airspace" },
];

export interface TagFieldsPanelProps {
  fields: TagFields;
  onChange: (next: TagFields) => void;
}

/**
 * The checkbox rows alone, with no button and no popover around them — so the
 * global Tool menu can show them inline rather than keeping a second copy.
 */
export function TagFieldsBody({ fields, onChange }: TagFieldsPanelProps) {
  return (
    <>
      {ROWS.map((r) => (
        <label key={r.key} className="flight-tags-row">
          <span>{r.label}</span>
          <input
            type="checkbox"
            checked={fields[r.key]}
            onChange={(e) => onChange({ ...fields, [r.key]: e.target.checked })}
          />
        </label>
      ))}
    </>
  );
}

function FlightTagsMenu({ fields, onChange }: TagFieldsPanelProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close when clicking anywhere outside the menu.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="flight-tags" ref={ref}>
      <button
        type="button"
        className={`flight-tags-btn${open ? " open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Choose which fields show in the aircraft label"
      >
        <NavIcon name="tag" size={14} /> Flight Tags
      </button>
      {open && (
        <div className="flight-tags-panel" role="menu">
          <TagFieldsBody fields={fields} onChange={onChange} />
        </div>
      )}
    </div>
  );
}

export default memo(FlightTagsMenu);
