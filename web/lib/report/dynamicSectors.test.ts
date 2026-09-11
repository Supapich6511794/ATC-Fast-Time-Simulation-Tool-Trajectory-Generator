/**
 * Dynamic sectorization.
 *
 * Two things have to hold for this to be usable as a study output: a merge is
 * only ever proposed between sectors that actually touch, and the plan is a
 * pure function of the traffic — the same sample must always produce the same
 * grouping, or nothing can be checked against it.
 *
 * The adjacency half is tested against the REAL published BACC geometry, not a
 * fixture: whether the 12 Thai en-route sectors share boundaries is a fact about
 * the dataset, and a synthetic square grid would prove nothing about it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { buildAirspaceIndex } from "@/lib/airspace";

import {
  DEFAULT_DYNAMIC_CONFIG,
  describePosition,
  dynamicSectorsCsv,
  dynamicSpansCsv,
  planDynamicSectors,
  planHour,
  type DynamicSectorConfig,
} from "./dynamicSectors";
import type { SectorHourRow } from "./flightEvents";
import { areAdjacent, buildSectorAdjacency, sectorsOf } from "./sectorAdjacency";

// --- the real airspace ------------------------------------------------------

const load = (p: string) =>
  JSON.parse(readFileSync(resolve(__dirname, "../../public/data/" + p), "utf-8"));
const realIndex = buildAirspaceIndex({
  bacc: load("sectors_corrected/bacc_geo.geojson"),
  ctr: load("sectors_corrected/ctr.geojson"),
  tma: load("sectors_corrected/tma.geojson"),
});
const baccAdj = buildSectorAdjacency(realIndex, "bacc");

describe("sector adjacency, against the published BACC geometry", () => {
  it("knows every sector, with the altitude slabs collapsed into one", () => {
    const names = sectorsOf(baccAdj);
    expect(names.length).toBeGreaterThan(0);
    // 3S and 6S are published as _lower / _upper slabs; a controller works "3S".
    expect(names.some((n) => /_lower|_upper/.test(n))).toBe(false);
    expect(names).toContain("3S");
  });

  it("finds the 27 boundary pairs the 12 published sectors share", () => {
    const pairs = sectorsOf(baccAdj).reduce(
      (n, s) => n + (baccAdj.get(s)?.size ?? 0),
      0,
    );
    expect(sectorsOf(baccAdj)).toHaveLength(12);
    expect(pairs / 2).toBe(27);
  });

  it("gives every en-route sector at least one neighbour to merge with", () => {
    for (const s of sectorsOf(baccAdj)) {
      expect(baccAdj.get(s)?.size ?? 0).toBeGreaterThan(0);
    }
  });

  it("is symmetric and has no self-loops", () => {
    for (const a of sectorsOf(baccAdj)) {
      expect(baccAdj.get(a)?.has(a)).toBeFalsy();
      for (const b of baccAdj.get(a) ?? []) {
        expect(areAdjacent(baccAdj, b, a)).toBe(true);
      }
    }
  });

  it("leaves a sector no one touches out of every merge", () => {
    expect(areAdjacent(baccAdj, "1N", "NOT A SECTOR")).toBe(false);
  });

  it("reports the CTRs as islands, because they are", () => {
    // Control zones sit around their own aerodromes. "Nothing to band-box" is
    // the right answer for that layer, not a bug to paper over.
    const ctr = buildSectorAdjacency(realIndex, "ctr");
    const links = sectorsOf(ctr).reduce((n, s) => n + (ctr.get(s)?.size ?? 0), 0);
    expect(sectorsOf(ctr).length).toBeGreaterThan(10);
    expect(links / 2).toBeLessThan(3);
  });
});

// --- the planner ------------------------------------------------------------

/** A line of four sectors: A-B-C-D, each touching only its neighbours. */
const LINE = new Map<string, ReadonlySet<string>>([
  ["A", new Set(["B"])],
  ["B", new Set(["A", "C"])],
  ["C", new Set(["B", "D"])],
  ["D", new Set(["C"])],
]);

const HOUR = "2026-09-07T03:00Z";

/** A sector-hour row carrying `n` distinct aircraft, named per sector so the
 *  union across a merge is the sum unless the test overlaps them on purpose. */
function row(
  sector: string,
  flights: string[],
  hourUtc = HOUR,
  layer = "bacc",
): SectorHourRow {
  return {
    sector,
    layer,
    hourUtc,
    entries: flights.length,
    entryFlights: [...flights],
    entryEvents: [],
    occupancy: flights.length,
    occupancyFlights: [...flights],
    conflictsTotal: 0,
    conflictsResolved: 0,
    conflictFlights: [],
    conflictsByFlight: {},
  };
}

