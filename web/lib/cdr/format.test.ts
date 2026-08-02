import { describe, expect, it } from "vitest";

import { fmtFromValue } from "./format";

const st = (over: Partial<{ altitudeFt: number | null; gsKt: number; track: number }> = {}) => ({
  altitudeFt: 14000,
  gsKt: 462.4,
  track: 71.6,
  ...over,
});

describe("fmtFromValue", () => {
  it("formats the level a flightlevel maneuver climbs/descends FROM", () => {
    expect(fmtFromValue("flightlevel", st())).toBe("FL140");
  });

  it("formats speed in whole knots and heading as a 3-digit bearing", () => {
    expect(fmtFromValue("speed", st())).toBe("462 kt");
    expect(fmtFromValue("heading", st())).toBe("072°");
  });

  it("wraps a heading back into 0–359", () => {
    expect(fmtFromValue("heading", st({ track: -5 }))).toBe("355°");
    expect(fmtFromValue("heading", st({ track: 360 }))).toBe("000°");
  });

  it("has no scalar 'from' value for route/hold, unknown state or missing alt", () => {
    expect(fmtFromValue("route", st())).toBeNull();
    expect(fmtFromValue("hold", st())).toBeNull();
    expect(fmtFromValue("speed", null)).toBeNull();
    expect(fmtFromValue(undefined, st())).toBeNull();
    expect(fmtFromValue("flightlevel", st({ altitudeFt: null }))).toBeNull();
  });
});
