import { describe, expect, it } from "vitest";

import {
  aircraftColor,
  altitudeColor,
  DEFAULT_COLOR_BY,
  typeLegendEntries,
} from "@/lib/displayColors";

describe("altitudeColor", () => {
  it("runs warm at the surface to cool at FL400, and clamps beyond both ends", () => {
    expect(altitudeColor(0)).toBe("hsl(50, 92%, 72%)");
    expect(altitudeColor(40000)).toBe("hsl(210, 92%, 38%)");
    expect(altitudeColor(-500)).toBe(altitudeColor(0));
    expect(altitudeColor(60000)).toBe(altitudeColor(40000));
  });

  it("gives a missing altitude a neutral grey, not the colour of the ground", () => {
    expect(altitudeColor(null)).toBe("#94a3b8");
    expect(altitudeColor(undefined)).toBe("#94a3b8");
    expect(altitudeColor(NaN)).toBe("#94a3b8");
  });
});

describe("aircraftColor", () => {
  it("uses the hand-picked colour for a known type, whatever its case", () => {
    expect(aircraftColor("A320")).toBe("#f472b6");
    expect(aircraftColor(" a320 ")).toBe("#f472b6");
  });

  it("gives an unknown type a colour that is stable from call to call", () => {
    expect(aircraftColor("C172")).toBe(aircraftColor("C172"));
    expect(aircraftColor("C172")).toMatch(/^hsl\(/);
  });

  it("falls back to the default cyan when there is no type at all", () => {
    expect(aircraftColor(undefined)).toBe("#22d3ee");
    expect(aircraftColor("")).toBe("#22d3ee");
  });
});

describe("typeLegendEntries", () => {
  it("lists each type once, most numerous first, with the colour the map uses", () => {
    const entries = typeLegendEntries(["B738", "A320", "a320", "B738", "A320", "A21N"]);
    expect(entries.map((e) => [e.type, e.count])).toEqual([
      ["A320", 3],
      ["B738", 2],
      ["A21N", 1],
    ]);
    expect(entries[0].color).toBe(aircraftColor("A320"));
  });

  it("breaks a tie by code, and drops flights with no type", () => {
    const entries = typeLegendEntries(["B77W", undefined, "A359", "", "  "]);
    expect(entries.map((e) => e.type)).toEqual(["A359", "B77W"]);
  });
});

describe("DEFAULT_COLOR_BY", () => {
  it("starts on altitude, the scale the trails and the corner legend already used", () => {
    expect(DEFAULT_COLOR_BY).toBe("altitude");
  });
});
