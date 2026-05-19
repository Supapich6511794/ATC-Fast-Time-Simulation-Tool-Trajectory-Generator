/**
 * Strongly-typed shapes for the real `airway waypoint.geojson` file.
 *
 * The file is a FeatureCollection of LineString segments. Each feature is one
 * airway leg between two consecutive waypoints; BOTH endpoint waypoints (with
 * their real lat/lon) are carried in the feature's `properties`. We type only
 * the fields we actually read.
 */

import type {
  FeatureCollection,
  LineString,
  MultiPolygon,
  Polygon,
} from "geojson";

/** Properties on each airway-segment feature, as found in the source file. */
export interface AirwaySegmentProperties {
  fid: number;
  /** Airway designator, e.g. "A1", "M770". */
  route_identifier: string;
  /** Sequence number of this leg within the airway. */
  seqno: number;
  icao_code: string;

  /** Start waypoint of the leg. */
  waypoint_identifier: string;
  waypoint_latitude: number;
  waypoint_longitude: number;

  /** End waypoint of the leg. */
  waypoint_identifier_2: string;
  waypoint_latitude_2: number;
  waypoint_longitude_2: number;

  minimum_altitude1?: number;
  maximum_altitude?: number;
  inbound_distance?: number;
}

/** The source file: a collection of airway LineString segments. */
export type AirwayCollection = FeatureCollection<
  LineString,
  AirwaySegmentProperties
>;

/** Properties on each FIR (Flight Information Region) polygon. */
export interface FirProperties {
  fid: number;
  id: number;
  name: string;
  descriptio?: string;
}

/** `fir.geojson` — worldwide FIR boundaries (Multi)Polygons. */
export type FirCollection = FeatureCollection<
  Polygon | MultiPolygon,
  FirProperties
>;

/**
 * A unique waypoint, derived purely from coordinates already present in the
 * source file (never fabricated).
 */
export interface Waypoint {
  ident: string;
  lat: number;
  lon: number;
  /** Airway designators this waypoint appears on. */
  airways: string[];
}
