/**
 * ENR 1.10 route rules, checked against the real published table
 * (`public/data/aip_routes_VT.json`) so the parser is pinned to the strings the
 * AIP actually prints rather than to invented ones.
 *
 * The condition shapes in AIRAC 2608 are: an area-activity dependency ("when
 * VT D60 is not active"), a time window with a holiday exclusion, and an
 * aircraft class. Anything else must come back `unparsed` and `unknown` — a
 * condition this app cannot read must never be reported as satisfied.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { AipRoute } from "@/lib/aipRoutes";

import {
  aircraftClass,
  evaluateCondition,
  matchFiledRoute,
  parseCondition,
  routeTokens,
  sameRoute,
} from "./routeRules";
import type { PdrActivity, PdrArea } from "./types";

const ROUTES = resolve(__dirname, "../../public/data/aip_routes_VT.json");
const table = (
  JSON.parse(readFileSync(ROUTES, "utf-8")) as { routes: AipRoute[] }
).routes;

const MON = Date.UTC(2026, 8, 7); // Monday
const HOUR = 3600000;

function areaWith(designator: string, sheets: PdrActivity["sheets"]): PdrArea {
  const activity: PdrActivity = {
    designator,
    type: "D",
    name: designator,
    sheets,
    activityNote: sheets.length ? "" : "Notified by NOTAM",
    restriction: "",
    hazard: "",
    remarks: "",
  };
  return {
    ident: designator,
    name: designator,
    kind: "D",
    lowerFt: 0,
    upperFt: 20000,
    mp: [],
    activity,
    centroid: { lat: 15, lon: 100 },
    bbox: [99, 14, 101, 16],
  };
}

const workday = [
  {
    day: "MON",
    dayTil: "FRI",
    start: "01:00",
    end: "09:00",
    startEvent: null,
    endEvent: null,
    excluded: false,
    timeReference: "UTC",
  },
];

const ctx = (whenMs: number, actype?: string) => ({
  whenMs,
  areasByIdent: new Map([
    ["VTD60", areaWith("VTD60", workday)],
    ["VTD59", areaWith("VTD59", workday)],
  ]),
  actype,
});

describe("parseCondition", () => {
  it("reads an area dependency, with or without the space in the ident", () => {
    expect(parseCondition("when VT D60 is not active")).toMatchObject({
      kind: "area",
      area: "VTD60",
      want: "inactive",
    });
    expect(parseCondition("when VTD60 is not active")).toMatchObject({
      kind: "area",
      area: "VTD60",
      want: "inactive",
    });
  });

  it("reads the positive form the AIP publishes for the complement route", () => {
    expect(parseCondition("when VT D59 is active")).toMatchObject({
      kind: "area",
      area: "VTD59",
      want: "active",
    });
  });

  it("reads a time window and notes the holiday exclusion", () => {
    const c = parseCondition("Excluding Public Holiday; MON-FRI 0100-0900 UTC");
    expect(c.kind).toBe("window");
    if (c.kind !== "window") return;
    expect(c.excludesHolidays).toBe(true);
    expect(c.sheet).toMatchObject({ day: "MON", dayTil: "FRI", start: "01:00", end: "09:00" });
  });

  it("reads an aircraft class", () => {
    expect(parseCondition("for jet aircraft")).toMatchObject({ kind: "aircraft", want: "jet" });
    expect(parseCondition("for propeller aircraft")).toMatchObject({
      kind: "aircraft",
      want: "propeller",
    });
  });

  it("marks anything else unparsed rather than guessing", () => {
    expect(parseCondition("subject to ATC approval").kind).toBe("unparsed");
  });

  it("parses every condition in the published table", () => {
    const conditions = [...new Set(table.map((r) => r.condition).filter(Boolean))];
    expect(conditions.length).toBeGreaterThan(0);
    for (const c of conditions) {
      expect(parseCondition(c as string).kind).not.toBe("unparsed");
    }
  });
});

describe("evaluateCondition", () => {
  it("is met when the area the route depends on is cold", () => {
    const c = parseCondition("when VT D60 is not active");
    const v = evaluateCondition(c, ctx(MON + 12 * HOUR)); // outside 0100-0900
    expect(v.state).toBe("met");
    expect(v.detail).toContain("VTD60");
  });

  it("is unmet when that area is hot", () => {
    const c = parseCondition("when VT D60 is not active");
    expect(evaluateCondition(c, ctx(MON + 3 * HOUR)).state).toBe("unmet");
  });

  it("inverts correctly for the 'is active' form", () => {
    const c = parseCondition("when VT D59 is active");
    expect(evaluateCondition(c, ctx(MON + 3 * HOUR)).state).toBe("met");
    expect(evaluateCondition(c, ctx(MON + 12 * HOUR)).state).toBe("unmet");
  });

  it("is unknown when the area is not in the loaded data", () => {
    const c = parseCondition("when VT D99 is not active");
    const v = evaluateCondition(c, ctx(MON + 3 * HOUR));
    expect(v.state).toBe("unknown");
    expect(v.detail).toContain("VTD99");
  });

  it("is unmet outside a published window", () => {
    const c = parseCondition("Excluding Public Holiday; MON-FRI 0100-0900 UTC");
    expect(evaluateCondition(c, ctx(MON + 12 * HOUR)).state).toBe("unmet");
  });

  it("is unknown inside a window that excludes holidays, and says why", () => {
    const c = parseCondition("Excluding Public Holiday; MON-FRI 0100-0900 UTC");
    const v = evaluateCondition(c, ctx(MON + 3 * HOUR));
    expect(v.state).toBe("unknown");
    expect(v.detail).toMatch(/holiday/i);
  });

  it("matches an aircraft class and rejects the other one", () => {
    const jet = parseCondition("for jet aircraft");
    expect(evaluateCondition(jet, ctx(MON, "B738")).state).toBe("met");
    expect(evaluateCondition(jet, ctx(MON, "AT76")).state).toBe("unmet");
  });

  it("is unknown for an unrecognised type rather than assuming jet", () => {
    expect(evaluateCondition(parseCondition("for jet aircraft"), ctx(MON, "ZZZZ")).state)
      .toBe("unknown");
  });

  it("never reports an unparsed condition as satisfied", () => {
    const v = evaluateCondition(parseCondition("subject to ATC approval"), ctx(MON));
    expect(v.state).toBe("unknown");
  });
});

describe("aircraftClass", () => {
  it("classifies the Thai fleet's turboprops and jets", () => {
    expect(aircraftClass("AT76")).toBe("propeller");
    expect(aircraftClass("DH8D")).toBe("propeller");
    expect(aircraftClass("B738")).toBe("jet");
    expect(aircraftClass("A333")).toBe("jet");
    expect(aircraftClass("E190")).toBe("jet");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(aircraftClass(" at76 ")).toBe("propeller");
  });

  it("returns unknown for an unset or unrecognised type", () => {
    expect(aircraftClass("")).toBe("unknown");
    expect(aircraftClass(null)).toBe("unknown");
    expect(aircraftClass("ZZZZ")).toBe("unknown");
  });
});

describe("route token comparison", () => {
  it("ignores spacing and case", () => {
    expect(sameRoute("olvuk  y26   marni", "OLVUK Y26 MARNI")).toBe(true);
  });

  it("does not treat a different routing as the same", () => {
    expect(sameRoute("OLVUK Y26 MARNI", "OLVUK Y26 BEBUV")).toBe(false);
  });

  it("splits on any whitespace run", () => {
    expect(routeTokens(" A  B\tC ")).toEqual(["A", "B", "C"]);
  });
});

describe("matchFiledRoute against the published table", () => {
  it("recognises a published route for the filed direction", () => {
    const m = matchFiledRoute("OLVUK Y26 MARNI", table, "VTBD", "VTCC");
    expect(m.kind).toBe("exact");
    expect(m.matched?.route).toBe("OLVUK Y26 MARNI");
  });

  it("flags a routing that is only published in the opposite direction", () => {
    // Take a real VTBD->VTCC route and file it as if going VTCC->VTBD.
    const outbound = table.find((r) => r.adep === "VTBD" && r.ades === "VTCC");
    expect(outbound).toBeDefined();
    const m = matchFiledRoute(outbound!.route, table, "VTCC", "VTBD");
    expect(m.kind).toBe("reverse");
  });

  it("reports a non-published routing for a pair that has published routes", () => {
    const m = matchFiledRoute("SOMETHING ELSE", table, "VTBD", "VTCC");
    expect(m.kind).toBe("none");
    expect(m.forPair.length).toBeGreaterThan(0);
  });

  it("distinguishes a pair with no published route at all", () => {
    const m = matchFiledRoute("ANY ROUTE", table, "ZZZZ", "YYYY");
    expect(m.kind).toBe("none-published");
    expect(m.forPair).toEqual([]);
  });
});
