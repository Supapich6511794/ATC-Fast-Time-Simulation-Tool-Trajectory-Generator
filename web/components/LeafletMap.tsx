"use client";

/**
 * LeafletMap — browser-only react-leaflet map (loaded via dynamic ssr:false).
 *
 *  - Basemap   : streets / satellite / dark tiles (switchable).
 *  - FIR        : optional Flight Information Region polygons.
 *  - Airways    : faint reference network from the real airway file.
 *  - Trajectory : the generated path + route/start/end markers.
 *  - Aircraft   : animated icon driven by the playback hook.
 *
 * The aircraft updates ~60×/sec while playing. Every static layer (FIR,
 * airways, waypoints, the trajectory path/markers) is memoised so those
 * subtrees keep a stable element identity and React skips reconciling them
 * on each animation frame — only the aircraft marker re-renders.
 */

import L from "leaflet";
import {
  Fragment,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  CircleMarker,
  GeoJSON,
  MapContainer,
  Marker,
  Polygon,
  Polyline,
  Popup,
  TileLayer,
  Tooltip,
  useMap,
  useMapEvents,
} from "react-leaflet";

import { BASEMAPS, type Basemap } from "@/lib/mapPrefs";
import type { PreviewPoint } from "@/lib/routePreview";
import type { TrajectoryResult } from "@/lib/trajectory/types";
import { aircraftAt, toSamples } from "@/lib/useSimPlayback";
import type {
  AirwayCollection,
  FirCollection,
  ProcedureLineCollection,
  ProcedureWaypointCollection,
  Waypoint,
} from "@/lib/types";
import type { AirportOption } from "@/lib/aip";
import type { GateCollection, RunwayPoint } from "@/lib/atcLayers";
import {
  SECTORS,
  type AirwayPointCollection,
  type SectorCollection,
  type SectorKey,
} from "@/lib/geojson";
import type { ProcLayerState } from "@/components/LayerOptions";
import type { ProcedureDto } from "@/lib/api";

interface Props {
  basemap: Basemap;
  airways: AirwayCollection | null;
  /** Airway reference-point overlays (the Airway tab): VOR navaids and
   *  reporting points, plus a shared opacity for the airway lines + points.
   *  Reporting is large (~35 k pts) so it only draws when zoomed in.
   *  `labels`, when set, carries the airway collection whose designators
   *  ("W18", "V3", …) are drawn — one label per airway. */
  airwayPts?: {
    vor?: AirwayPointCollection | null;
    reporting?: AirwayPointCollection | null;
    labels?: AirwayCollection | null;
    opacity?: number;
  };
  /** Reference waypoint layer (all fixes), or null to hide. */
  waypoints: Waypoint[] | null;
  fir: FirCollection | null;
  /** Airspace sector overlays (BACC / subsector / CTR / TMA / PDR), each
   *  present only when its layer is toggled on. */
  sectors?: Partial<Record<SectorKey, SectorCollection | null>>;
  /** SID/STAR procedure tracks + fixes (full collections; visibility,
   *  filtering and styling are driven by `sid`/`star`). */
  sidLines?: ProcedureLineCollection | null;
  starLines?: ProcedureLineCollection | null;
  sidWpts?: ProcedureWaypointCollection | null;
  starWpts?: ProcedureWaypointCollection | null;
  pbnLines?: ProcedureLineCollection | null;
  pbnWpts?: ProcedureWaypointCollection | null;
  ilsLines?: ProcedureLineCollection | null;
  ilsWpts?: ProcedureWaypointCollection | null;
  /** Layer Options state per procedure layer (routes/waypoints on,
   *  airport+procedure filters, opacity, line thickness). */
  sid?: ProcLayerState;
  star?: ProcLayerState;
  pbn?: ProcLayerState;
  ils?: ProcLayerState;
  /** Aerodromes for the Airports layer — every one not in `hiddenAirports`
   *  is drawn as a pin. */
  airports?: AirportOption[];
  /** Airport ICAOs hidden from the map (unchecked in the panel). */
  hiddenAirports?: Set<string>;
  /** Gate points (shown when non-null) and runway threshold points. */
  gates?: GateCollection | null;
  runways?: RunwayPoint[] | null;
  /** A procedure resolved via the lookup form / map click — drawn as a
   *  bright highlighted path with labelled fixes. */
  highlightProc?: ProcedureDto | null;
  /** Fired when a SID/STAR track is clicked — the parent fetches that
   *  procedure's coded legs + constraints from the procedures API. */
  onProcedureClick?: (sel: ProcedureSelection) => void;
  /** One or more generated routes, all shown/animated together. */
  trajectories: TrajectoryResult[];
  /** Trail drawing (the Trails menu): `showTrails` off draws the aircraft
   *  without its path line; `flColorTrails` off draws a flat per-route colour
   *  instead of the altitude (flight-level) gradient. `trailDecaySec` 0 = the
   *  whole route drawn statically; a positive value draws only a recent trail
   *  of that many flight-time seconds following the aircraft. */
  showTrails?: boolean;
  flColorTrails?: boolean;
  trailDecaySec?: number;
  /** Stroke weight (px) of the coloured route/trail line; the dark casing is
   *  drawn 2 px wider. Set from the Trails menu's thickness slider. */
  trailWeight?: number;
  /** Show the TOC/TOD vertical-profile pins. Off by default so a fresh
   *  generation shows just the lines; the map toolbar's "TOC/TOD" button
   *  turns them on. */
  showProfilePins?: boolean;
  /** flightKeys whose route *line* is hidden on the map. The aircraft icon
   *  stays visible, so the user can declutter the lines mid-simulation while
   *  still tracking each flight. */
  hiddenKeys?: Set<string>;
  /** Live (pre-Generate) route previews from the GeneratorPanel — one
   *  entry per route the user has typed/picked/queued. Each is drawn as
   *  a faint dashed line in a distinct colour, with permanent ident
   *  labels so the user can see what they're about to fly while still
   *  editing. */
  previewRoutes?: PreviewPoint[][];
  /** Top-center aircraft-type filter (case-insensitive substring). When
   *  set, only matching flights are drawn — both their route line and the
   *  aircraft icon. Empty string shows every flight. */
  typeFilter?: string;
  /** Which fields the aircraft tag (the label beside each plane) shows,
   *  controlled by the Flight Tags menu. Updates the labels in real time. */
  tagFields?: { callsign: boolean; fl: boolean; ias: boolean; hdg: boolean };
  /** Shared sim clock (seconds); each aircraft is interpolated at it. */
  simT: number;
  /** Which route is currently driving the playback clock — a numeric
   *  index renders only that aircraft; ``"all"`` renders every aircraft
   *  on the longest-route clock (legacy behaviour). */
  playbackIdx?: number | "all";
  /** flightKeys whose animated aircraft icon is hidden (toggled from the
   *  filter panel's eye). Distinct from hiddenKeys, which hides route lines. */
  hiddenAircraft?: Set<string>;
  /** flightKey of the aircraft the camera is following — drawn with a
   *  pulsing highlight ring so it stands out from the rest. */
  followKey?: string;
  /** Clicking a plane on the map locks the camera onto it (the parent turns on
   *  camera-follow + the detail card). Index is into `trajectories`. */
  onAircraftClick?: (index: number) => void;
  /** Hovering a plane shows its detail card without locking the camera; the
   *  parent clears it on mouse-out (index null). */
  onAircraftHover?: (index: number | null) => void;
  /** Bubbles the underlying Leaflet map instance up so the parent can
   *  drive zoom buttons rendered outside MapContainer (e.g. the +/− on
   *  the floating top-right toolbar). */
  onMapReady?: (map: L.Map | null) => void;
}

