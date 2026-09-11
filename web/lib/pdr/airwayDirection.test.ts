/**
 * One-way ATS routes, checked against the REAL AIRAC 2608 segment table
 * (`public/data/aixm/route_segments.json`) rather than invented fixtures.
 *
 * Y8 is the worked example from AIP Thailand ENR 3: a uni-directional
 * SOUTHBOUND route from Bangkok, with the leg south of Surat Thani published
 * both ways. Both halves are asserted here, because getting the direction sense
 * backwards would pass a naive test that only ever checks one orientation.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  checkAirwayUsage,
  edgePermitted,
  indexSegments,
  type RouteSegment,
  type RouteSegmentFile,
} from "./airwayDirection";

const file = JSON.parse(
  readFileSync(resolve(__dirname, "../../public/data/aixm/route_segments.json"), "utf-8"),
) as RouteSegmentFile;
const index = indexSegments(file.segments);

const seg = (route: string, from: string, to: string): RouteSegment => {
  const s = file.segments.find(
    (x) => x.route === route && x.from === from && x.to === to,
  );
  if (!s) throw new Error("no segment " + route + " " + from + "-" + to);
  return s;
};

describe("the ingested segment table", () => {
  it("covers the whole published network", () => {
    expect(file.segments.length).toBeGreaterThan(700);
    expect(new Set(file.segments.map((s) => s.route)).size).toBeGreaterThan(150);
  });

  it("has a meaningful share of one-way segments", () => {
    const oneWay = file.segments.filter((s) => s.direction !== "BOTH");
    expect(oneWay.length).toBeGreaterThan(100);
  });

  it("resolved every segment to a route and two named fixes", () => {
    for (const s of file.segments) {
      expect(s.route).toBeTruthy();
      expect(s.from).toBeTruthy();
      expect(s.to).toBeTruthy();
      expect(["BOTH", "FORWARD", "BACKWARD"]).toContain(s.direction);
    }
  });

  it("matches the AIP for Y8: southbound-only from Bangkok", () => {
    expect(seg("Y8", "BKK", "MOTNA").direction).toBe("FORWARD");
    expect(seg("Y8", "MOTNA", "SABIS").direction).toBe("FORWARD");
    expect(seg("Y8", "MENEX", "IKERA").direction).toBe("FORWARD");
  });

  it("matches the AIP for Y8: the southern legs are bidirectional", () => {
    // "Northbound direction between PUT and STN is available…" — those legs
    // are published BOTH ways.
    expect(seg("Y8", "SAPUD", "LAMUL").direction).toBe("BOTH");
    expect(seg("Y8", "LAMUL", "SAVSA").direction).toBe("BOTH");
    expect(seg("Y8", "SAVSA", "PUT").direction).toBe("BOTH");
  });

  it("carries the per-segment level band that changes down the route", () => {
    // 13 000 ft and above in the north, 7 000 ft and above in the south.
    expect(seg("Y8", "BKK", "MOTNA").lowerFt).toBe(13000);
    expect(seg("Y8", "SAVSA", "PUT").lowerFt).toBe(7000);
  });
});

describe("edgePermitted", () => {
  const s: RouteSegment = {
    route: "T1",
    from: "AAA",
    to: "BBB",
    direction: "FORWARD",
    lowerFt: null,
    upperFt: null,
    lengthNm: null,
  };

  it("allows a FORWARD segment only start -> end", () => {
    expect(edgePermitted({ to: "BBB", segment: s, forward: true })).toBe(true);
    expect(edgePermitted({ to: "AAA", segment: s, forward: false })).toBe(false);
  });

  it("inverts for BACKWARD", () => {
    const b = { ...s, direction: "BACKWARD" as const };
    expect(edgePermitted({ to: "BBB", segment: b, forward: true })).toBe(false);
    expect(edgePermitted({ to: "AAA", segment: b, forward: false })).toBe(true);
  });

  it("allows either way for BOTH", () => {
    const d = { ...s, direction: "BOTH" as const };
    expect(edgePermitted({ to: "BBB", segment: d, forward: true })).toBe(true);
    expect(edgePermitted({ to: "AAA", segment: d, forward: false })).toBe(true);
  });
});

describe("checkAirwayUsage — Bangkok to the south on Y8", () => {
  it("accepts the southbound routing", () => {
    const issues = checkAirwayUsage("BKK Y8 IKERA", index, 33000);
    expect(issues.filter((i) => i.kind === "direction")).toEqual([]);
  });

  it("rejects the same span flown northbound", () => {
    const issues = checkAirwayUsage("IKERA Y8 BKK", index, 33000);
    const dir = issues.filter((i) => i.kind === "direction");
    expect(dir.length).toBeGreaterThan(0);
    expect(dir[0].route).toBe("Y8");
    expect(dir[0].detail).toMatch(/one-way/);
  });

  it("names the direction that IS permitted, so the fix is obvious", () => {
    const issues = checkAirwayUsage("IKERA Y8 BKK", index, 33000).filter(
      (i) => i.kind === "direction",
    );
    // Every violating segment states its own permitted sense; the span is
    // walked from IKERA, so which one comes first is BFS order, not something
    // to assert on.
    for (const issue of issues) {
      expect(issue.detail).toMatch(
        new RegExp("may only be flown " + issue.segment!.from + " to " + issue.segment!.to),
      );
    }
    // …and the whole southbound chain back to Bangkok is covered.
    expect(issues.some((i) => i.segment?.from === "BKK")).toBe(true);
  });

  it("allows the northbound leg south of Surat Thani, which is bidirectional", () => {
    const issues = checkAirwayUsage("PUT Y8 SAPUD", index, 33000);
    expect(issues.filter((i) => i.kind === "direction")).toEqual([]);
  });
});

describe("checkAirwayUsage — level bands", () => {
  it("flags a level below the segment's published floor", () => {
    // Y8 north of Surat Thani starts at 13 000 ft.
    const issues = checkAirwayUsage("BKK Y8 SABIS", index, 9000);
    const lvl = issues.filter((i) => i.kind === "level");
    expect(lvl.length).toBeGreaterThan(0);
    expect(lvl[0].detail).toMatch(/published from 13000 ft/);
  });

  it("accepts a level inside the band", () => {
    expect(
      checkAirwayUsage("BKK Y8 SABIS", index, 33000).filter((i) => i.kind === "level"),
    ).toEqual([]);
  });

  it("skips the level check entirely when no level is given", () => {
    expect(
      checkAirwayUsage("BKK Y8 SABIS", index, null).filter((i) => i.kind === "level"),
    ).toEqual([]);
  });
});

describe("checkAirwayUsage — tokens that are not airways", () => {
  it("ignores a DCT leg", () => {
    expect(checkAirwayUsage("BKK DCT MOTNA", index, 33000)).toEqual([]);
  });

  it("ignores an unrecognised designator rather than inventing a finding", () => {
    expect(checkAirwayUsage("BKK ZZ999 MOTNA", index, 33000)).toEqual([]);
  });

  it("reports two fixes that the named airway does not join", () => {
    const issues = checkAirwayUsage("BKK Y8 NOWHERE", index, 33000);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("not-connected");
  });

  it("returns nothing for a route with no airway spans", () => {
    expect(checkAirwayUsage("BKK", index, 33000)).toEqual([]);
    expect(checkAirwayUsage("", index, 33000)).toEqual([]);
  });

  it("does not repeat the same segment issue for a long span", () => {
    const issues = checkAirwayUsage("PUT Y8 BKK", index, 33000);
    const keys = issues.map((i) => i.kind + (i.segment?.from ?? "") + (i.segment?.to ?? ""));
    expect(new Set(keys).size).toBe(keys.length);
  });
});