const n = (sector: string, count: number) =>
  row(
    sector,
    Array.from({ length: count }, (_, i) => sector + "F" + i),
  );

const cfg = (over: Partial<DynamicSectorConfig> = {}): DynamicSectorConfig => ({
  ...DEFAULT_DYNAMIC_CONFIG,
  ...over,
});

const byLabel = (h: ReturnType<typeof planHour>) => h.positions.map((p) => p.label);

describe("planHour — who works what", () => {
  const rows = (list: SectorHourRow[]) => new Map(list.map((r) => [r.sector, r]));

  it("merges two quiet neighbours into one position", () => {
    const h = planHour(
      HOUR,
      rows([n("A", 2), n("B", 3)]),
      LINE,
      cfg({ mergeBelow: 6, maxSectorsPerPosition: 2 }),
    );
    expect(byLabel(h)).toContain("A+B");
  });

  it("counts the merged position by aircraft, and says what each sector brought", () => {
    const h = planHour(
      HOUR,
      rows([n("A", 2), n("B", 3)]),
      LINE,
      cfg({ mergeBelow: 6, maxSectorsPerPosition: 2 }),
    );
    const p = h.positions.find((x) => x.label === "A+B");
    expect(p?.flights).toBe(5);
    expect(p?.members).toEqual([
      { sector: "A", flights: 2 },
      { sector: "B", flights: 3 },
    ]);
    expect(describePosition(p!)).toBe(
      "A: 2 flights + B: 3 flights → merged as A+B (5 total)",
    );
  });

  it("does not double-count an aircraft that was in both sectors", () => {
    // It transits A then B. To the controller now holding both, it is one
    // aircraft, and a plan that says two would over-state its own workload.
    const h = planHour(
      HOUR,
      rows([row("A", ["SAME", "X1"]), row("B", ["SAME", "X2"])]),
      LINE,
      cfg({ mergeBelow: 6, maxSectorsPerPosition: 2 }),
    );
    expect(h.positions.find((p) => p.label === "A+B")?.flights).toBe(3);
  });

  it("refuses to merge sectors that do not touch", () => {
    // A and D are both empty and both quiet — and at opposite ends.
    const h = planHour(HOUR, rows([n("A", 1), n("D", 1)]), LINE, cfg({ mergeBelow: 6 }));
    expect(byLabel(h)).not.toContain("A+D");
  });

  it("leaves a busy sector on its own", () => {
    const h = planHour(HOUR, rows([n("A", 9), n("B", 1)]), LINE, cfg({ mergeBelow: 6 }));
    expect(byLabel(h)).toContain("A");
    expect(byLabel(h).some((l) => l.includes("A+"))).toBe(false);
  });

  it("judges the RESULT against the threshold, not the pieces", () => {
    // 3 + 3 = 6 is not under 6: two quiet sectors that would make a busy
    // position stay apart.
    const two = cfg({ mergeBelow: 6, maxSectorsPerPosition: 2 });
    const at = planHour(HOUR, rows([n("A", 3), n("B", 3)]), LINE, two);
    expect(byLabel(at)).not.toContain("A+B");
    const under = planHour(HOUR, rows([n("A", 3), n("B", 2)]), LINE, two);
    expect(byLabel(under)).toContain("A+B");
  });

  it("honours the cap on how much airspace one position may hold", () => {
    const empty = rows([]);
    const two = planHour(HOUR, empty, LINE, cfg({ maxSectorsPerPosition: 2 }));
    expect(two.positions.every((p) => p.sectors.length <= 2)).toBe(true);
    const three = planHour(HOUR, empty, LINE, cfg({ maxSectorsPerPosition: 3 }));
    expect(three.positions.some((p) => p.sectors.length === 3)).toBe(true);
  });

  it("plans every published sector, including one with no traffic at all", () => {
    const h = planHour(HOUR, rows([n("A", 1)]), LINE, cfg({ mergeBelow: 1 }));
    expect(h.baselineSectors).toBe(4);
    expect(h.positions.flatMap((p) => p.sectors).sort()).toEqual(["A", "B", "C", "D"]);
  });

  it("counts the positions it opened against the baseline", () => {
    const h = planHour(HOUR, rows([]), LINE, cfg({ maxSectorsPerPosition: 2 }));
    expect(h.baselineSectors).toBe(4);
    expect(h.positionsOpen).toBe(2); // A+B and C+D
  });

  it("band-boxes the empty end of the airspace first, smallest position first", () => {
    // A carries 2 and B carries 3; C and D carry nothing. With room for three
    // sectors on one position the quiet end goes together first — which is what
    // "merge the smallest adjacent pair" means, and why the rule is stated as a
    // ceiling on the result rather than a test on each sector.
    const h = planHour(
      HOUR,
      rows([n("A", 2), n("B", 3)]),
      LINE,
      cfg({ mergeBelow: 6, maxSectorsPerPosition: 3 }),
    );
    expect(byLabel(h)).toEqual(["A", "B+C+D"]);
  });

  it("gives the same answer twice for the same traffic", () => {
    const input = () => rows([n("A", 1), n("B", 1), n("C", 1), n("D", 1)]);
    const one = planHour(HOUR, input(), LINE, cfg());
    const two = planHour(HOUR, input(), LINE, cfg());
    expect(byLabel(one)).toEqual(byLabel(two));
  });

  it("opens one position per sector when nothing may merge", () => {
    const h = planHour(HOUR, rows([n("A", 9), n("B", 9), n("C", 9), n("D", 9)]), LINE, cfg());
    expect(byLabel(h)).toEqual(["A", "B", "C", "D"]);
    expect(h.positionsOpen).toBe(h.baselineSectors);
  });
});

