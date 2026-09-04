/**
 * End-to-end PDR check, run over the REAL AIRAC data the app ships: the PDR
 * polygons (`sectors_corrected/pdr.geojson`), their AIXM activity times
 * (`aixm/pdr_activity.json`), the published route table (`aip_routes_VT.json`)
 * and the navdata cache (`aip_VT.json`).
 *
 * Two properties are load-bearing and asserted here as well as the findings:
 *
 *   * the SAME route is or is not a conflict depending only on the time of day
 *     — that is the whole reason the schedules were ingested;
 *   * every suggestion is a route the AIP already publishes for that pair and
 *     direction. The tool must never invent a routing through Thai airspace.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { Fix } from "@/lib/aip";
import type { AipRoute } from "@/lib/aipRoutes";

import { buildPdrAreas } from "./areas";
import { analysePdr } from "./detect";
import { pathFromFixes } from "./penetration";
import type { PdrActivityFile, PdrArea } from "./types";

const dataFile = (p: string) =>
  JSON.parse(readFileSync(resolve(__dirname, "../../public/data/" + p), "utf-8"));

const activity = dataFile("aixm/pdr_activity.json") as PdrActivityFile;
const pdrGeo = dataFile("sectors_corrected/pdr.geojson") as {
  features: GeoJSON.Feature[];
};
const routes = (dataFile("aip_routes_VT.json") as { routes: AipRoute[] }).routes;
const aip = dataFile("aip_VT.json") as {
  waypoints: Record<string, { lat: number; lon: number }>;
  airways: Record<string, string[]>;
};

const fixes: Fix[] = Object.entries(aip.waypoints).map(([ident, w]) => ({
  ident,
  lat: w.lat,
  lon: w.lon,
}));

const areas = buildPdrAreas(pdrGeo, activity);
const find = (ident: string): PdrArea => {
  const a = areas.find((x) => x.ident === ident);
  if (!a) throw new Error("no area " + ident);
  return a;
};

const MON = Date.UTC(2026, 8, 7); // Monday
const HOUR = 3600000;

/** A short east-west path straight through the middle of an area, at a level
 *  inside its band. Enough to guarantee an incursion without depending on the
 *  exact shape of the published polygon. */
function pathThrough(area: PdrArea, startMs: number): ReturnType<typeof pathFromFixes> {
  const { lat, lon } = area.centroid;
  const altFt = Number.isFinite(area.upperFt)
    ? Math.max(area.lowerFt + 500, (area.lowerFt + area.upperFt) / 2)
    : area.lowerFt + 5000;
  return pathFromFixes(
    [
      { lat, lon: lon - 0.4 },
      { lat, lon: lon + 0.4 },
    ],
    { startMs, gsKt: 450, altFt },
  );
}

const baseInput = {
  adep: "VTBD",
  ades: "VTCC",
  filedRoute: "OLVUK Y26 MARNI",
  actype: "B738",
  rflFt: 33000,
  gsKt: 450,
  areas,
  publishedRoutes: routes,
  fixes,
  airways: aip.airways,
};

describe("the joined dataset", () => {
  it("matches a published activity record to almost every PDR polygon", () => {
    const withSchedule = areas.filter((a) => a.activity).length;
    expect(areas.length).toBeGreaterThan(60);
    expect(withSchedule).toBe(areas.length);
  });

  it("joins the lettered sub-areas the AIXM export splits out", () => {
    // pdr.geojson has VTD21 with areacode 1/2/3; AIXM calls them VTD21A1..A3.
    const subs = areas.filter((a) => a.ident === "VTD21");
    expect(subs.length).toBeGreaterThan(1);
    for (const s of subs) expect(s.activity?.designator).toMatch(/^VTD21A\d$/);
  });
});