/** Captures the Leaflet map instance (only obtainable from inside a
 *  MapContainer via the useMap hook) and hands it back to the parent. */
function MapRefBridge({
  onReady,
}: {
  onReady: (m: L.Map | null) => void;
}) {
  const map = useMap();
  useEffect(() => {
    onReady(map);
    return () => onReady(null);
  }, [map, onReady]);
  return null;
}

/** Reports the live map zoom so zoom-dependent layers (e.g. gate labels, shown
 *  only when zoomed in to an airport) can react to it. */
function ZoomWatcher({ onZoom }: { onZoom: (z: number) => void }) {
  const map = useMapEvents({ zoomend: () => onZoom(map.getZoom()) });
  useEffect(() => {
    onZoom(map.getZoom());
  }, [map, onZoom]);
  return null;
}

/** Gate dots always draw; their PERMANENT identifier labels only appear at or
 *  above this zoom (airport-diagram level) — below it the labels would blanket
 *  the country, so gates just show as dots with a hover tooltip. */
const GATE_ZOOM = 13;

/** Per-route colours (cycled if there are more routes than entries). */
const ROUTE_COLORS = [
  "#22d3ee",
  "#f472b6",
  "#a3e635",
  "#fbbf24",
  "#c084fc",
  "#fb7185",
];

/** Preview palette — same hue family as ROUTE_COLORS so a previewed
 *  route reads as the "draft" of the same route once generated. Used
 *  cyclically for the live route preview. */
const PREVIEW_COLORS = [
  "#38bdf8",
  "#f472b6",
  "#a3e635",
  "#fbbf24",
  "#c084fc",
  "#fb7185",
];

const DEFAULT_CENTER: L.LatLngExpression = [11.0, 99.5];
const DEFAULT_ZOOM = 6;

/** Per-layer colours: SID green, STAR magenta, PBN amber, ILS red. */
const SID_COLOR = "#34d399";
const STAR_COLOR = "#f472b6";
const PBN_COLOR = "#fbbf24";
const ILS_COLOR = "#ef4444";
const GATE_COLOR = "#fb923c";
const RUNWAY_COLOR = "#e5e7eb";

/** Procedure-style layer kinds (share line/waypoint schema + rendering). */
type ProcKind = "SID" | "STAR" | "PBN" | "ILS";

/** A track the user clicked, for the parent to resolve via the API. */
export interface ProcedureSelection {
  airport: string;
  name: string;
  transition: string | null;
  type: ProcKind;
}

/** Tooltip/popup + click wiring for one procedure line feature. */
function bindProcedureFeature(
  feature: GeoJSON.Feature,
  layer: L.Layer,
  type: ProcKind,
  onClick?: (sel: ProcedureSelection) => void,
): void {
  const p = (feature.properties ?? {}) as {
    airport_identifier?: string;
    procedure_identifier?: string;
    transition_identifier?: string | null;
  };
  const name = p.procedure_identifier ?? "?";
  const trans = p.transition_identifier ?? null;
  layer.bindTooltip(`${type} · ${name}`, { sticky: true });
  layer.bindPopup(
    `<strong>${name}</strong> · ${type}<br/>${p.airport_identifier ?? ""}` +
      (trans ? ` · ${trans}` : "") +
      (onClick ? "<br/><em>click to load legs</em>" : ""),
  );
  if (onClick) {
    layer.on("click", () =>
      onClick({
        airport: p.airport_identifier ?? "",
        name,
        transition: trans,
        type,
      }),
    );
  }
}

/** True if a feature's airport/procedure pass the Layer Options filters. */
function passesProcFilter(
  props: { airport_identifier?: string; procedure_identifier?: string },
  state: ProcLayerState,
): boolean {
  if (
    state.airports.size > 0 &&
    !state.airports.has(props.airport_identifier ?? "")
  ) {
    return false;
  }
  if (
    state.procedures.size > 0 &&
    !state.procedures.has(props.procedure_identifier ?? "")
  ) {
    return false;
  }
  return true;
}

/** A filtered + styled SID/STAR <GeoJSON> line layer, or null when off. */
function buildProcedureLayer(
  lines: ProcedureLineCollection | null | undefined,
  state: ProcLayerState | undefined,
  type: ProcKind,
  color: string,
  onClick?: (sel: ProcedureSelection) => void,
): ReactNode {
  if (!lines || !state?.routes) return null;
  const features = lines.features.filter((f) =>
    passesProcFilter(f.properties, state),
  );
  // react-leaflet's GeoJSON is keyed by data identity — fold the filter +
  // style into the key so it rebuilds when the user changes them.
  const apSig = [...state.airports].sort().join(",");
  const prSig = [...state.procedures].sort().join(",");
  const key = `${type}-${features.length}-${state.opacity}-${state.thickness}-${apSig}-${prSig}`;
  return (
    <GeoJSON
      key={key}
      data={{ type: "FeatureCollection", features } as GeoJSON.FeatureCollection}
      style={() => ({
        color,
        weight: state.thickness,
        opacity: state.opacity,
      })}
      onEachFeature={(f, layer) =>
        bindProcedureFeature(f, layer, type, onClick)
      }
    />
  );
}

/** Format a SID/STAR fix's ARINC 424 crossing restriction as a compact label,
 *  e.g. "-10000" (at/below), "+11000" (at/above), "5000-8000" (between),
 *  "10000" (at). Empty string when the fix has no altitude restriction. */
function fmtWptAlt(p: {
  altitude_description?: string | null;
  altitude1?: number | null;
  altitude2?: number | null;
}): string {
  const a1 = p.altitude1 ?? null;
  const a2 = p.altitude2 ?? null;
  if (a1 == null && a2 == null) return "";
  const desc = (p.altitude_description ?? "").trim();
  if (desc === "+") return a1 != null ? `+${a1}` : "";
  if (desc === "-") return a1 != null ? `-${a1}` : "";
  if (desc === "B") return `${a2 ?? "?"}-${a1 ?? "?"}`;
  return a1 != null ? `${a1}` : ""; // "@" / blank = a hard AT
}

/** Filtered SID/STAR fix dots (deduped by ident), each with a permanent label
 *  showing the ident + its crossing restriction (e.g. "GUGOT · -10000"), read
 *  from the SID/STAR waypoint files. Null when the layer is off. */