// --- across the day ---------------------------------------------------------

const H = (hh: number) => "2026-09-07T" + String(hh).padStart(2, "0") + ":00Z";

describe("planDynamicSectors — merging and splitting back over a run", () => {
  // Quiet at 0200 and 0300, busy from 0400.
  const rows = [
    ...[n("A", 1), n("B", 1)].map((r) => ({ ...r, hourUtc: H(2) })),
    ...[n("A", 2), n("B", 1)].map((r) => ({ ...r, hourUtc: H(3) })),
    ...[n("A", 9), n("B", 8)].map((r) => ({ ...r, hourUtc: H(4) })),
  ];
  const plan = planDynamicSectors(rows, LINE, cfg({ mergeBelow: 6, maxSectorsPerPosition: 2 }));

  it("merges while it is quiet", () => {
    const at3 = plan.hours.find((h) => h.hourUtc === H(3));
    expect(at3?.positions.map((p) => p.label)).toContain("A+B");
  });

  it("splits back when the traffic returns, and says which sectors those were", () => {
    const at4 = plan.hours.find((h) => h.hourUtc === H(4));
    expect(at4?.positions.map((p) => p.label)).toContain("A");
    expect(at4?.positions.map((p) => p.label)).toContain("B");
    expect(at4?.splitBack).toEqual(["A", "B"]);
  });

  it("reports the band-box as a PERIOD, not as scattered hours", () => {
    const span = plan.spans.find((s) => s.label === "A+B");
    expect(span?.fromHourUtc).toBe(H(2));
    expect(span?.toHourUtc).toBe(H(4)); // exclusive: in force 0200 up to 0400
    expect(span?.hours).toBe(2);
    expect(span?.endedBy).toBe("traffic");
  });

  it("records the busiest hour the merged position saw", () => {
    expect(plan.spans.find((s) => s.label === "A+B")?.peakFlights).toBe(3);
  });

  it("says when a band-box was still in force at the end of the sample", () => {
    const quiet = planDynamicSectors(
      [n("A", 1), n("B", 1)].map((r) => ({ ...r, hourUtc: H(2) })),
      LINE,
      cfg({ maxSectorsPerPosition: 2 }),
    );
    expect(quiet.spans.find((s) => s.label === "A+B")?.endedBy).toBe("end-of-run");
  });

  it("keeps the published sectors as the baseline, untouched", () => {
    expect(plan.baseline).toEqual(["A", "B", "C", "D"]);
    for (const h of plan.hours) {
      expect(h.positions.flatMap((p) => p.sectors).sort()).toEqual(["A", "B", "C", "D"]);
    }
  });

  it("ignores rows from other airspace layers rather than mixing them in", () => {
    const withTma = [...rows, row("BANGKOK TMA", ["X"], H(3), "tma")];
    const p = planDynamicSectors(withTma, LINE, cfg());
    expect(p.hours.flatMap((h) => h.positions.flatMap((x) => x.sectors))).not.toContain(
      "BANGKOK TMA",
    );
  });

  it("reads the traffic off the shared sector-hour table, not its own count", () => {
    // occupancy is what the planner uses: a row with entries but no one present
    // is an empty hour, and vice versa.
    const odd = { ...n("A", 0), occupancy: 4, occupancyFlights: ["W", "X", "Y", "Z"] };
    const h = planHour(H(3), new Map([["A", odd]]), LINE, cfg({ mergeBelow: 3 }));
    expect(h.positions.find((p) => p.sectors.includes("A"))?.merged).toBe(false);
  });
});

