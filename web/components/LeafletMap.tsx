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
import { Fragment, type ReactNode, useEffect, useMemo } from "react";
import {
  CircleMarker,
  GeoJSON,
  MapContainer,
  Marker,
  Polyline,
  Popup,
  TileLayer,
  Tooltip,
  useMap,
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
import type { ProcLayerState } from "@/components/LayerOptions";
import type { ProcedureDto } from "@/lib/api";

interface Props {
  basemap: Basemap;
  airways: AirwayCollection | null;
  /** Reference waypoint layer (all fixes), or null to hide. */
  waypoints: Waypoint[] | null;
  fir: FirCollection | null;
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

/** Filtered SID/STAR fix dots (deduped by ident), or null when off. */
function buildWaypointLayer(
  wpts: ProcedureWaypointCollection | null | undefined,
  state: ProcLayerState | undefined,
  color: string,
): ReactNode {
  if (!wpts || !state?.waypoints) return null;
  const seen = new Map<string, { lat: number; lon: number }>();
  for (const f of wpts.features) {
    const p = f.properties;
    if (!passesProcFilter(p, state)) continue;
    const ident = p.waypoint_identifier ?? null;
    const lat = p.waypoint_latitude ?? null;
    const lon = p.waypoint_longitude ?? null;
    if (!ident || lat == null || lon == null) continue;
    if (!seen.has(ident)) seen.set(ident, { lat, lon });
  }
  return [...seen.entries()].map(([ident, { lat, lon }]) => (
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
      <Tooltip direction="top" offset={[0, -4]}>
        {ident}
      </Tooltip>
    </CircleMarker>
  ));
}

/** Blue map-pin airport icon (airplane glyph) with a hover pulse glow. */
function airportIcon(): L.DivIcon {
  return L.divIcon({
    className: "airport-icon",
    iconSize: [30, 38],
    iconAnchor: [15, 36], // tip of the pin sits on the coordinate
    html: `<span class="airport-pulse"></span><span class="airport-pin">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="#fff">
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
function planeIcon(track: number, color: string): L.DivIcon {
  return L.divIcon({
    className: "aircraft-icon",
    iconSize: [20, 20],
    iconAnchor: [10, 10],
    html: `<div style="transform: rotate(${track}deg)">
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
  waypoints,
  fir,
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
  hiddenKeys,
  previewRoutes,
  typeFilter,
  onProcedureClick,
  tagFields,
  simT,
  playbackIdx,
  onMapReady,
}: Props) {
  const tiles = BASEMAPS[basemap];

  // Elapsed-time sample table per trajectory (rebuilt only on new data).
  const samplesByRoute = useMemo(
    () => trajectories.map((t) => toSamples(t.points)),
    [trajectories],
  );

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
          style={() => ({ color: "#f59e0b", weight: 1, opacity: 0.35 })}
        />
      ),
    [airways],
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

  // Gates — small orange dots with the gate name on hover.
  const gateLayer = useMemo(() => {
    if (!gates) return null;
    return gates.features
      .map((f, i) => {
        const p = f.properties;
        const lat = p.gate_latitude;
        const lon = p.gate_longitude;
        if (lat == null || lon == null) return null;
        return (
          <CircleMarker
            key={`gate-${p.airport_identifier}-${p.gate_identifier}-${i}`}
            center={[lat, lon]}
            radius={2}
            pathOptions={{
              color: GATE_COLOR,
              weight: 1,
              fillColor: GATE_COLOR,
              fillOpacity: 0.8,
            }}
          >
            <Tooltip direction="top" offset={[0, -3]}>
              {p.airport_identifier} · {p.gate_identifier}
            </Tooltip>
          </CircleMarker>
        );
      })
      .filter(Boolean);
  }, [gates]);

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

  // Runway threshold points (white squares).
  const runwayLayer = useMemo(() => {
    if (!runways) return null;
    return runways.map((r, i) => (
      <CircleMarker
        key={`rwy-${r.airport}-${r.ident}-${i}`}
        center={[r.lat, r.lon]}
        radius={3}
        pathOptions={{
          color: "#0f172a",
          weight: 1,
          fillColor: RUNWAY_COLOR,
          fillOpacity: 0.95,
        }}
      >
        <Tooltip direction="top" offset={[0, -3]}>
          {r.airport} · RWY {r.ident}
        </Tooltip>
      </CircleMarker>
    ));
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
                weight: 3,
                opacity: 0.95,
                lineCap: "round",
                lineJoin: "round",
              }}
            />,
          );
        }

        return (
          <Fragment key={kp}>
            {/* Faint dark casing under the altitude-coloured segments so
                the route stays readable over both light and dark tiles. */}
            <Polyline
              positions={line}
              interactive={false}
              pathOptions={{
                color: "#0f172a",
                weight: 5,
                opacity: 0.45,
                lineCap: "round",
                lineJoin: "round",
              }}
            />
            {altSegments}

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
            {trajectory.profile?.toc && (
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
            {trajectory.profile?.tod && (
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
    [trajectories, multiRoute, hiddenKeys, typeFilter],
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

      {firLayer}
      {airwayLayer}
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
        // NB: a hidden route hides only its line (see trajectoryLayer) — the
        // aircraft icon stays visible so the flight can still be tracked.
        const ac = aircraftAt(samplesByRoute[ti] ?? [], simT);
        if (!ac) return null;
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
          <Marker
            key={`ac-${t.meta.flightKey}`}
            position={[ac.lat, ac.lon]}
            icon={planeIcon(Math.round(ac.track), aircraftColor(t.meta.aircraftType))}
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
        );
      })}

      <FitBounds airways={airways} trajectories={trajectories} />
    </MapContainer>
  );
}