function buildWaypointLayer(
  wpts: ProcedureWaypointCollection | null | undefined,
  state: ProcLayerState | undefined,
  color: string,
): ReactNode {
  if (!wpts || !state?.waypoints) return null;
  const seen = new Map<string, { lat: number; lon: number; alt: string }>();
  for (const f of wpts.features) {
    const p = f.properties;
    if (!passesProcFilter(p, state)) continue;
    const ident = p.waypoint_identifier ?? null;
    const lat = p.waypoint_latitude ?? null;
    const lon = p.waypoint_longitude ?? null;
    if (!ident || lat == null || lon == null) continue;
    const prev = seen.get(ident);
    const alt = fmtWptAlt(p);
    // First sighting wins for position; fill the altitude from whichever
    // occurrence actually carries a restriction (the same fix is unconstrained
    // on some procedures and constrained on others).
    if (!prev) seen.set(ident, { lat, lon, alt });
    else if (!prev.alt && alt) prev.alt = alt;
  }
  return [...seen.entries()].map(([ident, { lat, lon, alt }]) => (
    <CircleMarker
      key={`pwp-${ident}`}
      center={[lat, lon]}
      radius={2.5}
      pathOptions={{
        color,
        weight: 1,
        fillColor: color,
        fillOpacity: 0.6,
        opacity: state.opacity,
      }}
    >
      <Tooltip
        permanent
        direction="right"
        offset={[4, 0]}
        className="pwp-label"
        opacity={1}
      >
        <span className="pwp-id" style={{ color }}>
          {ident}
        </span>
        {alt && (
          <span className="pwp-alt" style={{ color }}>
            {alt}
          </span>
        )}
      </Tooltip>
    </CircleMarker>
  ));
}

/** Blue map-pin airport icon (airplane glyph) with a hover pulse glow. */
function airportIcon(): L.DivIcon {
  return L.divIcon({
    className: "airport-icon",
    iconSize: [22, 28],
    iconAnchor: [11, 26], // tip of the pin sits on the coordinate
    html: `<span class="airport-pulse"></span><span class="airport-pin">
      <svg viewBox="0 0 24 24" width="10" height="10" fill="#fff">
        <path d="M12 2 L14 10 L22 14 L22 16 L14 13 L13 20 L16 22 L16 23
                 L12 22 L8 23 L8 22 L11 20 L10 13 L2 16 L2 14 L10 10 Z"/>
      </svg></span>`,
  });
}

/** Fit to the generated routes if any, otherwise the airway network. */
function FitBounds({
  airways,
  trajectories,
}: Pick<Props, "airways" | "trajectories">) {
  const map = useMap();
  const sig = trajectories
    .map((t) => t.meta.flightKey)
    .join("|");
  useEffect(() => {
    const b = L.latLngBounds([]);
    if (trajectories.length) {
      trajectories.forEach((t) =>
        t.points.forEach((p) => b.extend([p.lat, p.lon])),
      );
    } else if (airways) {
      airways.features.forEach((f) =>
        f.geometry.coordinates.forEach(([lon, lat]) => b.extend([lat, lon])),
      );
    }
    if (b.isValid()) map.fitBounds(b, { padding: [40, 40] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, airways, sig]);
  return null;
}

/** Aircraft-type → icon fill colour, so each type flies a distinct colour.
 *  Common Thai-fleet types get hand-picked hues; any other type falls back
 *  to a deterministic hash so it still gets a stable, distinct colour. */
const AIRCRAFT_COLORS: Record<string, string> = {
  // Boeing
  B737: "#22d3ee",
  B738: "#22d3ee",
  B739: "#0ea5e9",
  B763: "#34d399",
  B77W: "#fb7185",
  B772: "#f43f5e",
  B789: "#38bdf8",
  B788: "#60a5fa",
  // Airbus
  A319: "#fde047",
  A320: "#f472b6",
  A321: "#a3e635",
  A332: "#fb923c",
  A333: "#fbbf24",
  A359: "#c084fc",
  A35K: "#a855f7",
  A388: "#f87171",
  // Turboprops / regional
  AT72: "#2dd4bf",
  AT76: "#2dd4bf",
  DH8D: "#86efac",
};

function aircraftColor(type: string | undefined): string {
  const t = (type ?? "").toUpperCase().trim();
  if (AIRCRAFT_COLORS[t]) return AIRCRAFT_COLORS[t];
  if (!t) return "#22d3ee";
  // Deterministic fallback: hash the type code → a stable hue so unknown
  // types are still visually separable (and consistent across frames).
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) % 360;
  return `hsl(${h}, 85%, 62%)`;
}

/** Case-insensitive substring match of an aircraft type against the
 *  top-center filter query. An empty query matches everything (so "A32"
 *  matches A320/A321, "B789" matches just the 789). */
function matchesAcType(
  query: string | undefined,
  type: string | undefined,
): boolean {
  const q = (query ?? "").trim().toUpperCase();
  if (!q) return true;
  return (type ?? "").toUpperCase().includes(q);
}

/** A small SVG plane icon, rotated to the current heading and tinted by
 *  aircraft type. */
function planeIcon(
  track: number,
  color: string,
  highlight = false,
): L.DivIcon {
  const ring = highlight
    ? `<span class="aircraft-ring"></span>`
    : "";
  return L.divIcon({
    className: `aircraft-icon${highlight ? " followed" : ""}`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
    html: `${ring}<div style="transform: rotate(${track}deg)">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="${color}"
           stroke="#0f172a" stroke-width="1.2">
        <path d="M12 2 L14 10 L22 14 L22 16 L14 13 L13 20 L16 22 L16 23
                 L12 22 L8 23 L8 22 L11 20 L10 13 L2 16 L2 14 L10 10 Z"/>
      </svg></div>`,
  });
}

/** Small pill badge for the Top-of-Climb / Top-of-Descent map markers. */
function profileBadge(text: string, color: string): L.DivIcon {
  return L.divIcon({
    className: "profile-badge",
    iconSize: [40, 18],
    iconAnchor: [20, 9],
    html: `<span class="profile-badge-pill" style="background:${color}">${text}</span>`,
  });
}

/** Small pill badge identifying which route a polyline belongs to (R1, R2…)
 *  when several routes are flown at once. The pill is drawn just off the
 *  start endpoint so it doesn't overlap the green Start dot. */
function routeIndexBadge(text: string, color: string): L.DivIcon {
  return L.divIcon({
    className: "route-index-badge",
    iconSize: [26, 18],
    iconAnchor: [-6, 28],
    html: `<span class="route-index-pill" style="background:${color};color:#06283d">${text}</span>`,
  });
}

/** Permanent gate-identifier pill, drawn just off the gate dot once zoomed in.
 *  Separate from the dot's hover tooltip (Leaflet allows one tooltip per
 *  marker), so hovering the dot still shows the full "ICAO - Gate <id>". */
function gateBadge(text: string): L.DivIcon {
  return L.divIcon({
    className: "gate-badge",
    iconSize: [0, 0],
    iconAnchor: [-4, 7],
    html: `<span class="gate-badge-pill">${text}</span>`,
  });
}

/** Destination point `distNm` NM from (lat, lon) along a true bearing (deg) —
 *  used to build a runway strip rectangle out of a threshold + length + width. */
function destPoint(
  lat: number,
  lon: number,
  bearingDeg: number,
  distNm: number,
): [number, number] {
  const R = 3440.065; // Earth radius, NM
  const d = distNm / R;
  const b = (bearingDeg * Math.PI) / 180;
  const la1 = (lat * Math.PI) / 180;
  const lo1 = (lon * Math.PI) / 180;
  const la2 = Math.asin(
    Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b),
  );
  const lo2 =
    lo1 +
    Math.atan2(
      Math.sin(b) * Math.sin(d) * Math.cos(la1),
      Math.cos(d) - Math.sin(la1) * Math.sin(la2),
    );
  return [(la2 * 180) / Math.PI, (lo2 * 180) / Math.PI];
}

