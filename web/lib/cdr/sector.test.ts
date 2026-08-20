/** Which ATS unit is responsible for resolving a conflict. */
import { describe, expect, it } from "vitest";

import { formatAirspace, type AirspaceMembership } from "@/lib/airspace";
import { conflictSector, unitName, type SectorPoint } from "./sector";

/** A resolver with a made-up geography, so the test is about the RULE and not
 *  about whether a particular Bangkok polygon happens to be where I think:
 *    lat < 13    -> BANGKOK TMA (below 12000 ft) else sector 3S
 *    13 <= lat   -> sector 4S
 *    lat > 20    -> outside all airspace
 */
const resolve = (lat: number, _lon: number, altFt: number | null): AirspaceMembership => {
  if (lat > 20) return {};
  if (lat < 13) {
    return altFt != null && altFt < 12000 ? { tma: "BANGKOK TMA" } : { bacc: "3S" };
  }
  return { bacc: "4S" };
};

const at = (lat: number, altFt: number | null = 30000): SectorPoint => ({
  lat,
  lon: 100,
  altFt,
});

const IDS = { a: "F1", b: "F2" };

describe("conflictSector", () => {
  it("names the unit the LOSS would happen in, not the one they started in", () => {
    // Both aircraft are still in 4S now, but they close on each other south of
    // the boundary — 3S has to prevent it.
    const s = conflictSector(
      IDS,
      { a: at(12.4), b: at(12.6) },
      { a: at(14), b: at(15) },
      resolve,
    );
    expect(s.label).toBe("3S");
    expect(s.layer).toBe("bacc");
  });

  it("resolves BETWEEN the pair, so a boundary does not decide it by luck", () => {
    // One each side: taking either aircraft alone would give a different answer
    // depending on which was picked. The midpoint is the conflict itself.
    const straddle = conflictSector(
      IDS,
      { a: at(12.9), b: at(13.1) },
      { a: at(12.9), b: at(13.1) },
      resolve,
    );
    const flipped = conflictSector(
      { a: "F2", b: "F1" },
      { a: at(13.1), b: at(12.9) },
      { a: at(13.1), b: at(12.9) },
      resolve,
    );
    expect(straddle.label).toBe(flipped.label);
  });

  it("uses the pair's mean LEVEL — the hierarchy is altitude-aware", () => {
    // Same place, different levels: inside the TMA's band it is Approach's,
    // above the ceiling it is the area sector's.
    const low = conflictSector(
      IDS,
      { a: at(12, 8000), b: at(12, 8000) },
      { a: at(12, 8000), b: at(12, 8000) },
      resolve,
    );
    const high = conflictSector(
      IDS,
      { a: at(12, 30000), b: at(12, 30000) },
      { a: at(12, 30000), b: at(12, 30000) },
      resolve,
    );
    expect(low.label).toBe("Bangkok TMA");
    expect(low.layer).toBe("tma");
    expect(high.label).toBe("3S");
  });

  it("flags a fix that crosses a boundary as needing coordination", () => {
    const s = conflictSector(
      IDS,
      { a: at(13.5), b: at(13.5) },
      { a: at(12.5), b: at(14) }, // one in 3S, one in 4S
      resolve,
    );
    expect(s.byFlight).toEqual({ F1: "3S", F2: "4S" });
    expect(s.coordination).toBe(true);
  });

  it("does not flag coordination when both are with the same unit", () => {
    const s = conflictSector(
      IDS,
      { a: at(14), b: at(14) },
      { a: at(14), b: at(14.2) },
      resolve,
    );
    expect(s.coordination).toBe(false);
    expect(s.byFlight.F1).toBe("4S");
  });

  it("does not cry coordination over two aircraft that are simply off the map", () => {
    // The data covers the Bangkok FIR; outside it there is no unit to name, and
    // "different units" would be a fabrication.
    const s = conflictSector(
      IDS,
      { a: at(25), b: at(25) },
      { a: at(25), b: at(26) },
      resolve,
    );
    expect(s.label).toBe("");
    expect(s.layer).toBeNull();
    expect(s.coordination).toBe(false);
  });

  it("still answers when only one aircraft has a known position", () => {
    const s = conflictSector(IDS, { a: at(12.5), b: null }, { a: at(12.5), b: null }, resolve);
    expect(s.label).toBe("3S");
    expect(s.byFlight).toEqual({ F1: "3S" });
    expect(s.coordination).toBe(false);
  });

  it("says nothing rather than guessing when the pair has no position at all", () => {
    const s = conflictSector(IDS, { a: null, b: null }, { a: null, b: null }, resolve);
    expect(s.label).toBe("");
    expect(s.byFlight).toEqual({});
  });
});

