/**
 * The chart companions.
 *
 * These files exist to be selected and charted without being touched first, so
 * what has to hold is layout, not arithmetic: X in the first column, the series
 * beside it, rows in the order the axis reads, and no blank cell in the middle
 * of a line. Their numbers must also match the data file they ship with — two
 * files in the same download disagreeing is worse than one file alone.
 */
import { describe, expect, it } from "vitest";

import {
  conflictBySectorCsv,
  flightTrajectoryCsv,
  standardVsMergedCsv,
  trafficBySectorCsv,
} from "./chartData";
import { planDynamicSectors, type DynamicSectorConfig } from "./dynamicSectors";
import type { FlightEventRow, SectorHourRow } from "./flightEvents";

const H = (hh: number) => "2026-09-07T" + String(hh).padStart(2, "0") + ":00Z";

function row(over: Partial<SectorHourRow> & { sector: string }): SectorHourRow {
  return {
    layer: "bacc",
    hourUtc: H(3),
    entries: 0,
    entryFlights: [],
    entryEvents: [],
    occupancy: 0,
    occupancyFlights: [],
    conflictsTotal: 0,
    conflictsResolved: 0,
    conflictFlights: [],
    conflictsByFlight: {},
    ...over,
  };
}

const lines = (s: string) => s.trim().split("\r\n");
const cells = (s: string) => lines(s).map((l) => l.split(","));

// --- 1. Conflict by sector --------------------------------------------------

describe("conflict by sector", () => {
  const rows = [
    row({ sector: "1N", conflictsTotal: 2, conflictsResolved: 1 }),
    row({ sector: "1N", hourUtc: H(4), conflictsTotal: 3, conflictsResolved: 3 }),
    row({ sector: "4S", conflictsTotal: 9, conflictsResolved: 2 }),
    row({ sector: "2N", conflictsTotal: 0 }),
    row({ sector: "BANGKOK TMA", layer: "tma", conflictsTotal: 40 }),
  ];
  const out = cells(conflictBySectorCsv(rows, "bacc"));

  it("puts the sector in the first column and the count beside it", () => {
    expect(out[0]).toEqual(["sector", "conflicts", "resolved", "open"]);
  });

  it("totals a sector across every hour of the run", () => {
    expect(out.find((r) => r[0] === "1N")?.slice(1)).toEqual(["5", "4", "1"]);
  });

  it("sorts busiest first, so the answer is the top row", () => {
    expect(out[1][0]).toBe("4S");
    expect(out.map((r) => r[0]).slice(1)).toEqual(["4S", "1N", "2N"]);
  });

  it("keeps a quiet sector on the chart rather than dropping it to a gap", () => {
    // A missing category would leave a hole in the line, which reads as a
    // sector that was not measured rather than one with nothing to do.
    expect(out.find((r) => r[0] === "2N")?.slice(1)).toEqual(["0", "0", "0"]);
  });

  it("stays on one airspace layer", () => {
    expect(out.some((r) => r[0] === "BANGKOK TMA")).toBe(false);
  });
});

// --- 2. Standard vs merged --------------------------------------------------

describe("standard vs merged", () => {
  const LINE = new Map<string, ReadonlySet<string>>([
    ["A", new Set(["B"])],
    ["B", new Set(["A"])],
  ]);
  const cfg: DynamicSectorConfig = {
    layer: "bacc",
    mergeBelow: 6,
    maxSectorsPerPosition: 2,
  };
  const plan = planDynamicSectors(
    [
      row({ sector: "A", hourUtc: H(3), occupancy: 1, occupancyFlights: ["a"] }),
      row({ sector: "B", hourUtc: H(3), occupancy: 1, occupancyFlights: ["b"] }),
      row({
        sector: "A",
        hourUtc: H(9),
        occupancy: 9,
        occupancyFlights: Array.from({ length: 9 }, (_, i) => "x" + i),
      }),
    ],
    LINE,
    cfg,
  );
  const out = cells(standardVsMergedCsv(plan));

  it("gives the hour as the X column and the two counts beside it", () => {
    expect(out[0]).toEqual([
      "hour",
      "hour_utc",
      "standard_sectors",
      "merged_positions",
      "positions_saved",
    ]);
    expect(out[1][0]).toBe("0300");
  });

  it("draws the published count as the flat line it is", () => {
    expect(out.slice(1).map((r) => r[2])).toEqual(["2", "2"]);
  });

  it("shows the merge in the quiet hour and the split-back in the busy one", () => {
    expect(out.find((r) => r[0] === "0300")?.[3]).toBe("1"); // A+B on one position
    expect(out.find((r) => r[0] === "0900")?.[3]).toBe("2"); // split back
  });

  it("carries the saving as its own column rather than leaving it to be worked out", () => {
    expect(out.find((r) => r[0] === "0300")?.[4]).toBe("1");
    expect(out.find((r) => r[0] === "0900")?.[4]).toBe("0");
  });

  it("keeps the hours in time order, not sorted by value", () => {
    const hours = out.slice(1).map((r) => r[1]);
    expect(hours).toEqual([...hours].sort());
  });
});