/** Reciprocal runway ident (RW03L → RW21R): +18 on the number (wrapping 1-36)
 *  and swapping L↔R, so a runway's two thresholds collapse into one strip. */
function reciprocalRwy(ident: string): string {
  const m = ident.match(/^RW(\d{1,2})([LRC]?)$/i);
  if (!m) return "";
  const num = ((parseInt(m[1], 10) + 18 - 1) % 36) + 1;
  const side = m[2].toUpperCase();
  const rec = side === "L" ? "R" : side === "R" ? "L" : side;
  return `RW${String(num).padStart(2, "0")}${rec}`;
}

/** Altitude → polyline colour: brighter (yellow) at low altitudes,
 *  saturated cyan/blue at cruise. The same scale is used for every
 *  generated route so the user reads altitude consistently — different
 *  *routes* are still distinguishable by their physical path and the
 *  R1/R2/R3 badge near the start dot. */
function altitudeColor(altFt: number | null): string {
  if (altFt == null || !Number.isFinite(altFt)) return "#94a3b8";
  // Normalise 0–FL400 onto 0–1; clamp so any altitude maps to a colour.
  const f = Math.max(0, Math.min(1, altFt / 40000));
  // Hue sweeps warm-yellow (50°) → cyan-blue (210°) as altitude climbs;
  // lightness drops 72 % → 38 % so low altitudes literally look brighter.
  const hue = 50 + f * 160;
  const light = 72 - f * 34;
  return `hsl(${hue.toFixed(0)}, 92%, ${light.toFixed(0)}%)`;
}

/**
 * A dot with a much larger *invisible* hit circle on top, so hovering a
 * waypoint is easy without enlarging the visible marker. The visible
 * circle is non-interactive; the transparent one carries tooltip/popup.
 */
function HoverFix({
  center,
  radius,
  hitRadius,
  pathOptions,
  children,
}: {
  center: L.LatLngExpression;
  radius: number;
  hitRadius: number;
  pathOptions: L.PathOptions;
  children: ReactNode;
}) {
  return (
    <>
      <CircleMarker
        center={center}
        radius={radius}
        pathOptions={{ ...pathOptions, interactive: false }}
      />
      <CircleMarker
        center={center}
        radius={hitRadius}
        pathOptions={{ stroke: false, fill: true, fillOpacity: 0 }}
      >
        {children}
      </CircleMarker>
    </>
  );
}

/** Start/End marker — the route's first/last fix, kept off the small
 *  intermediate markers so their tooltips don't stack and fight. */
function EndpointMarker({
  position,
  fill,
  stroke,
  ident,
  role,
  detail,
}: {
  position: L.LatLngExpression;
  fill: string;
  stroke: string;
  /** The aerodrome ICAO at this endpoint (e.g. "VTBD"). */
  ident: string;
  role: "Start" | "End";
  detail: string;
}) {
  return (
    <HoverFix
      center={position}
      radius={7}
      hitRadius={20}
      pathOptions={{
        color: stroke,
        weight: 2,
        fillColor: fill,
        fillOpacity: 1,
      }}
    >
      <Tooltip direction="top" offset={[0, -9]} sticky>
        <strong>{ident}</strong> · {role}
      </Tooltip>
      <Popup>
        <strong>
          {ident} — {role}
        </strong>
        <br />
        {detail}
      </Popup>
    </HoverFix>
  );
}

