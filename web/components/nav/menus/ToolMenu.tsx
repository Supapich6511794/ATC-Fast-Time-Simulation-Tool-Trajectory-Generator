"use client";

/**
 * Tool menu — what the map DRAWS about the flights already on it.
 *
 * "Display by" is the one control that is always on show: a two-way choice
 * (Aircraft type | Altitude) that recolours the aircraft symbol and its trail
 * together. Trails and Flight Tags are the existing map-toolbar panels, shown
 * inline here rather than re-implemented — both files export their rows
 * separately from the button that used to open them — but folded shut: each
 * has half a dozen rows, and a menu that opens onto all of them at once buries
 * the few things a controller reaches for. Open state lives in the fold, which
 * unmounts with the dropdown, so every visit starts closed.
 */

import { memo, useId, useState, type ReactNode } from "react";

import { TagFieldsBody, type TagFields } from "@/components/FlightTagsMenu";
import { TrailsPanelBody, type TrailOpts } from "@/components/TrailsMenu";
import NavIcon, { type NavIconName } from "@/components/nav/NavIcon";
import type { ColorBy } from "@/lib/displayColors";

export interface ToolMenuProps {
  trailOpts: TrailOpts;
  onTrailOpts: (next: TrailOpts) => void;
  tagFields: TagFields;
  onTagFields: (next: TagFields) => void;
  /** Any tag field on — the Trails panel's "Flight Tags" master row. */
  flightTagsOn: boolean;
  onFlightTagsToggle: (on: boolean) => void;
  /** Top-of-Climb / Top-of-Descent pins. */
  profilePinsOn: boolean;
  onProfilePins: () => void;
  /** Measure tool — click two aircraft to read the distance between them. */
  measureOn: boolean;
  onMeasure: () => void;
  /** How many of the two aircraft a measurement needs have been picked. */
  measurePicked: number;
  filterOpen: boolean;
  onFilter: () => void;
}

const COLOR_BY: { id: ColorBy; label: string; hint: string }[] = [
  {
    id: "type",
    label: "Aircraft type",
    hint: "One colour per aircraft type — symbol and trail",
  },
  {
    id: "altitude",
    label: "Altitude",
    hint: "Colour by flight level — symbol and trail",
  },
];

/** The tag fields that are on, in the order the label shows them. */
function tagSummary(t: TagFields): string {
  const on = [
    t.callsign && "Callsign",
    t.fl && "FL",
    t.ias && "IAS",
    t.hdg && "HDG",
    t.airspace && "Airspace",
  ].filter(Boolean);
  return on.length > 0 ? on.join(" · ") : "off";
}

/** A dropdown block that opens on demand. */
function Fold({
  icon,
  title,
  summary,
  children,
}: {
  icon: NavIconName;
  title: string;
  /** What is set inside, so a closed fold still says something. */
  summary: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <div className="mnav-group mnav-fold">
      <button
        type="button"
        className={`mnav-row mnav-fold-head${open ? " active" : ""}`}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="mnav-row-ico">
          <NavIcon name={icon} size={15} />
        </span>
        <span className="mnav-row-text">
          <span className="mnav-row-title">{title}</span>
          <span className="mnav-row-meta">{summary}</span>
        </span>
        <span className="mnav-row-state" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div id={bodyId} className="mnav-fold-body">
          {children}
        </div>
      )}
    </div>
  );
}

function ToolMenu({
  trailOpts,
  onTrailOpts,
  tagFields,
  onTagFields,
  flightTagsOn,
  onFlightTagsToggle,
  profilePinsOn,
  onProfilePins,
  measureOn,
  onMeasure,
  measurePicked,
  filterOpen,
  onFilter,
}: ToolMenuProps) {
  return (
    <>
      <div className="mnav-group">
        <span className="mnav-group-label">Display by</span>
        <div className="mnav-seg" role="radiogroup" aria-label="Display by">
          {COLOR_BY.map((o) => (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={trailOpts.colorBy === o.id}
              className={trailOpts.colorBy === o.id ? "active" : undefined}
              title={o.hint}
              onClick={() => onTrailOpts({ ...trailOpts, colorBy: o.id })}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mnav-sep" role="separator" />

      <Fold
        icon="trails"
        title="Trails"
        summary={trailOpts.show ? "shown" : "hidden"}
      >
        <TrailsPanelBody
          opts={trailOpts}
          onChange={onTrailOpts}
          flightTagsOn={flightTagsOn}
          onFlightTagsToggle={onFlightTagsToggle}
        />
      </Fold>

      <Fold icon="tag" title="Flight Tags" summary={tagSummary(tagFields)}>
        <TagFieldsBody fields={tagFields} onChange={onTagFields} />
      </Fold>

      <div className="mnav-sep" role="separator" />

      <div className="mnav-group">
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={profilePinsOn}
          className={`mnav-row${profilePinsOn ? " active" : ""}`}
          onClick={onProfilePins}
          title={
            profilePinsOn
              ? "Hide the TOC/TOD markers"
              : "Add the Top-of-Climb / Top-of-Descent markers"
          }
        >
          <span className="mnav-row-ico">
            <NavIcon name="profile" size={15} />
          </span>
          <span className="mnav-row-text">
            <span className="mnav-row-title">TOC / TOD</span>
            <span className="mnav-row-meta">
              top of climb · top of descent
            </span>
          </span>
          <span className="mnav-row-state">{profilePinsOn ? "ON" : "OFF"}</span>
        </button>

        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={measureOn}
          className={`mnav-row${measureOn ? " active" : ""}`}
          onClick={onMeasure}
          title="Click two aircraft on the map to read the distance between them"
        >
          <span className="mnav-row-ico">
            <NavIcon name="measure" size={15} />
          </span>
          <span className="mnav-row-text">
            <span className="mnav-row-title">Measure</span>
            <span className="mnav-row-meta">
              {measureOn
                ? measurePicked === 0
                  ? "click the first aircraft"
                  : measurePicked === 1
                    ? "click the second aircraft"
                    : "click another aircraft to re-measure"
                : "distance between two aircraft"}
            </span>
          </span>
          <span className="mnav-row-state">{measureOn ? "ON" : "OFF"}</span>
        </button>

        <button
          type="button"
          role="menuitem"
          className={`mnav-row${filterOpen ? " active" : ""}`}
          onClick={onFilter}
          title="Filter which flights are drawn"
        >
          <span className="mnav-row-ico">
            <NavIcon name="filter" size={15} />
          </span>
          <span className="mnav-row-text">
            <span className="mnav-row-title">Filter</span>
            <span className="mnav-row-meta">by type, level, airport…</span>
          </span>
        </button>
      </div>
    </>
  );
}

export default memo(ToolMenu);
