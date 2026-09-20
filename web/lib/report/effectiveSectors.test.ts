/**
 * The configuration in force.
 *
 * The property that matters most is the one that looks like nothing: with no
 * plan applied, every answer is the published one. This layer sits in front of
 * every sector lookup in the simulation, so if it is not transparent when idle
 * it changes the picture for people who never opened the panel.
 *
 * After that: a band-box renames, a re-cut moves a boundary, and neither ever
 * touches the published airspace it was derived from.
 */
import { describe, expect, it } from "vitest";

import {
  effectiveConfig,
  effectiveEvents,
  hourKey,
  positionAt,
  positionsInForce,
} from "./effectiveSectors";
import { hourBucket, type FlightEventRow } from "./flightEvents";
import type { DynamicHour, DynamicPlan } from "./dynamicSectors";

const H = (h: number) => `2026-03-04T${String(h).padStart(2, "0")}:00Z`;
const AT = (h: number, m = 30) => Date.parse(`2026-03-04T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);

function hour(over: Partial<DynamicHour> & { hourUtc: string }): DynamicHour {
  return {
    layer: "bacc",
    positions: [],
    overloaded: [],
    transfers: [],
    blocked: [],
    change: "none",
    decision: "auto",
    manual: false,
    baselineSectors: 4,
    positionsOpen: 4,
    splitBack: [],
    ...over,
  };
}

function plan(hours: DynamicHour[], applied: string | null = "2026-03-04T00:00:00Z"): DynamicPlan {
  return {
    config: { layer: "bacc" } as DynamicPlan["config"],
    appliedAt: applied,
    hours,
    spans: [],
    transitions: [],
    baseline: ["1N", "3N", "4N", "1S"],
  };
}

/** A band-box of 1N and 3N, in force for the 03Z hour. */
const BANDBOX = plan([
  hour({
    hourUtc: H(3),
    positions: [
      { sectors: ["1N", "3N"], label: "1N+3N", flights: 9, members: [], merged: true },
      { sectors: ["4N"], label: "4N", flights: 5, members: [], merged: false },
    ],
  }),
]);

/** A square slice of 1S handed to 4N, in force for the 05Z hour. */
const RECUT = plan([
  hour({
    hourUtc: H(5),
    transfers: [
      {
        from: "1S",
        to: "4N",
        flights: [],
        fromAfter: 3,
        toAfter: 7,
        bearingDeg: 0,
        quadrant: "N",
        areaNm2: 100,
        boundary: [
          { lat: 13.0, lon: 100.0 },
          { lat: 13.0, lon: 101.0 },
          { lat: 14.0, lon: 101.0 },
          { lat: 14.0, lon: 100.0 },
        ],
      },
    ],
  }),
]);

describe("transparency when nothing is in force", () => {
  it("has no configuration at all without a plan", () => {
    expect(effectiveConfig(null)).toBeNull();
    expect(effectiveConfig(undefined)).toBeNull();
  });

  it("ignores a plan that has not been applied", () => {
    // A proposal on screen must not re-partition the airspace — not least
    // because the numbers being read to decide whether to apply it would then
    // already reflect it.
    const proposal = plan(BANDBOX.hours, null);
    expect(effectiveConfig(proposal)).toBeNull();
  });

  it("ignores a plan that changes nothing", () => {
    const flat = plan([
      hour({
        hourUtc: H(3),
        positions: [
          { sectors: ["1N"], label: "1N", flights: 4, members: [], merged: false },
        ],
      }),
    ]);
    expect(effectiveConfig(flat)).toBeNull();
  });

  it("answers with the published sector when there is no config", () => {
    expect(positionAt(null, "1N", 100.5, 13.5, AT(3))).toBe("1N");
  });
});

describe("a band-box", () => {
  const cfg = effectiveConfig(BANDBOX)!;

  it("renames every member to the position working them", () => {
    expect(positionAt(cfg, "1N", 100.5, 13.5, AT(3))).toBe("1N+3N");
    expect(positionAt(cfg, "3N", 100.5, 13.5, AT(3))).toBe("1N+3N");
  });

  it("leaves a sector worked on its own alone", () => {
    expect(positionAt(cfg, "4N", 100.5, 13.5, AT(3))).toBe("4N");
  });

  it("leaves a sector the plan never mentions alone", () => {
    expect(positionAt(cfg, "SMU", 100.5, 13.5, AT(3))).toBe("SMU");
  });

  it("only applies in its own hour", () => {
    expect(positionAt(cfg, "1N", 100.5, 13.5, AT(2))).toBe("1N");
    expect(positionAt(cfg, "1N", 100.5, 13.5, AT(4))).toBe("1N");
  });

  it("applies across the whole of that hour, not just on the hour", () => {
    for (const m of [0, 1, 30, 59]) {
      expect(positionAt(cfg, "1N", 100.5, 13.5, AT(3, m))).toBe("1N+3N");
    }
  });

  it("lists the positions it opened", () => {
    expect(positionsInForce(cfg, AT(3))).toEqual(["1N+3N"]);
    expect(positionsInForce(cfg, AT(4))).toEqual([]);
  });
});

describe("a re-cut", () => {
  const cfg = effectiveConfig(RECUT)!;

  it("hands a point inside the ceded slice to the new owner", () => {
    expect(positionAt(cfg, "1S", 100.5, 13.5, AT(5))).toBe("4N");
  });

  it("leaves the rest of the same sector where it was", () => {
    // Outside the ring, still 1S — a re-cut moves a boundary, not a sector.
    expect(positionAt(cfg, "1S", 105.0, 13.5, AT(5))).toBe("1S");
    expect(positionAt(cfg, "1S", 100.5, 18.0, AT(5))).toBe("1S");
  });

  it("does not move a point that is inside the ring but belongs elsewhere", () => {
    // The geometry alone is not the test: the slice is cut OUT OF 1S, so an
    // aircraft the AIP puts in 4N there was already 4N's.
    expect(positionAt(cfg, "4N", 100.5, 13.5, AT(5))).toBe("4N");
  });

  it("only applies in its own hour", () => {
    expect(positionAt(cfg, "1S", 100.5, 13.5, AT(4))).toBe("1S");
  });
});

describe("a re-cut and a band-box in the same hour", () => {
  // The slice moves to 4N, and 4N is itself band-boxed with 1N. The aircraft
  // in the slice should end up with the position, not with 4N.
  const both = effectiveConfig(
    plan([
      hour({
        hourUtc: H(7),
        positions: [
          { sectors: ["1N", "4N"], label: "1N+4N", flights: 11, members: [], merged: true },
        ],
        transfers: RECUT.hours[0].transfers,
      }),
    ]),
  )!;

  it("resolves the boundary first and the grouping second", () => {
    expect(positionAt(both, "1S", 100.5, 13.5, AT(7))).toBe("1N+4N");
  });

  it("still groups a sector that was not re-cut", () => {
    expect(positionAt(both, "1N", 105.0, 18.0, AT(7))).toBe("1N+4N");
  });
});

describe("hourKey", () => {
  it("floors to the hour", () => {
    expect(hourKey(AT(3, 0))).toBe(hourKey(AT(3, 59)));
    expect(hourKey(AT(3, 0))).not.toBe(hourKey(AT(4, 0)));
  });

  it("is the SAME string the plan keys its hours by", () => {
    // The whole layer hangs off this one lookup. Formatting it independently
    // produced "T03:00:00Z" against the plan's "T03:00Z", every get() missed,
    // and the result was indistinguishable from an idle configuration — so no
    // other test here could have seen it. Pinned against the real producer.
    expect(hourKey(AT(3, 30))).toBe(hourBucket(AT(3, 0)));
    expect(H(3)).toBe(hourKey(AT(3, 30)));
  });
});

describe("re-labelling the traffic", () => {
  const cfg = effectiveConfig(BANDBOX)!;
  const T = (m: number) =>
    new Date(Date.parse(`2026-03-04T03:${String(m).padStart(2, "0")}:00Z`)).toISOString();

  const ev = (
    event: "SECTOR_ENTRY" | "SECTOR_EXIT",
    ident: string,
    min: number,
    over: Partial<FlightEventRow> = {},
  ): FlightEventRow => ({
    flightKey: "THA100_X",
    callsign: "THA100",
    actype: "B738",
    adep: "VTBS",
    ades: "VTCC",
    event,
    ident,
    layer: "bacc",
    description: `THA100 ${event === "SECTOR_ENTRY" ? "entered" : "left"} ${ident}`,
    timeUtc: T(min),
    elapsedSec: min * 60,
    latDeg: 13.5,
    lonDeg: 100.5,
    altFt: 35000,
    ...over,
  });

  /** 1N for ten minutes, then straight into 3N for ten more. */
  const CROSSING = [
    ev("SECTOR_ENTRY", "1N", 0),
    ev("SECTOR_EXIT", "1N", 10),
    ev("SECTOR_ENTRY", "3N", 10),
    ev("SECTOR_EXIT", "3N", 20),
  ];

  it("hands back the events untouched when nothing is in force", () => {
    expect(effectiveEvents(CROSSING, null)).toBe(CROSSING);
  });

  it("counts a crossing INSIDE a band-box as one spell, not two", () => {
    // The aircraft moved from 1N to 3N, but one controller held it throughout.
    // Re-labelling without merging would record two entries to 1N+3N and make
    // the band-box look busier than the two sectors it replaced.
    const out = effectiveEvents(CROSSING, cfg);
    const entries = out.filter((e) => e.event === "SECTOR_ENTRY");
    const exits = out.filter((e) => e.event === "SECTOR_EXIT");
    expect(entries).toHaveLength(1);
    expect(exits).toHaveLength(1);
    expect(entries[0].ident).toBe("1N+3N");
    expect(entries[0].timeUtc).toBe(T(0));
    expect(exits[0].timeUtc).toBe(T(20));
  });

  it("keeps a crossing OUT of the band-box as a real change of position", () => {
    const out = effectiveEvents(
      [...CROSSING, ev("SECTOR_ENTRY", "4N", 20), ev("SECTOR_EXIT", "4N", 30)],
      cfg,
    );
    expect(out.filter((e) => e.event === "SECTOR_ENTRY").map((e) => e.ident)).toEqual([
      "1N+3N",
      "4N",
    ]);
  });

  it("does not merge two separate visits to the same position", () => {
    // Out to 4N and back again: the controller really did hand it over and
    // take it back, so that is two entries.
    const out = effectiveEvents(
      [
        ev("SECTOR_ENTRY", "1N", 0),
        ev("SECTOR_EXIT", "1N", 10),
        ev("SECTOR_ENTRY", "4N", 10),
        ev("SECTOR_EXIT", "4N", 20),
        ev("SECTOR_ENTRY", "3N", 20),
        ev("SECTOR_EXIT", "3N", 30),
      ],
      cfg,
    );
    expect(out.filter((e) => e.event === "SECTOR_ENTRY").map((e) => e.ident)).toEqual([
      "1N+3N",
      "4N",
      "1N+3N",
    ]);
  });

  it("keeps flights apart", () => {
    const other = CROSSING.map((e) => ({ ...e, flightKey: "AIQ1_X", callsign: "AIQ1" }));
    const out = effectiveEvents([...CROSSING, ...other], cfg);
    expect(out.filter((e) => e.event === "SECTOR_ENTRY")).toHaveLength(2);
  });

  it("leaves other layers and non-sector events alone", () => {
    const mixed = [
      ...CROSSING,
      ev("SECTOR_ENTRY", "Bangkok TMA", 5, { layer: "tma" }),
      ev("SECTOR_EXIT", "Bangkok TMA", 8, { layer: "tma" }),
      { ...ev("SECTOR_ENTRY", "OLVUK", 3), event: "WAYPOINT" as const, layer: "" },
    ];
    const out = effectiveEvents(mixed, cfg);
    expect(out.filter((e) => e.layer === "tma").map((e) => e.ident)).toEqual([
      "Bangkok TMA",
      "Bangkok TMA",
    ]);
    expect(out.filter((e) => e.event === "WAYPOINT")).toHaveLength(1);
  });

  it("rewrites the description so it reads of the position", () => {
    const out = effectiveEvents(CROSSING, cfg);
    expect(out[0].description).toContain("1N+3N");
    expect(out[0].description).not.toMatch(/\b1N\b(?!\+)/);
  });

  it("stays in time order", () => {
    const out = effectiveEvents(CROSSING, cfg);
    for (let i = 1; i < out.length; i++) {
      expect(Date.parse(out[i].timeUtc)).toBeGreaterThanOrEqual(
        Date.parse(out[i - 1].timeUtc),
      );
    }
  });
});
