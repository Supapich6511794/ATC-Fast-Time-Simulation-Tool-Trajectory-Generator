import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it, vi } from "vitest";

import { eobtMonth, runwayDefault } from "./runwayDefault";

/** The module fetches the CSV the app serves; serve the real file from disk so
 *  these assertions are checked against the shipped data, not a fixture. */
const CSV = readFileSync(
  fileURLToPath(new URL("../public/data/airports/runway_default.csv", import.meta.url)),
  "utf8",
);

beforeAll(() => {
  vi.stubGlobal("fetch", async (url: string) => {
    if (String(url).endsWith("/data/airports/runway_default.csv"))
      return new Response(CSV, { status: 200 });
    return new Response("", { status: 404 });
  });
});

describe("eobtMonth", () => {
  it("reads the month out of a datetime-local EOBT", () => {
    expect(eobtMonth("2026-08-08T00:16")).toBe(8);
    expect(eobtMonth("2026-01-01T00:00")).toBe(1);
  });

  it("returns 0 for an unset or malformed EOBT", () => {
    expect(eobtMonth("")).toBe(0);
    expect(eobtMonth("tomorrow")).toBe(0);
  });
});

describe("runwayDefault", () => {
  it("returns the month's most-used departure runway", async () => {
    const d = await runwayDefault("VTCC", 8, "DEP");
    expect(d).toMatchObject({
      ident: "RW36",
      runway: "36",
      pct: 79,
      movements: 7410,
      nYears: 5,
      source: "DEP",
    });
  });

  it("returns the month's most-used arrival runway", async () => {
    const d = await runwayDefault("VTBS", 8, "ARR");
    expect(d).toMatchObject({ ident: "RW19", pct: 64.5, source: "ARR" });
  });

  // The README's headline warning: VTBS/VTBD segregate arrivals and departures
  // onto different parallels, so ARR and DEP must not resolve to the same
  // runway just because the pooled ALL bucket says so (ALL/8 = 19).
  it("splits departures from arrivals at a segregated aerodrome", async () => {
    const dep = await runwayDefault("VTBS", 8, "DEP");
    const arr = await runwayDefault("VTBS", 8, "ARR");
    expect(dep?.ident).toBe("RW20L");
    expect(arr?.ident).toBe("RW19");
  });

  it("tracks the monsoon reversal month to month", async () => {
    expect((await runwayDefault("VTSP", 1, "ARR"))?.ident).toBe("RW09");
    expect((await runwayDefault("VTSP", 8, "ARR"))?.ident).toBe("RW27");
  });

  it("falls back to the pooled bucket when a direction has no rows", async () => {
    // VTPN February has ALL + DEP rows only.
    const d = await runwayDefault("VTPN", 2, "ARR");
    expect(d).toMatchObject({ ident: "RW05", source: "ALL" });
  });

  it("returns null for an aerodrome or month the table doesn't cover", async () => {
    expect(await runwayDefault("EGLL", 8, "DEP")).toBeNull();
    expect(await runwayDefault("", 8, "DEP")).toBeNull();
    expect(await runwayDefault("VTCC", 0, "DEP")).toBeNull();
    expect(await runwayDefault("VTCC", 13, "DEP")).toBeNull();
  });
});
