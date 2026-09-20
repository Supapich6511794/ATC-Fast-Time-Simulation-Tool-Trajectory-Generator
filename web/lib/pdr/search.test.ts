import { describe, expect, it } from "vitest";

import { matchesPdrSearch, pdrSearchTerms } from "@/lib/pdr/search";

const flight = (callsign: string, adep: string, ades: string) => ({
  callsign,
  adep,
  ades,
});

const THA201 = flight("THA201", "VTBS", "VTCC");
const AIQ3221 = flight("AIQ3221", "VTBD", "VTSG");

const hit = (f: ReturnType<typeof flight>, q: string) =>
  matchesPdrSearch(f, pdrSearchTerms(q));

describe("pdrSearchTerms", () => {
  it("upper-cases and splits on spaces and commas, dropping blanks", () => {
    expect(pdrSearchTerms("  tha  vtbs,vtcc ,")).toEqual(["THA", "VTBS", "VTCC"]);
  });

  it("is empty for a blank query", () => {
    expect(pdrSearchTerms("")).toEqual([]);
    expect(pdrSearchTerms("   ")).toEqual([]);
  });

  it("reads -> as the arrow the rows draw", () => {
    expect(pdrSearchTerms("vtbs->vtcc")).toEqual(["VTBS→VTCC"]);
  });
});

describe("matchesPdrSearch", () => {
  it("matches everything when there is nothing to search for", () => {
    expect(hit(THA201, "")).toBe(true);
    expect(hit(THA201, "   ")).toBe(true);
  });

  it("finds a callsign by any part of it, in any case", () => {
    expect(hit(THA201, "tha201")).toBe(true);
    expect(hit(THA201, "THA")).toBe(true);
    expect(hit(THA201, "a20")).toBe(true);
    expect(hit(AIQ3221, "THA")).toBe(false);
  });

  it("finds a flight by either aerodrome", () => {
    expect(hit(THA201, "VTBS")).toBe(true); // departure
    expect(hit(THA201, "vtcc")).toBe(true); // destination
    expect(hit(THA201, "VTSG")).toBe(false);
  });

  it("finds a flight by the pair as the row writes it", () => {
    expect(hit(THA201, "VTBS→VTCC")).toBe(true);
    expect(hit(THA201, "VTBS->VTCC")).toBe(true);
    expect(hit(THA201, "VTBS-VTCC")).toBe(true);
    // The pair has a direction: the reverse is another flight.
    expect(hit(THA201, "VTCC→VTBS")).toBe(false);
  });

  it("narrows with several terms, in any order", () => {
    expect(hit(THA201, "THA VTBS")).toBe(true);
    expect(hit(THA201, "VTBS THA")).toBe(true);
    expect(hit(THA201, "THA VTSG")).toBe(false);
    expect(hit(AIQ3221, "THA VTBD")).toBe(false);
  });

  it("treats two aerodromes as 'between these', whichever way round", () => {
    expect(hit(THA201, "VTCC VTBS")).toBe(true);
  });

  it("does not match a query that is nowhere on the row", () => {
    expect(hit(THA201, "zzz")).toBe(false);
  });
});