// --- 3. Traffic by sector ---------------------------------------------------

describe("traffic by sector", () => {
  const rows = [
    row({ sector: "1N", entries: 2, occupancy: 3 }),
    row({ sector: "4S", entries: 7, occupancy: 8 }),
    row({ sector: "2N", entries: 7, occupancy: 7 }),
    row({ sector: "1N", hourUtc: H(9), entries: 99 }),
  ];
  const out = cells(trafficBySectorCsv(rows, "bacc", H(3)));

  it("charts entries against sector, busiest first", () => {
    expect(out[0].slice(0, 2)).toEqual(["sector", "entries"]);
    expect(out.slice(1).map((r) => r[0])).toEqual(["2N", "4S", "1N"]);
  });

  it("breaks a tie by name, so the same hour always draws the same way", () => {
    expect(out[1][0]).toBe("2N");
    expect(out[2][0]).toBe("4S");
  });

  it("covers the chosen hour only", () => {
    expect(out.some((r) => r[1] === "99")).toBe(false);
    expect(out.slice(1).every((r) => r[4] === "0300")).toBe(true);
  });

  it("carries aircraft present alongside, since they answer different questions", () => {
    expect(out[0][2]).toBe("aircraft_present");
    expect(out.find((r) => r[0] === "1N")?.[2]).toBe("3");
  });
});

// --- 4. Flight trajectory ---------------------------------------------------

describe("flight trajectory", () => {
  const ev = (
    callsign: string,
    at: [number, number][],
  ): FlightEventRow[] =>
    at.map(([lon, lat], i) => ({
      flightKey: callsign,
      callsign,
      actype: "B738",
      adep: "VTBS",
      ades: "VTCC",
      event: "WAYPOINT",
      ident: "P" + i,
      layer: "",
      description: "",
      timeUtc: new Date(Date.UTC(2026, 8, 7, 3, i)).toISOString(),
      elapsedSec: i * 60,
      latDeg: lat,
      lonDeg: lon,
      altFt: 33000,
    }));

  const events = [
    ...ev("THA100", [
      [100, 13],
      [101, 14],
      [102, 15],
    ]),
    ...ev("BKP102", [
      [99, 12],
      [100, 12.5],
    ]),
  ];
  const out = cells(flightTrajectoryCsv(events));

  it("gives each flight its own X/Y pair of columns", () => {
    expect(out[0]).toEqual(["lon_BKP102", "lat_BKP102", "lon_THA100", "lat_THA100"]);
  });

  it("puts longitude before latitude, so X is X", () => {
    expect(out[1].slice(2)).toEqual(["100", "13"]);
  });

  it("follows the flight in time order", () => {
    expect(out.slice(1).map((r) => r[2])).toEqual(["100", "101", "102"]);
  });

  it("leaves a short flight's remaining rows EMPTY rather than zero", () => {
    // A zero would draw the track back to (0,0) — the Gulf of Guinea.
    expect(out[3][0]).toBe("");
    expect(out[3][1]).toBe("");
  });

  it("caps how many flights go on one chart", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      ev("F" + String(i).padStart(3, "0"), [[100 + i * 0.01, 13]]),
    ).flat();
    expect(cells(flightTrajectoryCsv(many))[0]).toHaveLength(25 * 2);
    expect(cells(flightTrajectoryCsv(many, 3))[0]).toEqual([
      "lon_F000",
      "lat_F000",
      "lon_F001",
      "lat_F001",
      "lon_F002",
      "lat_F002",
    ]);
  });

  it("survives having no events at all", () => {
    expect(flightTrajectoryCsv([])).toContain("\r\n");
  });
});
