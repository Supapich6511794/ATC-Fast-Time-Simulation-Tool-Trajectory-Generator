import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  airspaceAt,
  buildAirspaceIndex,
  pointInMultiPolygon,
  type AirspaceIndex,
} from "@/lib/airspace";
import type { SectorCollection, SectorKey } from "@/lib/geojson";

/**
 * The edge-bucketed ring index must give the SAME answer as the plain ray cast
 * — it is only allowed to skip edges that could never have changed the result.
 * Checked against the real published airspace, whose rings run to 28 000
 * vertices, at random points and at the awkward ones: a latitude exactly on a
 * vertex, where the straddle test is decided by `>` versus `<=`.
 */

const DIR = path.resolve(__dirname, "../public/data/sectors_corrected");
const LAYERS: [SectorKey, string][] = [
  ["bacc", "bacc_geo"],
  ["subsector", "bacc_subsector"],
  ["ctr", "ctr"],
  ["tma", "tma"],
  ["pdr", "pdr"],
];

function loadIndex(): AirspaceIndex {
  const data: Partial<Record<SectorKey, SectorCollection>> = {};
  for (const [key, file] of LAYERS) {
    data[key] = JSON.parse(
      fs.readFileSync(path.join(DIR, file + ".geojson"), "utf8"),
    ) as SectorCollection;
  }
  return buildAirspaceIndex(data);
}

/** The same index with the acceleration stripped — the reference. */
function plain(index: AirspaceIndex): AirspaceIndex {
  const out: AirspaceIndex = {};
  for (const [k, entries] of Object.entries(index) as [SectorKey, NonNullable<AirspaceIndex[SectorKey]>][]) {
    out[k] = entries.map((e) => ({ ...e, acc: undefined }));
  }
  return out;
}

/** A small deterministic generator, so a failure reproduces. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe("airspace ring index", () => {
  const index = loadIndex();
  const reference = plain(index);

  it("actually indexed the big rings", () => {
    const accelerated = Object.values(index)
      .flat()
      .filter((e) => e!.acc?.some((poly) => poly.some(Boolean)));
    expect(accelerated.length).toBeGreaterThan(0);
  });

  it("answers exactly like the plain ray cast at random points", () => {
    const next = rng(20251223);
    let disagreements = 0;
    let inside = 0;
    for (let n = 0; n < 6000; n++) {
      const lon = 96 + next() * 12;
      const lat = 4 + next() * 17;
      const alt = next() < 0.2 ? null : next() * 45000;
      const a = airspaceAt(index, lon, lat, alt);
      const b = airspaceAt(reference, lon, lat, alt);
      if (JSON.stringify(a) !== JSON.stringify(b)) disagreements++;
      if (a.bacc || a.ctr || a.tma) inside++;
    }
    expect(disagreements).toBe(0);
    // A vacuous pass — every point outside everything — would prove nothing.
    expect(inside).toBeGreaterThan(200);
  });

  it("agrees for every feature, at latitudes exactly on a vertex", () => {
    const next = rng(7);
    let checked = 0;
    for (const entries of Object.values(index)) {
      for (const e of entries!) {
        const ring = e.mp[0][0];
        for (let n = 0; n < 40; n++) {
          const v = ring[Math.floor(next() * ring.length)];
          // On the vertex's latitude, at longitudes across the feature's width.
          const lon = e.bbox[0] + next() * (e.bbox[2] - e.bbox[0]);
          const lat = v[1];
          const viaIndex = airspaceAt({ bacc: [e] }, lon, lat, null);
          const viaPlain = pointInMultiPolygon(lon, lat, e.mp);
          expect(!!viaIndex.bacc).toBe(viaPlain);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });
});
