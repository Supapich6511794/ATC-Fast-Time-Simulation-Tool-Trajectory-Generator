/**
 * The published PDR timetables decide whether a route conflicts at all, so the
 * cases that flip an answer are pinned here against the REAL AIRAC 2608 data
 * (`public/data/aixm/pdr_activity.json`) as well as against hand-built sheets.
 *
 * The three that matter and are easy to get wrong: windows that wrap midnight,
 * solar windows, and `excluded` sheets that subtract time rather than add it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { activityAt, formatSchedule, formatSheet, worseState } from "./schedule";
import type { PdrActivity, PdrActivityFile, Timesheet } from "./types";

const ACTIVITY = resolve(__dirname, "../../public/data/aixm/pdr_activity.json");
const file = JSON.parse(readFileSync(ACTIVITY, "utf-8")) as PdrActivityFile;
const byIdent = new Map(file.areas.map((a) => [a.designator, a]));

/** Lop Buri (13.7N 100.6E) — near enough for every Thai area's solar times. */
const THAI = { lat: 14.8, lon: 100.6 };

function area(designator: string): PdrActivity {
  const a = byIdent.get(designator);
  if (!a) throw new Error("fixture missing " + designator);
  return a;
}

const sheet = (over: Partial<Timesheet>): Timesheet => ({
  day: "ANY",
  dayTil: null,
  start: null,
  end: null,
  startEvent: null,
  endEvent: null,
  excluded: false,
  timeReference: "UTC",
  ...over,
});

/** 2026-09-07 is a Monday, so the weekday arithmetic is unambiguous. */
const MON = Date.UTC(2026, 8, 7);
const DAY = 86400000;

describe("activityAt — plain clock windows", () => {
  it("is active inside a MON-FRI window and inactive outside it", () => {
    const a = area("VTD43"); // MON-FRI 0100-0900 UTC
    expect(activityAt(a, MON + 3 * 3600000, THAI).state).toBe("active");
    expect(activityAt(a, MON + 12 * 3600000, THAI).state).toBe("inactive");
  });

  it("is inactive at the weekend", () => {
    const a = area("VTD43");
    const sat = MON + 5 * DAY + 3 * 3600000;
    expect(activityAt(a, sat, THAI).state).toBe("inactive");
  });

  it("treats the window as half-open [start, end)", () => {
    const a = area("VTD43");
    expect(activityAt(a, MON + 1 * 3600000, THAI).state).toBe("active"); // 0100
    expect(activityAt(a, MON + 9 * 3600000, THAI).state).toBe("inactive"); // 0900
  });

  it("explains WHY, naming the period it matched", () => {
    const v = activityAt(area("VTD43"), MON + 3 * 3600000, THAI);
    expect(v.detail).toContain("MON");
    expect(v.detail).toContain("0100-0900");
    expect(v.schedule).toBe("MON-FRI 0100-0900 UTC");
  });
});

describe("activityAt — windows that wrap midnight", () => {
  // VTD30A1 is MON-FRI 2300-1000: it OPENS on a weekday and closes the next
  // morning. Saturday 0800 is inside the window that opened on Friday, which a
  // same-day-only test reports as inactive.
  const a = () => area("VTD30A1");

  it("is active late on the opening day", () => {
    expect(activityAt(a(), MON + 23.5 * 3600000, THAI).state).toBe("active");
  });

  it("is active the next morning, before the window closes", () => {
    expect(activityAt(a(), MON + DAY + 8 * 3600000, THAI).state).toBe("active");
  });

  it("is inactive in the gap between closing and reopening", () => {
    expect(activityAt(a(), MON + DAY + 15 * 3600000, THAI).state).toBe("inactive");
  });

  it("stays active on Saturday morning from Friday's window", () => {
    const satMorning = MON + 5 * DAY + 8 * 3600000;
    expect(activityAt(a(), satMorning, THAI).state).toBe("active");
  });

  it("is inactive on Sunday morning — Saturday never opened one", () => {
    const sunMorning = MON + 6 * DAY + 8 * 3600000;
    expect(activityAt(a(), sunMorning, THAI).state).toBe("inactive");
  });
});

