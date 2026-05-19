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
import { type ReactNode, useEffect, useMemo } from "react";
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
import type { TrajectoryResult } from "@/lib/trajectory/types";
import type { AircraftState } from "@/lib/useSimPlayback";
import type {
  AirwayCollection,
  FirCollection,
  Waypoint,
} from "@/lib/types";

interface Props {
  basemap: Basemap;
  airways: AirwayCollection | null;
  /** Reference waypoint layer (all fixes), or null to hide. */
  waypoints: Waypoint[] | null;
  fir: FirCollection | null;
  trajectory: TrajectoryResult | null;
  aircraft: AircraftState | null;
}

const DEFAULT_CENTER: L.LatLngExpression = [11.0, 99.5];
const DEFAULT_ZOOM = 6;

/** Fit to the most relevant data: trajectory if any, otherwise airways. */
function FitBounds({
  airways,
  trajectory,
}: Pick<Props, "airways" | "trajectory">) {
  const map = useMap();
  useEffect(() => {
    const b = L.latLngBounds([]);
    if (trajectory && trajectory.points.length) {
      trajectory.points.forEach((p) => b.extend([p.lat, p.lon]));
    } else if (airways) {
      airways.features.forEach((f) =>
        f.geometry.coordinates.forEach(([lon, lat]) => b.extend([lat, lon])),
      );
    }
    if (b.isValid()) map.fitBounds(b, { padding: [40, 40] });
  }, [map, airways, trajectory]);
  return null;
}

/** A small SVG plane icon, rotated to the current heading. */
function planeIcon(track: number): L.DivIcon {
  return L.divIcon({
    className: "aircraft-icon",
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    html: `<div style="transform: rotate(${track}deg)">
      <svg viewBox="0 0 24 24" width="32" height="32" fill="#22d3ee"
           stroke="#0f172a" stroke-width="1">
        <path d="M12 2 L14 10 L22 14 L22 16 L14 13 L13 20 L16 22 L16 23
                 L12 22 L8 23 L8 22 L11 20 L10 13 L2 16 L2 14 L10 10 Z"/>
      </svg></div>`,
  });
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
  airport,
  detail,
}: {
  position: L.LatLngExpression;
  fill: string;
  stroke: string;
  ident: string;
  role: "Start" | "End";
  airport: string;
  detail: string;
}) {
  return (
    <HoverFix
      center={position}
      radius={7}
      hitRadius={18}
      pathOptions={{
        color: stroke,
        weight: 2,
        fillColor: fill,
        fillOpacity: 1,
      }}
    >
      <Tooltip direction="top" offset={[0, -9]} sticky>
        <strong>{ident}</strong> · {role} ({airport})
      </Tooltip>
      <Popup>
        <strong>
          {ident} — {role} ({airport})
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
  trajectory,
  aircraft,
}: Props) {
  const tiles = BASEMAPS[basemap];

  // Round heading so the icon isn't rebuilt every animation frame.
  const icon = useMemo(
    () => (aircraft ? planeIcon(Math.round(aircraft.track)) : null),
    [aircraft],
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

  const waypointLayer = useMemo(
    () =>
      waypoints?.map((w) => (
        <HoverFix
          key={`wp-${w.ident}`}
          center={[w.lat, w.lon]}
          radius={2.5}
          hitRadius={10}
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

  const trajectoryLayer = useMemo(() => {
    if (!trajectory || trajectory.points.length < 2) return null;
    const pts = trajectory.points;
    const line: L.LatLngExpression[] = pts.map((p) => [p.lat, p.lon]);
    const { route, meta } = trajectory;

    return (
      <>
        <Polyline
          positions={line}
          pathOptions={{ color: "#22d3ee", weight: 3, opacity: 0.95 }}
        />

        {/* Intermediate fixes only; the first/last are the Start/End
            markers below (avoids stacked overlapping markers). */}
        {route.slice(1, -1).map((w) => (
          <HoverFix
            key={w.ident}
            center={[w.lat, w.lon]}
            radius={4}
            hitRadius={13}
            pathOptions={{
              color: "#0f172a",
              weight: 1,
              fillColor: "#38bdf8",
              fillOpacity: 1,
            }}
          >
            <Tooltip direction="top" offset={[0, -7]} sticky>
              {w.ident}
            </Tooltip>
            <Popup>
              <strong>{w.ident}</strong>
              <br />
              {w.lat.toFixed(5)}, {w.lon.toFixed(5)}
            </Popup>
          </HoverFix>
        ))}

        <EndpointMarker
          position={line[0]}
          fill="#22c55e"
          stroke="#052e16"
          ident={route[0]?.ident ?? ""}
          role="Start"
          airport={meta.adep}
          detail={meta.eobtIso}
        />
        <EndpointMarker
          position={line[line.length - 1]}
          fill="#ef4444"
          stroke="#450a0a"
          ident={route[route.length - 1]?.ident ?? ""}
          role="End"
          airport={meta.ades}
          detail={pts[pts.length - 1].epoch_ts}
        />
      </>
    );
  }, [trajectory]);

  return (
    <MapContainer
      center={DEFAULT_CENTER}
      zoom={DEFAULT_ZOOM}
      scrollWheelZoom
      preferCanvas
      style={{ height: "100%", width: "100%" }}
    >
      <TileLayer key={basemap} attribution={tiles.attribution} url={tiles.url} />

      {firLayer}
      {airwayLayer}
      {waypointLayer}
      {trajectoryLayer}

      {trajectory && aircraft && icon && (
        <Marker position={[aircraft.lat, aircraft.lon]} icon={icon}>
          <Tooltip direction="top" offset={[0, -14]}>
            {trajectory.meta.callsign} ·{" "}
            {aircraft.altitudeFt != null
              ? `${Math.round(aircraft.altitudeFt)} ft`
              : "cruise"}{" "}
            · {Math.round(aircraft.gsKt)} kt
          </Tooltip>
        </Marker>
      )}

      <FitBounds airways={airways} trajectory={trajectory} />
    </MapContainer>
  );
}