export default function LeafletMap({
  basemap,
  airways,
  airwayPts,
  waypoints,
  fir,
  sectors,
  sidLines,
  starLines,
  sidWpts,
  starWpts,
  pbnLines,
  pbnWpts,
  ilsLines,
  ilsWpts,
  sid,
  star,
  pbn,
  ils,
  airports,
  hiddenAirports,
  gates,
  runways,
  highlightProc,
  trajectories,
  showTrails = true,
  flColorTrails = true,
  trailDecaySec = 0,
  trailWeight = 2,
  showProfilePins = false,
  hiddenKeys,
  previewRoutes,
  typeFilter,
  onProcedureClick,
  tagFields,
  simT,
  playbackIdx,
  hiddenAircraft,
  followKey,
  onAircraftClick,
  onAircraftHover,
  onMapReady,
}: Props) {
  const tiles = BASEMAPS[basemap];

  // Elapsed-time sample table per trajectory (rebuilt only on new data).
  const samplesByRoute = useMemo(
    () => trajectories.map((t) => toSamples(t.points)),
    [trajectories],
  );

  // Absolute departure offset (seconds) per route: its first-sample epoch minus
  // the earliest first-sample epoch across all routes. In "all" mode the shared
  // sim clock is an ABSOLUTE timeline, so each flight animates at its real
  // EOBT — a later departure sits correspondingly behind on any shared track,
  // giving realistic in-trail separation instead of every plane launching at
  // once. Single-route playback ignores this (offset 0 = plays from its start).
  const routeOffsetSec = useMemo(() => {
    let origin = Infinity;
    for (const t of trajectories) {
      const p = t.points?.[0];
      if (p) origin = Math.min(origin, new Date(p.epoch_ts).getTime());
    }
    if (!Number.isFinite(origin)) origin = 0;
    return trajectories.map((t) => {
      const p = t.points?.[0];
      return p ? (new Date(p.epoch_ts).getTime() - origin) / 1000 : 0;
    });
  }, [trajectories]);

  const firLayer = useMemo(
    () =>
      fir && (
        <GeoJSON
          key={`fir-${fir.features.length}`}
          data={fir}
          style={() => ({
            color: "#a78bfa",
            weight: 1,
            opacity: 0.7,
            fillColor: "#a78bfa",
            fillOpacity: 0.05,
          })}
          onEachFeature={(f, layer) =>
            layer.bindPopup(`<strong>${f.properties?.name ?? "FIR"}</strong>`)
          }
        />
      ),
    [fir],
  );

  const airwayLayer = useMemo(
    () =>
      airways && (
        <GeoJSON
          key={`airways-${airways.features.length}`}
          data={airways}
          style={() => ({
            color: "#f59e0b",
            weight: 1,
            opacity: airwayPts?.opacity ?? 0.35,
          })}
        />
      ),
    [airways, airwayPts?.opacity],
  );

  // Airway reporting points (the Airway menu) — pink up-triangle + ident, like
  // the reference viewer. The source file is worldwide (~35 k pts), so they're
  // restricted to the Thailand bounds (lat 5.5–20.5, lon 97.5–106) → ~380
  // points, light enough to draw at every zoom.
  const airwayPointLayers = useMemo(() => {
    const data = airwayPts?.reporting;
    if (!data) return null;
    const op = airwayPts?.opacity ?? 0.85;
    const inRegion = (lon: number, lat: number) =>
      lon >= 97.5 && lon <= 106 && lat >= 5.5 && lat <= 20.5;

    const markers: ReactNode[] = [];
    for (const f of data.features) {
      const g = f.geometry;
      const coords =
        g?.type === "MultiPoint"
          ? (g.coordinates as number[][])
          : g?.type === "Point"
            ? [g.coordinates as number[]]
            : [];
      const id = String(f.properties?.waypoint_identifier ?? "");
      if (!id) continue;
      for (let i = 0; i < coords.length; i++) {
        const [lon, lat] = coords[i];
        if (!inRegion(lon, lat)) continue;
        markers.push(
          <Marker
            key={`rep-${id}-${i}-${lat},${lon}`}
            position={[lat, lon]}
            interactive={false}
            opacity={op}
            icon={L.divIcon({
              className: "rep-icon",
              iconSize: [12, 12],
              iconAnchor: [6, 5],
              html: `<span class="rep-tri"></span><span class="rep-lbl">${id}</span>`,
            })}
          />,
        );
      }
    }
    return <>{markers}</>;
  }, [airwayPts?.reporting, airwayPts?.opacity]);

  // VOR navaids — drawn as the conventional ring+centre-dot symbol with the
  // station identifier beside it (matching the reference viewer). The source
  // file is worldwide (~2.5 k), but this is a Thai-FIR tool, so the symbols are
  // restricted to the Thailand bounds used by the reference viewer
  // (lat 5.5–20.5, lon 97.5–106) — ~50 VOR/DME stations, exactly the set shown
  // on the charts.
  const airwayVorLayer = useMemo(() => {
    const data = airwayPts?.vor;
    if (!data) return null;
    const op = airwayPts?.opacity ?? 0.85;
    const inRegion = (lon: number, lat: number) =>
      lon >= 97.5 && lon <= 106 && lat >= 5.5 && lat <= 20.5;

    const markers: ReactNode[] = [];
    for (const f of data.features) {
      const g = f.geometry;
      const coords =
        g?.type === "MultiPoint"
          ? (g.coordinates[0] as number[] | undefined)
          : g?.type === "Point"
            ? (g.coordinates as number[])
            : undefined;
      if (!coords) continue;
      const [lon, lat] = coords;
      if (!inRegion(lon, lat)) continue;
      const id = String(f.properties?.waypoint_identifier ?? "");
      markers.push(
        <Marker
          key={`vor-${id}-${f.properties?.fid ?? `${lat},${lon}`}`}
          position={[lat, lon]}
          interactive={false}
          opacity={op}
          icon={L.divIcon({
            className: "vor-icon",
            iconSize: [12, 12],
            iconAnchor: [6, 6],
            html: `<span class="vor-ring"></span><span class="vor-lbl">${id}</span>`,
          })}
        />,
      );
    }
    return <>{markers}</>;
  }, [airwayPts?.vor, airwayPts?.opacity]);

  // Airway designator labels ("W18", "V3", …) — one permanent tooltip per
  // airway, anchored on the first segment that names it. Invisible host lines
  // (weight/opacity 0) so only the labels show; toggled by the Airway menu.
  const airwayLabelLayer = useMemo(() => {
    const data = airwayPts?.labels;
    if (!data) return null;
    const seen = new Set<string>();
    return (
      <GeoJSON
        key={`aw-labels-${data.features.length}`}
        data={data}
        style={() => ({ weight: 0, opacity: 0, interactive: false })}
        onEachFeature={(feature, layer) => {
          const id = feature.properties?.route_identifier;
          if (!id || seen.has(id)) return;
          seen.add(id);
          layer.bindTooltip(String(id), {
            permanent: true,
            direction: "center",
            className: "aw-label",
            opacity: airwayPts?.opacity ?? 0.8,
          });
        }}
      />
    );
  }, [airwayPts?.labels, airwayPts?.opacity]);

  // Airspace sector overlays — one dashed, lightly-filled <GeoJSON> per
  // toggled-on sector (BACC / subsector / CTR / TMA / PDR), each in its own
  // colour with a name popup.
  const sectorLayers = useMemo(
    () =>
      SECTORS.map((s) => {
        const data = sectors?.[s.key];
        if (!data) return null;
        return (
          <GeoJSON
            key={`sector-${s.key}-${data.features.length}`}
            data={data}
            style={() => ({
              color: s.color,
              weight: 1,
              opacity: 0.8,
              fillColor: s.color,
              fillOpacity: 0.06,
              dashArray: "8 4",
            })}
            onEachFeature={(f, layer) => {
              const p = (f.properties ?? {}) as Record<string, unknown>;
              const name = p.name ?? p.ident ?? s.label;
              layer.bindPopup(`<strong>${name}</strong> · ${s.label}`);
            }}
          />
        );
      }).filter(Boolean),
    [sectors],
  );

  // SID/STAR procedure tracks. Filtered by the Layer Options airport +
  // procedure selections and styled by its opacity / line-thickness sliders.
  // Hover shows the name; clicking bubbles a selection up so the parent can
  // fetch the coded legs + constraints from the API. The data key includes
  // the filter/style so react-leaflet rebuilds the layer when they change.
  const sidLayer = useMemo(
    () => buildProcedureLayer(sidLines, sid, "SID", SID_COLOR, onProcedureClick),
    [sidLines, sid, onProcedureClick],
  );
  const starLayer = useMemo(
    () =>
      buildProcedureLayer(starLines, star, "STAR", STAR_COLOR, onProcedureClick),
    [starLines, star, onProcedureClick],
  );

  // SID/STAR fixes (the coded waypoints) as small dots with ident tooltips.
  const sidWptLayer = useMemo(
    () => buildWaypointLayer(sidWpts, sid, SID_COLOR),
    [sidWpts, sid],
  );
  const starWptLayer = useMemo(
    () => buildWaypointLayer(starWpts, star, STAR_COLOR),
    [starWpts, star],
  );

  // PBN / ILS reuse the same procedure-layer machinery as SID/STAR. No
  // click-to-fetch — the procedures API resolves SID/STAR only.
  const pbnLayer = useMemo(
    () => buildProcedureLayer(pbnLines, pbn, "PBN", PBN_COLOR),
    [pbnLines, pbn],
  );
  const ilsLayer = useMemo(
    () => buildProcedureLayer(ilsLines, ils, "ILS", ILS_COLOR),
    [ilsLines, ils],
  );
  const pbnWptLayer = useMemo(
    () => buildWaypointLayer(pbnWpts, pbn, PBN_COLOR),
    [pbnWpts, pbn],
  );
  const ilsWptLayer = useMemo(
    () => buildWaypointLayer(ilsWpts, ils, ILS_COLOR),
    [ilsWpts, ils],
  );

  // Live map zoom (updated by ZoomWatcher) — gates only label when zoomed in.
  const [zoom, setZoom] = useState<number>(DEFAULT_ZOOM);

  // Gates — small orange dots, ALWAYS drawn (with a hover tooltip naming the
  // airport + gate) so the stands read as dots even when zoomed out. Once
  // zoomed in to an airport (>= GATE_ZOOM) every gate additionally gets a
  // PERMANENT label with its identifier, so the whole stand layout is readable
  // at a glance for any airport that has gate data (all in gateway.geojson).
  const gateLayer = useMemo(() => {
    if (!gates) return null;
    const labelled = zoom >= GATE_ZOOM;
    return gates.features
      .map((f, i) => {
        const p = f.properties;
        const lat = p.gate_latitude;
        const lon = p.gate_longitude;
        if (lat == null || lon == null) return null;
        const gid = p.gate_identifier ?? "";
        return (
          <Fragment key={`gate-${p.airport_identifier}-${gid}-${i}`}>
            <CircleMarker
              center={[lat, lon]}
              radius={2}
              pathOptions={{
                color: GATE_COLOR,
                weight: 1,
                fillColor: GATE_COLOR,
                fillOpacity: 0.8,
              }}
            >
              <Tooltip direction="top" offset={[0, -3]} sticky>
                {p.airport_identifier} - Gate {gid}
              </Tooltip>
            </CircleMarker>
            {labelled && (
              <Marker
                position={[lat, lon]}
                icon={gateBadge(gid)}
                interactive={false}
              />
            )}
          </Fragment>
        );
      })
      .filter(Boolean);
  }, [gates, zoom]);

  // Highlighted procedure (from the lookup form / map click): a bright
  // yellow glow path through its fixes, with permanent ident labels.
  const highlightLayer = useMemo(() => {
    const wps = highlightProc?.waypoints ?? [];
    if (wps.length < 1) return null;
    const line: L.LatLngExpression[] = wps.map((w) => [w.lat, w.lon]);
    return (
      <Fragment key={`hl-${highlightProc?.name}`}>
        {line.length >= 2 && (
          <>
            <Polyline
              positions={line}
              interactive={false}
              pathOptions={{
                color: "#fde047",
                weight: 9,
                opacity: 0.3,
                lineCap: "round",
                lineJoin: "round",
              }}
            />
            <Polyline
              positions={line}
              interactive={false}
              pathOptions={{
                color: "#fde047",
                weight: 3,
                opacity: 0.95,
                lineCap: "round",
                lineJoin: "round",
              }}
            />
          </>
        )}
        {wps.map((w, i) => (
          <CircleMarker
            key={`hl-${w.ident}-${i}`}
            center={[w.lat, w.lon]}
            radius={4}
            pathOptions={{
              color: "#0f172a",
              weight: 1.5,
              fillColor: "#fde047",
              fillOpacity: 1,
            }}
          >
            <Tooltip
              permanent
              direction="top"
              offset={[0, -4]}
              className="hl-tip"
            >
              {w.ident}
            </Tooltip>
          </CircleMarker>
        ))}
      </Fragment>
    );
  }, [highlightProc]);

  // Runways — drawn as real strips: a width-scaled rectangle spanning each
  // runway's two thresholds (paired by reciprocal ident), not just threshold
  // dots. The rectangle uses the published runway width so it reads like the
  // grey strips on the basemap and scales with zoom.
  const runwayLayer = useMemo(() => {
    if (!runways) return null;
    const NM_PER_FT = 1 / 6076.12;
    const byKey = new Map(runways.map((r) => [`${r.airport}|${r.ident}`, r]));
    const drawn = new Set<string>();
    const out: ReactNode[] = [];
    for (const r of runways) {
      const rec = reciprocalRwy(r.ident);
      const pairKey = `${r.airport}|${[r.ident, rec].sort().join("-")}`;
      if (drawn.has(pairKey)) continue;
      drawn.add(pairKey);
      const brg = Number.isFinite(r.bearing) ? r.bearing : 0;
      const a: [number, number] = [r.lat, r.lon];
      // The far end is the reciprocal threshold when we have it, else a point
      // one runway length ahead along the bearing.
      const other = byKey.get(`${r.airport}|${rec}`);
      const b: [number, number] = other
        ? [other.lat, other.lon]
        : destPoint(r.lat, r.lon, brg, (r.lengthFt || 8000) * NM_PER_FT);
      const halfW = ((r.widthFt || 150) / 2) * NM_PER_FT;
      const corners: [number, number][] = [
        destPoint(a[0], a[1], brg + 90, halfW),
        destPoint(a[0], a[1], brg - 90, halfW),
        destPoint(b[0], b[1], brg - 90, halfW),
        destPoint(b[0], b[1], brg + 90, halfW),
      ];
      out.push(
        <Polygon
          key={`rwy-${pairKey}`}
          positions={corners}
          interactive={false}
          pathOptions={{
            color: RUNWAY_COLOR,
            weight: 0.5,
            fillColor: RUNWAY_COLOR,
            fillOpacity: 0.6,
          }}
        />,
      );
    }
    return out;
  }, [runways]);

  // Airport markers — shown per-airport from the Layer Options list
  // (checked = visible). Hidden aerodromes are dropped.
  const airportLayer = useMemo(() => {
    if (!airports) return null;
    return airports
      .filter((a) => !hiddenAirports?.has(a.code))
      .map((a) => (
        <Marker
          key={`ap-${a.code}`}
          position={[a.lat, a.lon]}
          icon={airportIcon()}
        >
          <Tooltip
            direction="top"
            offset={[0, -34]}
            className="airport-tip"
          >
            <span className="airport-tip-name">{a.name}</span>
            <span className="airport-tip-code">{a.code}</span>
          </Tooltip>
        </Marker>
      ));
  }, [airports, hiddenAirports]);

  const waypointLayer = useMemo(
    () =>
      waypoints?.map((w) => (
        <HoverFix
          key={`wp-${w.ident}`}
          center={[w.lat, w.lon]}
          radius={2.5}
          hitRadius={13}
          pathOptions={{
            color: "#f59e0b",
            weight: 1,
            fillColor: "#f59e0b",
            fillOpacity: 0.5,
          }}
        >
          <Tooltip direction="top" offset={[0, -6]} sticky>
            {w.ident}
          </Tooltip>
        </HoverFix>
      )),
    [waypoints],
  );

  // Live preview of the routes the user is composing (typed Item-15,
  // RouteBuilder picks, plus any queued routes). One distinctly-coloured
  // dashed polyline per route; markers/labels are deduped across routes
  // so shared fixes (Y8 is heavily shared) get a single label, coloured
  // by the first route that contains them.
  const previewLayer = useMemo(() => {
    if (!previewRoutes || previewRoutes.length === 0) return null;

    const polylines = previewRoutes.map((route, idx) => {
      if (route.length < 2) return null;
      const color = PREVIEW_COLORS[idx % PREVIEW_COLORS.length];
      const line: L.LatLngExpression[] = route.map((p) => [p.lat, p.lon]);
      return (
        <Polyline
          key={`prev-line-${idx}`}
          positions={line}
          interactive={false}
          pathOptions={{
            color,
            weight: 2,
            opacity: 0.65,
            dashArray: "6 6",
          }}
        />
      );
    });

    // Dedupe markers by ident (Y8 routes share most fixes); first
    // occurrence wins and the marker takes that route's colour.
    const seen = new Map<string, { p: PreviewPoint; color: string }>();
    previewRoutes.forEach((route, idx) => {
      const color = PREVIEW_COLORS[idx % PREVIEW_COLORS.length];
      for (const p of route) {
        if (!seen.has(p.ident)) seen.set(p.ident, { p, color });
      }
    });
    const markers = Array.from(seen.values()).map(({ p, color }) => (
      <CircleMarker
        key={`prev-mk-${p.ident}`}
        center={[p.lat, p.lon]}
        radius={p.fromUser ? 5 : 3.5}
        pathOptions={{
          color,
          weight: p.fromUser ? 2 : 1,
          fillColor: color,
          fillOpacity: p.fromUser ? 0.45 : 0.25,
          interactive: false,
        }}
      >
        <Tooltip
          permanent
          direction="right"
          offset={[8, 0]}
          className="preview-label"
        >
          {p.ident}
        </Tooltip>
      </CircleMarker>
    ));

    return (
      <Fragment key="route-preview">
        {polylines}
        {markers}
      </Fragment>
    );
  }, [previewRoutes]);

  const multiRoute = trajectories.length > 1;

  const trajectoryLayer = useMemo(
    () =>
      trajectories.map((trajectory, ti) => {
        if (trajectory.points.length < 2) return null;
        if (hiddenKeys?.has(trajectory.meta.flightKey)) return null;
        // Top-center aircraft-type filter: skip non-matching flights' lines.
        if (!matchesAcType(typeFilter, trajectory.meta.aircraftType)) return null;
        const pts = trajectory.points;
        const { route, meta } = trajectory;
        const color = ROUTE_COLORS[ti % ROUTE_COLORS.length];
        const kp = meta.flightKey;

        // Decimate the *drawn* line so a long route (points are sampled
        // every 4 s ⇒ ~750 pts for a 50-min leg) doesn't explode into
        // thousands of Leaflet layers. With many routes on screen at once
        // the unbounded version exhausted browser memory ("Aw, Snap! Out
        // of Memory"). We cap each route to ~MAX_SEG colour segments;
        // short routes keep full resolution. The animation is unaffected —
        // it interpolates the full-resolution `samplesByRoute` table.
        const MAX_SEG = 120;
        const step = Math.max(1, Math.ceil((pts.length - 1) / MAX_SEG));
        const drawIdx: number[] = [];
        for (let i = 0; i < pts.length; i += step) drawIdx.push(i);
        if (drawIdx[drawIdx.length - 1] !== pts.length - 1) {
          drawIdx.push(pts.length - 1);
        }
        const line: L.LatLngExpression[] = drawIdx.map((i) => [
          pts[i].lat,
          pts[i].lon,
        ]);

        // Colour the line by altitude: one Polyline per decimated segment,
        // tinted by the segment's mean altitude. Round line caps overlap at
        // the joints so the colour steps blend instead of stair-stepping —
        // which is why no extra per-segment sub-splitting is needed. Same
        // scale on every route.
        const altSegments: ReactNode[] = [];
        for (let s = 0; s < drawIdx.length - 1; s++) {
          const a = pts[drawIdx[s]];
          const b = pts[drawIdx[s + 1]];
          const altMid = ((a.altitude_ft ?? 0) + (b.altitude_ft ?? 0)) / 2;
          altSegments.push(
            <Polyline
              key={`${kp}-alt-${s}`}
              positions={[
                [a.lat, a.lon],
                [b.lat, b.lon],
              ]}
              interactive={false}
              pathOptions={{
                color: altitudeColor(altMid),
                weight: trailWeight,
                opacity: 0.95,
                lineCap: "round",
                lineJoin: "round",
              }}
            />,
          );
        }

        return (
          <Fragment key={kp}>
            {/* The FULL route line — drawn when "Show Trails" is on and Trail
                Decay is "No decay" (aircraft + fixes always stay). FL Color
                Trails on = altitude gradient; off = one flat per-route colour.
                A faint dark casing keeps it readable. With a finite decay this
                static line is replaced by the per-frame decaying trail. */}
            {showTrails && trailDecaySec === 0 && (
              <>
                <Polyline
                  positions={line}
                  interactive={false}
                  pathOptions={{
                    color: "#0f172a",
                    weight: trailWeight + 2,
                    opacity: 0.45,
                    lineCap: "round",
                    lineJoin: "round",
                  }}
                />
                {flColorTrails ? (
                  altSegments
                ) : (
                  <Polyline
                    positions={line}
                    interactive={false}
                    pathOptions={{
                      color,
                      weight: trailWeight,
                      opacity: 0.95,
                      lineCap: "round",
                      lineJoin: "round",
                    }}
                  />
                )}
              </>
            )}

            {/* Every published route fix as a dot (OLVUK … MARNI). The
                ADEP/ADES aerodromes are drawn separately by the endpoint
                markers below, so we no longer drop the first/last fix —
                with AIP routes those are real en-route fixes (e.g. OLVUK,
                MARNI), NOT the airports. */}
            {route.map((w) => (
              <HoverFix
                key={`${kp}-${w.ident}`}
                center={[w.lat, w.lon]}
                radius={4}
                hitRadius={13}
                pathOptions={{
                  color: "#0f172a",
                  weight: 1,
                  fillColor: color,
                  fillOpacity: 1,
                }}
              >
                <Tooltip direction="top" offset={[0, -7]} sticky>
                  {meta.callsign} · {w.ident}
                </Tooltip>
                <Popup>
                  <strong>{w.ident}</strong>
                  <br />
                  {w.lat.toFixed(5)}, {w.lon.toFixed(5)}
                </Popup>
              </HoverFix>
            ))}

            {multiRoute && (
              <Marker
                position={line[0]}
                interactive={false}
                icon={routeIndexBadge(`R${ti + 1}`, color)}
              />
            )}

            <EndpointMarker
              position={line[0]}
              fill="#22c55e"
              stroke="#052e16"
              ident={meta.adep}
              role="Start"
              detail={`${meta.callsign} · ${meta.eobtIso}`}
            />
            <EndpointMarker
              position={line[line.length - 1]}
              fill="#ef4444"
              stroke="#450a0a"
              ident={meta.ades}
              role="End"
              detail={`${meta.callsign} · ${pts[pts.length - 1].epoch_ts}`}
            />

            {/* Phase 2 vertical-profile pins: small triangles where the
                aircraft reaches cruise (TOC) and starts descent (TOD).
                Omitted on too-short legs where no cruise sample exists. */}
            {showProfilePins && trajectory.profile?.toc && (
              <Marker
                position={[trajectory.profile.toc.lat, trajectory.profile.toc.lon]}
                icon={profileBadge("TOC", "#22d3ee")}
              >
                <Tooltip direction="top" offset={[0, -10]}>
                  TOC · FL
                  {Math.round(trajectory.profile.toc.altitudeFt / 100)}
                </Tooltip>
              </Marker>
            )}
            {showProfilePins && trajectory.profile?.tod && (
              <Marker
                position={[trajectory.profile.tod.lat, trajectory.profile.tod.lon]}
                icon={profileBadge("TOD", "#fbbf24")}
              >
                <Tooltip direction="top" offset={[0, -10]}>
                  TOD · FL
                  {Math.round(trajectory.profile.tod.altitudeFt / 100)}
                </Tooltip>
              </Marker>
            )}
          </Fragment>
        );
      }),
    [trajectories, multiRoute, hiddenKeys, typeFilter, showTrails, flColorTrails, trailDecaySec, trailWeight, showProfilePins],
  );

  return (
    <MapContainer
      center={DEFAULT_CENTER}
      zoom={DEFAULT_ZOOM}
      scrollWheelZoom
      preferCanvas
      // Leaflet's default zoom control sits top-left. We disable it so a
      // custom +/− pair can be rendered next to the Light/Dark toggle
      // (see MapOverlay) — see onMapReady prop below.
      zoomControl={false}
      style={{ height: "100%", width: "100%" }}
    >
      <TileLayer key={basemap} attribution={tiles.attribution} url={tiles.url} />
      {onMapReady && <MapRefBridge onReady={onMapReady} />}
      <ZoomWatcher onZoom={setZoom} />

      {firLayer}
      {sectorLayers}
      {airwayLayer}
      {airwayLabelLayer}
      {airwayPointLayers}
      {airwayVorLayer}
      {sidLayer}
      {starLayer}
      {pbnLayer}
      {ilsLayer}
      {sidWptLayer}
      {starWptLayer}
      {pbnWptLayer}
      {ilsWptLayer}
      {gateLayer}
      {runwayLayer}
      {airportLayer}
      {waypointLayer}
      {previewLayer}
      {trajectoryLayer}
      {highlightLayer}

      {trajectories.map((t, ti) => {
        // Only the route currently bound to the playback engine gets an
        // animated aircraft icon — the others keep their static
        // polyline + endpoint markers. "all" mode renders every plane.
        if (playbackIdx !== undefined && playbackIdx !== "all" && playbackIdx !== ti) {
          return null;
        }
        // Top-center aircraft-type filter hides the icon too, so a filtered
        // map shows only the searched type (line + plane).
        if (!matchesAcType(typeFilter, t.meta.aircraftType)) return null;
        // The filter panel's eye hides the animated aircraft icon (the route
        // line, controlled by hiddenKeys, is independent).
        if (hiddenAircraft?.has(t.meta.flightKey)) return null;
        // Absolute timeline in "all" mode: shift this route's clock by its
        // departure offset, and show the icon only while it is airborne (after
        // EOBT, before touchdown) so the map isn't littered with parked/landed
        // planes stacked at the airports.
        const routeSamples = samplesByRoute[ti] ?? [];
        const off = playbackIdx === "all" ? routeOffsetSec[ti] ?? 0 : 0;
        const localT = simT - off;
        if (playbackIdx === "all") {
          const dur = routeSamples[routeSamples.length - 1]?.t ?? 0;
          if (localT < 0 || localT > dur) return null;
        }
        const ac = aircraftAt(routeSamples, localT);
        if (!ac) return null;

        // Decaying trail (Full Trails off): the flown path within the decay
        // window [simT − decay, simT], capped + tinted like the static line.
        // Re-rendered every frame here so it follows the aircraft.
        let decayTrail: ReactNode = null;
        if (showTrails && trailDecaySec > 0) {
          const samples = routeSamples;
          const lo = localT - trailDecaySec;
          const win = samples.filter((s) => s.t <= localT && s.t >= lo);
          const trailPts = [
            ...win,
            { lat: ac.lat, lon: ac.lon, altitudeFt: ac.altitudeFt, t: localT },
          ];
          if (trailPts.length >= 2) {
            // Decimate so a long flown path stays ~120 segments per frame.
            const stepT = Math.max(1, Math.ceil((trailPts.length - 1) / 120));
            const keep = trailPts.filter(
              (_, i) => i % stepT === 0 || i === trailPts.length - 1,
            );
            const trailColor = ROUTE_COLORS[ti % ROUTE_COLORS.length];
            decayTrail = (
              <>
                <Polyline
                  positions={keep.map((s) => [s.lat, s.lon])}
                  interactive={false}
                  pathOptions={{
                    color: "#0f172a",
                    weight: trailWeight + 2,
                    opacity: 0.4,
                    lineCap: "round",
                    lineJoin: "round",
                  }}
                />
                {flColorTrails ? (
                  keep.slice(0, -1).map((a, i) => {
                    const b = keep[i + 1];
                    const altMid =
                      ((a.altitudeFt ?? 0) + (b.altitudeFt ?? 0)) / 2;
                    return (
                      <Polyline
                        key={`trail-${t.meta.flightKey}-${i}`}
                        positions={[
                          [a.lat, a.lon],
                          [b.lat, b.lon],
                        ]}
                        interactive={false}
                        pathOptions={{
                          color: altitudeColor(altMid),
                          weight: trailWeight,
                          opacity: 0.95,
                          lineCap: "round",
                          lineJoin: "round",
                        }}
                      />
                    );
                  })
                ) : (
                  <Polyline
                    positions={keep.map((s) => [s.lat, s.lon])}
                    interactive={false}
                    pathOptions={{
                      color: trailColor,
                      weight: trailWeight,
                      opacity: 0.95,
                      lineCap: "round",
                      lineJoin: "round",
                    }}
                  />
                )}
              </>
            );
          }
        }
        // Configurable flight tag — only the fields enabled in the Flight
        // Tags menu, in screenshot order: callsign · FL · IAS · HDG. Updates
        // live as the checkboxes toggle (re-rendered every frame anyway).
        const tf =
          tagFields ?? { callsign: true, fl: true, ias: true, hdg: true };
        const tagParts: string[] = [];
        if (tf.callsign) tagParts.push(t.meta.callsign);
        if (tf.fl && ac.altitudeFt != null)
          tagParts.push(`FL${Math.round(ac.altitudeFt / 100)}`);
        if (tf.ias) tagParts.push(`${Math.round(ac.gsKt)}kt`);
        if (tf.hdg) tagParts.push(`${Math.round(ac.track)}°`);
        const tagText = tagParts.join(" ");
        return (
          <Fragment key={`ac-${t.meta.flightKey}`}>
            {decayTrail}
            {/* Invisible hit target. The visible plane Marker re-creates its
                divIcon every frame (to rotate with heading), which replaces its
                DOM element ~60×/sec — a click (mousedown+mouseup on one element)
                can never complete on it. This CircleMarker only ever moves
                (setLatLng, same element), so click + hover register reliably.
                Click locks the camera; hover shows detail without locking. */}
            <CircleMarker
              center={[ac.lat, ac.lon]}
              radius={12}
              pathOptions={{
                stroke: false,
                fill: true,
                fillOpacity: 0,
                interactive: true,
                className: "aircraft-hit",
              }}
              eventHandlers={{
                click: () => onAircraftClick?.(ti),
                mouseover: () => onAircraftHover?.(ti),
                mouseout: () => onAircraftHover?.(null),
              }}
            />
            <Marker
              position={[ac.lat, ac.lon]}
              interactive={false}
              icon={planeIcon(
                Math.round(ac.track),
                aircraftColor(t.meta.aircraftType),
                t.meta.flightKey === followKey,
              )}
              zIndexOffset={t.meta.flightKey === followKey ? 1000 : 0}
            >
              {tagText && (
                <Tooltip
                  permanent
                  direction="right"
                  offset={[10, 0]}
                  className="aircraft-tag"
                >
                  {tagText}
                </Tooltip>
              )}
            </Marker>
          </Fragment>
        );
      })}

      <FitBounds airways={airways} trajectories={trajectories} />
    </MapContainer>
  );
}
