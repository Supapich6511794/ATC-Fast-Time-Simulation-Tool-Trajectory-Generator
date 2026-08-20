/**
 * The 24-hour Thai traffic sample (dummy_data/thai24h_traffic.*) must import
 * through the same parser the app's upload button uses — otherwise the file is
 * just text on disk. This reads the checked-in CSV and GeoJSON and asserts the
 * round-trip recovers every flight with its plan intact, including the
 * international and overflight ones the other dummy files don't contain.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { parseFlightFile } from "./flightFile";

const DUMMY = resolve(__dirname, "../../dummy_data/thai24h_traffic.csv");
const DUMMY_GJ = resolve(__dirname, "../../dummy_data/thai24h_traffic.geojson");

const csv = readFileSync(DUMMY, "utf-8");
const records = await parseFlightFile(new File([csv], "thai24h_traffic.csv"));
const geo = JSON.parse(readFileSync(DUMMY_GJ, "utf-8")) as {
  features: { properties: Record<string, unknown> }[];
};
const routeFeatures = geo.features.filter(
  (f) => f.properties.feature_type === "route",
);

describe("thai24h_traffic dummy file", () => {
  it("parses one plan per FLIGHT block", () => {
    const blocks = (csv.match(/^FLIGHT \d+ of \d+/gm) ?? []).length;
    expect(blocks).toBeGreaterThan(100);
    expect(records).toHaveLength(blocks);
    expect(records).toHaveLength(routeFeatures.length);
  });

  it("gives every flight a callsign, city pair, level, route and EOBT", () => {
    for (const r of records) {
      expect(r.callsign).toMatch(/^[A-Z]{3}\d+$/);
      expect(r.adep).toMatch(/^[A-Z]{4}$/);
      expect(r.ades).toMatch(/^[A-Z]{4}$/);
      expect(r.adep).not.toEqual(r.ades);
      expect(r.rfl).toBeGreaterThanOrEqual(100);
      expect(r.rfl).toBeLessThanOrEqual(430);
      expect(r.route?.trim()).toBeTruthy();
      expect(r.eobt).toMatch(/^2025-12-23T\d{2}:\d{2}$/);
    }
  });

  it("carries 4D samples in Thai airspace, ordered in time", () => {
    // The stacked ATC-style CSV imports as *plans* (that is what the format is
    // for — pre-fill the form, then regenerate); the 4D samples live in the
    // block tables and the GeoJSON points, so check those directly.
    const byKey = new Map<string, { ts: number; alt: number }[]>();
    for (const f of geo.features) {
      if (f.properties.feature_type === "route") continue;
      const key = String(f.properties.flight_key);
      const [lon, lat] = (f as unknown as { geometry: { coordinates: number[] } })
        .geometry.coordinates;
      expect(lat).toBeGreaterThan(-15);
      expect(lat).toBeLessThan(40);
      expect(lon).toBeGreaterThan(90);
      expect(lon).toBeLessThan(115);
      const alt = Number(f.properties.altitude_ft);
      expect(alt).toBeGreaterThanOrEqual(0);
      expect(alt).toBeLessThanOrEqual(45000);
      byKey.set(key, [
        ...(byKey.get(key) ?? []),
        { ts: new Date(String(f.properties.epoch_ts)).getTime(), alt },
      ]);
    }
    expect(byKey.size).toBe(routeFeatures.length);
    for (const [, pts] of byKey) {
      expect(pts.length).toBeGreaterThan(2);
      const ts = pts.map((p) => p.ts);
      expect(ts).toEqual([...ts].sort((a, b) => a - b));
    }
  });

  it("covers all four traffic categories over a full 24 hours", () => {
    const cats = new Set(
      routeFeatures.map((f) => String(f.properties.flight_category)),
    );
    expect([...cats].sort()).toEqual([
      "arrival",
      "departure",
      "domestic",
      "overflight",
    ]);
    const hours = new Set(records.map((r) => r.eobt?.slice(11, 13)));
    expect(hours.size).toBe(24);
  });

  it("files a Thai SID/STAR only at the Thai end of an international leg", () => {
    for (const f of routeFeatures) {
      const p = f.properties as Record<string, string>;
      if (!p.adep.startsWith("VT")) expect(p.sid).toBe("");
      if (!p.ades.startsWith("VT")) expect(p.star).toBe("");
      // An overflight never lands in Thailand, so it carries no arrival
      // procedure and no runway at either end.
      if (p.flight_category === "overflight") {
        expect([p.sid, p.star, p.approach, p.dep_rwy, p.arr_rwy]).toEqual([
          "", "", "", "", "",
        ]);
      }
    }
  });

  it("keeps an overflight level for the whole FIR crossing", () => {
    const overflights = new Set(
      routeFeatures
        .filter((f) => f.properties.flight_category === "overflight")
        .map((f) => String(f.properties.flight_key)),
    );
    expect(overflights.size).toBeGreaterThan(10);
    const byKey = new Map<string, number[]>();
    for (const f of geo.features) {
      const key = String(f.properties.flight_key);
      if (f.properties.feature_type === "route" || !overflights.has(key)) continue;
      const alt = Number(f.properties.altitude_ft);
      byKey.set(key, [...(byKey.get(key) ?? []), alt]);
    }
    for (const [, alts] of byKey) {
      expect(new Set(alts).size).toBe(1);
      expect(alts[0]).toBeGreaterThanOrEqual(28000);
    }
  });
});