// --- the file ---------------------------------------------------------------

describe("the exported plan", () => {
  const plan = planDynamicSectors(
    [n("A", 1), n("B", 2)].map((r) => ({ ...r, hourUtc: H(3) })),
    LINE,
    cfg({ mergeBelow: 6, maxSectorsPerPosition: 2 }),
  );
  const lines = dynamicSectorsCsv(plan).trim().split("\r\n");

  it("writes one row per published sector per hour", () => {
    expect(lines).toHaveLength(1 + 4); // header + A, B, C, D
  });

  it("names the sector, its traffic, and the position it was worked from", () => {
    const a = lines.find((l) => l.split(",")[3] === "A") as string;
    const f = a.split(",");
    expect(f[3]).toBe("A");
    expect(f[4]).toBe("1"); // its own flights
    expect(f[5]).toBe("A+B"); // the position
    expect(f[7]).toBe("3"); // the position's flights
    expect(f[8]).toBe("MERGED");
  });

  it("carries the threshold that produced it", () => {
    expect(lines[0]).toContain("merge_below");
    expect((lines[1].split(",")[9])).toBe("6");
  });

  it("states on every row that the published sectors are unchanged", () => {
    for (const l of lines.slice(1)) {
      expect(l).toContain("dynamic operational configuration");
    }
  });

  it("counts the positions saved against the baseline", () => {
    const f = lines[1].split(",");
    expect(f[10]).toBe("4"); // baseline sectors
    // C and D are empty and adjacent, so they band-box too: A+B and C+D.
    expect(f[11]).toBe("2"); // positions open
    expect(f[12]).toBe("2"); // saved
  });

  it("writes the band-box periods as their own table", () => {
    const span = dynamicSpansCsv(plan).trim().split("\r\n");
    expect(span[0]).toContain("from_hour_utc");
    expect(span[1]).toContain("A+B");
    expect(span[1]).toContain("end-of-run");
  });
});

// --- against the real airspace ---------------------------------------------

describe("planning over the published BACC sectors", () => {
  const quiet = sectorsOf(baccAdj).map((sector, i) =>
    row(sector, i < 3 ? ["Q" + i] : [], H(3)),
  );
  const busy = sectorsOf(baccAdj).map((sector) =>
    row(sector, Array.from({ length: 12 }, (_, i) => sector + "B" + i), H(9)),
  );

  it("band-boxes a quiet night into far fewer positions", () => {
    const plan = planDynamicSectors([...quiet], baccAdj, cfg({ mergeBelow: 6 }));
    const h = plan.hours[0];
    expect(h.baselineSectors).toBe(12);
    expect(h.positionsOpen).toBeLessThan(12);
    expect(h.positions.some((p) => p.merged)).toBe(true);
  });

  it("keeps every published sector accounted for, merged or not", () => {
    const plan = planDynamicSectors([...quiet], baccAdj, cfg({ mergeBelow: 6 }));
    expect(plan.hours[0].positions.flatMap((p) => p.sectors).sort()).toEqual(
      sectorsOf(baccAdj),
    );
  });

  it("opens all twelve when the traffic is there", () => {
    const plan = planDynamicSectors([...busy], baccAdj, cfg({ mergeBelow: 6 }));
    const h = plan.hours[0];
    expect(h.positionsOpen).toBe(12);
    expect(h.positions.every((p) => !p.merged)).toBe(true);
  });

  it("only ever groups sectors that share a boundary", () => {
    const plan = planDynamicSectors([...quiet], baccAdj, cfg({ mergeBelow: 6 }));
    for (const p of plan.hours[0].positions) {
      // Every member must touch at least one other member of its own position,
      // or the "position" is two pieces of unconnected airspace.
      if (!p.merged) continue;
      for (const s of p.sectors) {
        expect(p.sectors.some((o) => o !== s && areAdjacent(baccAdj, s, o))).toBe(true);
      }
    }
  });

  it("splits back the moment the morning traffic arrives", () => {
    const plan = planDynamicSectors([...quiet, ...busy], baccAdj, cfg({ mergeBelow: 6 }));
    const morning = plan.hours.find((h) => h.hourUtc === H(9));
    expect(morning?.splitBack.length).toBeGreaterThan(0);
    expect(plan.spans.every((sp) => sp.toHourUtc <= H(9))).toBe(true);
  });
});