describe("a restricted area is not an ATS unit", () => {
  // The map hierarchy puts PDR on top, because "you are inside VTD58" is the
  // fact a pilot label needs. For "who resolves this conflict" it is the wrong
  // answer — nobody works a danger area. 16% of the samples in the conflict
  // fixture fall inside one, so this is not a corner case.
  const inDanger = (lat: number, _lon: number, _alt: number | null): AirspaceMembership =>
    lat < 13
      ? { pdr: ["VTD58 SATTAHIP"], bacc: "1S" }
      : { pdr: ["VTD59 CHANDI"] };

  it("names the controlling sector, not the danger area over it", () => {
    const s = conflictSector(IDS, { a: at(12), b: at(12) }, { a: at(12), b: at(12) }, inDanger);
    expect(s.label).toBe("1S");
    expect(s.layer).toBe("bacc");
  });

  it("still reports the area — it constrains what may be issued there", () => {
    const s = conflictSector(IDS, { a: at(12), b: at(12) }, { a: at(12), b: at(12) }, inDanger);
    expect(s.restricted).toEqual(["VTD58 SATTAHIP"]);
  });

  it("says no unit when a danger area is ALL there is", () => {
    // Honest: there is genuinely no controlling volume coded here, and naming
    // the danger area as the responsible unit would be a fabrication.
    const s = conflictSector(IDS, { a: at(14), b: at(14) }, { a: at(14), b: at(14) }, inDanger);
    expect(s.label).toBe("");
    expect(s.restricted).toEqual(["VTD59 CHANDI"]);
  });

  it("does not call it a boundary crossing when only the danger area differs", () => {
    const sameSector = (lat: number): AirspaceMembership =>
      lat < 12.5 ? { pdr: ["VTD58"], bacc: "1S" } : { bacc: "1S" };
    const s = conflictSector(
      IDS,
      { a: at(12), b: at(13) },
      { a: at(12), b: at(13) },
      (lat) => sameSector(lat),
    );
    expect(s.coordination).toBe(false);
  });
});

describe("unitName", () => {
  it("calls an area sector a sector, and a named volume by its name", () => {
    expect(unitName("3S", "bacc")).toBe("Sector 3S");
    expect(unitName("7N", "subsector")).toBe("Sector 7N");
    expect(unitName("Bangkok TMA", "tma")).toBe("Bangkok TMA");
    expect(unitName("Bangkok CTR", "ctr")).toBe("Bangkok CTR");
  });

  it("is honest when there is no unit", () => {
    expect(unitName("", null)).toBe("outside known airspace");
  });
});

/* ---------------------------------------------------------------------------
 * Against the real Bangkok airspace.
 *
 * The rules above are checked on a made-up geography. What they are FOR is the
 * actual sector file, so the conflict fixture is run through it: if the polygons
 * or their vertical bands change such that real Thai conflicts no longer resolve
 * to a unit, the chip would silently disappear from the UI — this fails instead.
 * ------------------------------------------------------------------------ */

import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { airspaceAt, buildAirspaceIndex } from "@/lib/airspace";
import { SECTORS, type SectorCollection, type SectorKey } from "@/lib/geojson";

const SECTOR_DIR = resolvePath(__dirname, "../../public/data/sectors_corrected");
const FIXTURE = resolvePath(
  __dirname,
  "../../../dummy_data/conflict_test_10_flights.geojson",
);
const realPresent =
  existsSync(SECTOR_DIR) && existsSync(resolvePath(SECTOR_DIR, "bacc_geo.geojson"));

const sectorData: Partial<Record<SectorKey, SectorCollection | null>> = {};
if (realPresent) {
  for (const s of SECTORS) {
    const f = resolvePath(SECTOR_DIR, `${s.file}.geojson`);
    sectorData[s.key] = existsSync(f)
      ? (JSON.parse(readFileSync(f, "utf-8")) as SectorCollection)
      : null;
  }
}
const realIndex = realPresent ? buildAirspaceIndex(sectorData) : {};
const realResolve = (lat: number, lon: number, altFt: number | null) =>
  airspaceAt(realIndex, lon, lat, altFt);

describe.skipIf(!realPresent)("against the real Bangkok sector file", () => {
  // Bangkok itself, at levels that pick out different layers of the hierarchy.
  const BKK = { lat: 13.6917, lon: 100.7503 };

  it("names an area sector for an en-route conflict over Thailand", () => {
    const s = conflictSector(
      IDS,
      { a: { ...BKK, altFt: 35000 }, b: { ...BKK, altFt: 35000 } },
      { a: { ...BKK, altFt: 35000 }, b: { ...BKK, altFt: 35000 } },
      realResolve,
    );
    expect(s.label).not.toBe("");
    expect(s.layer).toBe("bacc");
  });

  it("hands a low-level conflict over Suvarnabhumi to the terminal unit", () => {
    // Approach/Tower, not the area sector — the hierarchy is what decides, and
    // the altitude is what puts the aircraft inside it.
    const low = conflictSector(
      IDS,
      { a: { ...BKK, altFt: 4000 }, b: { ...BKK, altFt: 4000 } },
      { a: { ...BKK, altFt: 4000 }, b: { ...BKK, altFt: 4000 } },
      realResolve,
    );
    expect(["ctr", "tma"]).toContain(low.layer);
    expect(low.label).not.toBe("");
  });

  it("resolves a unit for every flight in the conflict fixture", () => {
    if (!existsSync(FIXTURE)) return; // generated file, may be absent
    const gj = JSON.parse(readFileSync(FIXTURE, "utf-8")) as {
      features: {
        properties: Record<string, unknown>;
        geometry: { type: string; coordinates: number[] | number[][] };
      }[];
    };
    const pts = gj.features.filter(
      (f) => f.properties.feature_type !== "route" && f.geometry.type === "Point",
    );
    expect(pts.length).toBeGreaterThan(50);
    let named = 0;
    for (const f of pts) {
      const [lon, lat] = f.geometry.coordinates as number[];
      const alt = Number(f.properties.altitude_ft ?? 0);
      const m = realResolve(lat, lon, alt);
      if (formatAirspace(m, "compact")) named++;
    }
    // These are Thai domestic conflicts, so nearly every sample is inside
    // controlled airspace. A few can sit outside (the FIR edge, on the ground).
    expect(named / pts.length).toBeGreaterThan(0.9);
  });
});

