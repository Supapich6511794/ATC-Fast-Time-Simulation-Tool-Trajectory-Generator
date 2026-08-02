"use client";

/**
 * ConflictLayer — the on-map depiction of the SELECTED conflict, rendered as
 * children of the Leaflet map. It draws both aircraft's predicted (constant-
 * velocity) tracks, a marker at each aircraft's CPA position, the closest-
 * approach segment between them, and a live countdown-to-LoS label at the CPA.
 *
 * All other (unselected) conflicts get a faint CPA tick so the controller can
 * still see where the rest of the traffic picture is tightening, without the
 * full predicted-track clutter.
 *
 * Geometry is pure (lib/cdr/predict); this component only maps it to
 * react-leaflet primitives + severity colours.
 */

import L from "leaflet";
import { Fragment } from "react";
import { CircleMarker, Marker, Polyline, Tooltip } from "react-leaflet";

import { fmtCountdown, fmtNm } from "@/lib/cdr/format";
import { conflictGeometry, type LatLon } from "@/lib/cdr/predict";
import type { TrackedConflict } from "@/lib/cdr/lifecycle";
import type { CdrAircraft, Severity } from "@/lib/cdr/types";

interface Props {
  conflicts: TrackedConflict[];
  traffic: CdrAircraft[];
  selectedId: string | null;
  nameOf: (id: string) => string;
}

const SEV_COLOR: Record<Severity, string> = {
  LOS: "#ef4444",
  STCA: "#f59e0b",
  MTCD: "#eab308",
};

const toLL = (p: LatLon): L.LatLngExpression => [p.lat, p.lon];

/** A small CPA pin: a hollow diamond dot as a divIcon so it reads distinctly
 *  from the round aircraft/waypoint markers. */
function cpaLabel(text: string, color: string): L.DivIcon {
  return L.divIcon({
    className: "cdr-cpa-badge",
    iconSize: [0, 0],
    iconAnchor: [0, 0],
    html:
      `<span class="cdr-cpa-dot" style="background:${color}"></span>` +
      `<span class="cdr-cpa-text" style="color:${color}">${text}</span>`,
  });
}

export default function ConflictLayer({
  conflicts,
  traffic,
  selectedId,
  nameOf,
}: Props) {
  const byId = new Map(traffic.map((a) => [a.id, a]));

  return (
    <>
      {conflicts.map((c) => {
        const g = conflictGeometry(c, byId);
        if (!g) return null;
        const color = SEV_COLOR[c.severity];
        const selected = c.id === selectedId;

        if (!selected) {
          // Faint CPA tick only — keep the map readable when many conflicts.
          return (
            <CircleMarker
              key={`cdr-cpa-${c.id}`}
              center={toLL(g.cpaMid)}
              radius={3}
              interactive={false}
              pathOptions={{
                color,
                weight: 1,
                fillColor: color,
                fillOpacity: 0.5,
                opacity: 0.5,
              }}
            />
          );
        }

        const label = `${fmtCountdown(c.tToLosSec)} · ${fmtNm(c.dCpa)}`;
        return (
          <Fragment key={`cdr-sel-${c.id}`}>
            {/* Predicted tracks — dashed, in the severity colour. */}
            <Polyline
              positions={g.aTrack.map(toLL)}
              interactive={false}
              pathOptions={{ color, weight: 2, opacity: 0.9, dashArray: "6 5" }}
            />
            <Polyline
              positions={g.bTrack.map(toLL)}
              interactive={false}
              pathOptions={{ color, weight: 2, opacity: 0.9, dashArray: "6 5" }}
            />

            {/* Rings on the two aircraft in conflict (current positions). */}
            <CircleMarker
              center={toLL(g.aNow)}
              radius={9}
              interactive={false}
              pathOptions={{ color, weight: 2, fill: false, opacity: 0.95 }}
            />
            <CircleMarker
              center={toLL(g.bNow)}
              radius={9}
              interactive={false}
              pathOptions={{ color, weight: 2, fill: false, opacity: 0.95 }}
            />

            {/* Closest-approach segment between the two CPA positions. */}
            <Polyline
              positions={[toLL(g.aCpa), toLL(g.bCpa)]}
              interactive={false}
              pathOptions={{ color, weight: 1.5, opacity: 0.8 }}
            />
            <CircleMarker
              center={toLL(g.aCpa)}
              radius={3.5}
              interactive={false}
              pathOptions={{ color, weight: 1, fillColor: color, fillOpacity: 0.9 }}
            />
            <CircleMarker
              center={toLL(g.bCpa)}
              radius={3.5}
              interactive={false}
              pathOptions={{ color, weight: 1, fillColor: color, fillOpacity: 0.9 }}
            >
              <Tooltip direction="top" offset={[0, -4]} className="cdr-cpa-tip">
                {nameOf(c.a)} ↔ {nameOf(c.b)}
              </Tooltip>
            </CircleMarker>

            {/* Live countdown-to-LoS label pinned at the CPA midpoint. */}
            <Marker
              position={toLL(g.cpaMid)}
              interactive={false}
              icon={cpaLabel(label, color)}
            />
          </Fragment>
        );
      })}
    </>
  );
}