describe("analysePdr — the same route at two times of day", () => {
  const area = () => find("VTD43"); // LOP BURI, MON-FRI 0100-0900 UTC

  it("raises a finding when the crossing is inside the active hours", () => {
    const start = MON + 3 * HOUR;
    const r = analysePdr({
      ...baseInput,
      eobtMs: start,
      path: pathThrough(area(), start),
    });
    const hit = r.findings.find((f) => f.area === "VTD43");
    expect(hit).toBeDefined();
    expect(hit!.category).toBe("restricted-airspace");
    expect(["violation", "caution"]).toContain(hit!.severity);
    expect(hit!.reason).toContain("0100-0900");
  });

  it("does not raise it when the same crossing is outside those hours", () => {
    const start = MON + 12 * HOUR;
    const r = analysePdr({
      ...baseInput,
      eobtMs: start,
      path: pathThrough(area(), start),
    });
    const hit = r.findings.find((f) => f.area === "VTD43");
    expect(hit?.severity).toBe("info");
    expect(r.worst).not.toBe("violation");
  });

  it("names the hazard and the restriction, not just the ident", () => {
    const start = MON + 3 * HOUR;
    const r = analysePdr({
      ...baseInput,
      eobtMs: start,
      path: pathThrough(area(), start),
    });
    const hit = r.findings.find((f) => f.area === "VTD43")!;
    expect(hit.reason).toMatch(/Restriction:/);
    expect(hit.reason).toMatch(/Hazard:/);
  });

  it("cites the AIP as the source", () => {
    const start = MON + 3 * HOUR;
    const r = analysePdr({ ...baseInput, eobtMs: start, path: pathThrough(area(), start) });
    expect(r.findings.find((f) => f.area === "VTD43")!.source).toContain("ENR 5.1");
  });
});

describe("analysePdr — prohibited areas outrank danger areas", () => {
  it("treats an active Prohibited area as a violation", () => {
    const p = areas.find((a) => a.kind === "P" && a.activity?.sheets.length);
    expect(p).toBeDefined();
    // VTP7 is active H24, so any time works.
    const h24 = areas.find(
      (a) => a.kind === "P" && a.activity?.sheets.some((s) => s.end === "24:00"),
    );
    expect(h24).toBeDefined();
    const start = MON + 6 * HOUR;
    const r = analysePdr({
      ...baseInput,
      eobtMs: start,
      path: pathThrough(h24!, start),
    });
    const hit = r.findings.find((f) => f.area === h24!.ident);
    expect(hit?.severity).toBe("violation");
  });
});

describe("analysePdr — route availability and direction", () => {
  const cleanPath = (startMs: number) =>
    pathFromFixes(
      // Well out over the Gulf, clear of every land area.
      [
        { lat: 9.0, lon: 101.5 },
        { lat: 9.5, lon: 102.0 },
      ],
      { startMs, gsKt: 450, altFt: 33000 },
    );

  it("accepts a route the AIP publishes for this direction", () => {
    const r = analysePdr({
      ...baseInput,
      eobtMs: MON + 6 * HOUR,
      path: cleanPath(MON + 6 * HOUR),
    });
    expect(r.routeMatch.kind).toBe("exact");
    expect(r.findings.filter((f) => f.category === "route-availability")).toEqual([]);
  });

  it("flags the return leg's routing as unavailable in this direction", () => {
    const r = analysePdr({
      ...baseInput,
      adep: "VTCC",
      ades: "VTBD",
      eobtMs: MON + 6 * HOUR,
      path: cleanPath(MON + 6 * HOUR),
    });
    expect(r.routeMatch.kind).toBe("reverse");
    const f = r.findings.find((x) => x.category === "route-direction");
    expect(f?.severity).toBe("violation");
    expect(f?.reason).toMatch(/directional/i);
  });

  it("flags a routing that is not published for the pair", () => {
    const r = analysePdr({
      ...baseInput,
      filedRoute: "MADEUP W99 NOWHERE",
      eobtMs: MON + 6 * HOUR,
      path: cleanPath(MON + 6 * HOUR),
    });
    const f = r.findings.find((x) => x.category === "route-availability");
    expect(f?.severity).toBe("caution");
  });

  it("says so plainly when the pair has no published route at all", () => {
    const r = analysePdr({
      ...baseInput,
      adep: "ZZZZ",
      ades: "YYYY",
      eobtMs: MON + 6 * HOUR,
      path: cleanPath(MON + 6 * HOUR),
    });
    const f = r.findings.find((x) => x.category === "route-availability");
    expect(f?.severity).toBe("info");
    expect(r.suggestions).toEqual([]);
  });

  it("reports a clean plan as clean", () => {
    const r = analysePdr({
      ...baseInput,
      eobtMs: MON + 6 * HOUR,
      path: cleanPath(MON + 6 * HOUR),
    });
    expect(r.findings.every((f) => f.severity === "info")).toBe(true);
    expect(r.suggestions).toEqual([]);
  });
});