describe("activityAt — solar windows", () => {
  // VTP36 is a PROHIBITED area active sunset to sunrise. In Thailand that is
  // roughly 1130Z-2330Z; local midday (0500Z) must be cold, local night hot.
  const a = () => area("VTP36");

  it("is active in the middle of the night", () => {
    expect(activityAt(a(), MON + 18 * 3600000, THAI).state).toBe("active");
  });

  it("is inactive in the middle of the day", () => {
    expect(activityAt(a(), MON + 5 * 3600000, THAI).state).toBe("inactive");
  });

  it("is active just after local sunset and again before sunrise", () => {
    // ~1830 local = 1130Z is right at sunset; 2200Z is solidly dark.
    expect(activityAt(a(), MON + 22 * 3600000, THAI).state).toBe("active");
    // 2300Z = 0600 local, still before sunrise (~2330Z).
    expect(activityAt(a(), MON + 23 * 3600000, THAI).state).toBe("active");
  });

  it("prints the schedule in words rather than clock times", () => {
    expect(formatSchedule(a())).toBe("Daily sunset to sunrise");
  });
});

describe("activityAt — excluded sheets subtract time", () => {
  it("stays active inside the window when only a HOL exclusion applies", () => {
    // VTD70: MON-FRI 0130-0930, except public holidays.
    const v = activityAt(area("VTD70"), MON + 5 * 3600000, THAI);
    expect(v.state).toBe("active");
    expect(v.holidayCaveat).toBe(true);
  });

  it("carries the holiday caveat rather than silently ignoring it", () => {
    const v = activityAt(area("VTD70"), MON + 5 * 3600000, THAI);
    expect(formatSchedule(area("VTD70"))).toContain("except");
    expect(v.holidayCaveat).toBe(true);
  });

  it("reports inactive when a non-holiday exclusion covers the instant", () => {
    const synthetic: PdrActivity = {
      designator: "TEST",
      type: "D",
      name: "TEST",
      sheets: [
        sheet({ day: "MON", dayTil: "FRI", start: "00:00", end: "24:00" }),
        sheet({ day: "WED", start: "00:00", end: "24:00", excluded: true }),
      ],
      activityNote: "",
      restriction: "",
      hazard: "",
      remarks: "",
    };
    expect(activityAt(synthetic, MON + 5 * 3600000, THAI).state).toBe("active");
    const wed = MON + 2 * DAY + 5 * 3600000;
    const v = activityAt(synthetic, wed, THAI);
    expect(v.state).toBe("inactive");
    expect(v.detail).toContain("excluded");
  });
});

describe("activityAt — what the data cannot answer", () => {
  it("returns unknown for NOTAM-activated areas and says so", () => {
    const v = activityAt(area("VTR3"), MON + 5 * 3600000, THAI);
    expect(v.state).toBe("unknown");
    expect(v.detail).toMatch(/NOTAM/i);
  });

  it("returns unknown when a polygon has no activity record at all", () => {
    const v = activityAt(null, MON, THAI);
    expect(v.state).toBe("unknown");
    expect(v.detail).toMatch(/assume active/i);
  });
});

describe("formatSheet", () => {
  it("prints a day span and clock window the way the AIP does", () => {
    expect(formatSheet(sheet({ day: "MON", dayTil: "FRI", start: "01:00", end: "09:00" })))
      .toBe("MON-FRI 0100-0900 UTC");
  });

  it("prints ANY as Daily and HOL as public holidays", () => {
    expect(formatSheet(sheet({ day: "ANY", start: "00:00", end: "24:00" })))
      .toBe("Daily 0000-2400 UTC");
    expect(formatSheet(sheet({ day: "HOL", start: "00:00", end: "24:00" })))
      .toContain("Public holidays");
  });
});

describe("worseState", () => {
  it("ranks active over unknown over inactive", () => {
    expect(worseState("unknown", "active")).toBe("active");
    expect(worseState("inactive", "unknown")).toBe("unknown");
    expect(worseState("inactive", "inactive")).toBe("inactive");
  });
});

describe("the AIRAC 2608 fixture itself", () => {
  it("covers every area with either a timesheet or an activity note", () => {
    const naked = file.areas.filter(
      (a) => a.sheets.length === 0 && !a.activityNote.trim(),
    );
    expect(naked).toEqual([]);
  });

  it("resolves every area to one of the three states without throwing", () => {
    for (const a of file.areas) {
      const v = activityAt(a, MON + 5 * 3600000, THAI);
      expect(["active", "inactive", "unknown"]).toContain(v.state);
    }
  });
});
