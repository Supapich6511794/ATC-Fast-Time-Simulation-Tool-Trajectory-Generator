/**
 * The join between the PDR polygons and their published activity times, and
 * the vertical limits read off the polygons.
 *
 * Run against the shipped data, because the failure modes here are data ones:
 * a polygon whose schedule does not join, a limit string the parser does not
 * know, or an area published with a timetable and no geometry — which can never
 * be detected at all and must be a known quantity rather than a surprise.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAltFt } from "@/lib/airspace";

import { buildPdrAreas } from "./areas";
import type { PdrActivityFile } from "./types";

const load = (p: string) =>
  JSON.parse(readFileSync(resolve(__dirname, "../../public/data/" + p), "utf-8"));

const activity = load("aixm/pdr_activity.json") as PdrActivityFile;
const geo = load("sectors_corrected/pdr.geojson") as { features: GeoJSON.Feature[] };
const areas = buildPdrAreas(geo, activity);

describe("parseAltFt covers every limit string the PDR data uses", () => {
  it("reads the spelled-out surface tokens as ground", () => {
    for (const token of ["GND", "SFC", "MSL", "SURFACE", "surface"]) {
      expect(parseAltFt(token)).toBe(0);
    }
  });

  it("reads UNL as no ceiling", () => {
    expect(parseAltFt("UNL")).toBe(Infinity);
  });

  it("parses every lower and upper limit in the shipped polygons", () => {
    for (const f of geo.features) {
      const p = (f.properties ?? {}) as Record<string, unknown>;
      expect(Number.isNaN(parseAltFt(p.lowerlimit))).toBe(false);
      expect(Number.isNaN(parseAltFt(p.upperlimit))).toBe(false);
    }
  });
});

describe("the joined areas", () => {
  it("gives every polygon a schedule", () => {
    expect(areas.length).toBe(geo.features.length);
    expect(areas.filter((a) => !a.activity)).toEqual([]);
  });

  it("gives every area a usable vertical band", () => {
    for (const a of areas) {
      expect(Number.isNaN(a.lowerFt)).toBe(false);
      expect(a.upperFt).toBeGreaterThan(a.lowerFt);
    }
  });

  it("keeps the polygon class and the AIXM class in step", () => {
    for (const a of areas) {
      if (a.activity) expect(a.activity.type).toBe(a.kind);
    }
  });

  it("places every area inside the Thai FIR", () => {
    for (const a of areas) {
      const [minLon, minLat, maxLon, maxLat] = a.bbox;
      expect(minLon).toBeGreaterThan(92);
      expect(maxLon).toBeLessThan(112);
      expect(minLat).toBeGreaterThan(2);
      expect(maxLat).toBeLessThan(23);
    }
  });
});

describe("published areas with no geometry", () => {
  // These have a timetable but no polygon, so no route can ever be tested
  // against them. Pinned so the gap is a known quantity: if the overlay gains
  // geometry later this test says so, and if it silently grows this test fails.
  it("is limited to the TRAs and the listed Danger areas", () => {
    const withPolygon = new Set(
      areas.map((a) => a.activity?.designator).filter(Boolean),
    );
    const missing = activity.areas
      .filter((a) => !withPolygon.has(a.designator))
      .map((a) => a.designator)
      .sort();
    expect(missing).toEqual(
      [
        "VTD2", "VTD3A", "VTD3B", "VTD41A", "VTD41B", "VTD461", "VTD56",
        "VTD5A", "VTD5B", "VTD6A", "VTD6B", "VTD8A", "VTD8B", "VTD8C",
        "VTD8D", "VTD8E", "VTD8F", "VTD8G",
        "VTTRA2", "VTTRA3A", "VTTRA3B", "VTTRA46", "VTTRA5", "VTTRA56A",
        "VTTRA56B",
      ].sort(),
    );
  });

  it("has geometry for every Prohibited and Restricted area", () => {
    const withPolygon = new Set(
      areas.map((a) => a.activity?.designator).filter(Boolean),
    );
    const missingPR = activity.areas.filter(
      (a) => (a.type === "P" || a.type === "R") && !withPolygon.has(a.designator),
    );
    expect(missingPR).toEqual([]);
  });
});
