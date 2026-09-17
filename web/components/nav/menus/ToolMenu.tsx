"use client";

/**
 * Tool menu — what the map DRAWS about the flights already on it.
 *
 * Trails and Flight Tags are the existing map-toolbar panels, shown inline
 * here rather than re-implemented: both files export their rows separately
 * from the button that used to open them.
 */

import { memo } from "react";

import { TagFieldsBody, type TagFields } from "@/components/FlightTagsMenu";
import { TrailsPanelBody, type TrailOpts } from "@/components/TrailsMenu";
import NavIcon from "@/components/nav/NavIcon";

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
        <span className="mnav-group-label">Trails</span>
        <TrailsPanelBody
          opts={trailOpts}
          onChange={onTrailOpts}
          flightTagsOn={flightTagsOn}
          onFlightTagsToggle={onFlightTagsToggle}
        />
      </div>

      <div className="mnav-sep" role="separator" />

      <div className="mnav-group">
        <span className="mnav-group-label">Flight Tags</span>
        <TagFieldsBody fields={tagFields} onChange={onTagFields} />
      </div>

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