describe("analysePdr — suggestions", () => {
  // VTBS->VTSF is the pair the AIP itself conditions on a danger area.
  const start = MON + 3 * HOUR;
  const report = () =>
    analysePdr({
      ...baseInput,
      adep: "VTBS",
      ades: "VTSF",
      filedRoute: "MADEUP ROUTING",
      eobtMs: start,
      path: pathThrough(find("VTD43"), start),
    });

  it("offers alternatives only from the published table for that direction", () => {
    const r = report();
    expect(r.suggestions.length).toBeGreaterThan(0);
    const published = new Set(
      routes.filter((x) => x.adep === "VTBS" && x.ades === "VTSF").map((x) => x.route),
    );
    for (const s of r.suggestions) expect(published.has(s.route)).toBe(true);
  });

  it("never offers a route whose published condition is unmet", () => {
    for (const s of report().suggestions) {
      expect(s.condition?.state).not.toBe("unmet");
    }
  });

  it("explains why each alternative is being offered", () => {
    for (const s of report().suggestions) {
      expect(s.why.length).toBeGreaterThan(0);
    }
  });

  it("ranks routes with no active area on them first", () => {
    const s = report().suggestions;
    const firstHot = s.findIndex((x) => x.activeAreas.length > 0);
    const lastClean = s.map((x) => x.activeAreas.length === 0).lastIndexOf(true);
    if (firstHot >= 0 && lastClean >= 0) expect(lastClean).toBeLessThan(firstHot);
  });

  it("leaves the filed route untouched — the report is advisory only", () => {
    const input = {
      ...baseInput,
      adep: "VTBS",
      ades: "VTSF",
      filedRoute: "MADEUP ROUTING",
      eobtMs: start,
      path: pathThrough(find("VTD43"), start),
    };
    analysePdr(input);
    expect(input.filedRoute).toBe("MADEUP ROUTING");
  });
});

describe("analysePdr — reporting integrity", () => {
  it("counts the areas it actually tested", () => {
    const r = analysePdr({
      ...baseInput,
      eobtMs: MON,
      path: pathThrough(find("VTD43"), MON),
    });
    expect(r.areasChecked).toBe(areas.length);
  });

  it("reports zero areas checked when the overlay is not loaded", () => {
    const r = analysePdr({
      ...baseInput,
      areas: [],
      eobtMs: MON,
      path: pathThrough(find("VTD43"), MON),
    });
    expect(r.areasChecked).toBe(0);
    expect(r.incursions).toEqual([]);
  });

  it("gives every finding a stable id, a reason and a source", () => {
    const start = MON + 3 * HOUR;
    const r = analysePdr({
      ...baseInput,
      adep: "VTCC",
      ades: "VTBD",
      eobtMs: start,
      path: pathThrough(find("VTD43"), start),
    });
    expect(r.findings.length).toBeGreaterThan(0);
    const ids = r.findings.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of r.findings) {
      expect(f.reason.length).toBeGreaterThan(20);
      expect(f.source).toBeTruthy();
    }
  });

  it("orders findings worst-first", () => {
    const start = MON + 3 * HOUR;
    const r = analysePdr({
      ...baseInput,
      adep: "VTCC",
      ades: "VTBD",
      eobtMs: start,
      path: pathThrough(find("VTD43"), start),
    });
    const rank = { violation: 0, caution: 1, info: 2 } as const;
    const seq = r.findings.map((f) => rank[f.severity]);
    expect([...seq].sort((a, b) => a - b)).toEqual(seq);
  });
});
