/**
 * Wake turbulence categories (Doc 4444 §4.9.1.1) and the distance-based
 * approach minima they drive (§8.7.3.4).
 */
import { describe, expect, it } from "vitest";

import { resolveConfig, wakeMinimumNm } from "./config";
import { isKnownWakeType, wakeCategoryOf } from "./wake";

const cfg = resolveConfig();

describe("wakeCategoryOf — Doc 4444 §4.9.1.1 mass bands", () => {
  it("puts widebodies (≥136 t) in HEAVY", () => {
    for (const t of ["B77W", "B789", "A359", "A333", "B744", "B763"]) {
      expect(wakeCategoryOf(t)).toBe("HEAVY");
    }
  });

  it("puts narrowbodies and turboprops (7–136 t) in MEDIUM", () => {
    for (const t of ["A320", "A21N", "B738", "B38M", "AT76", "DH8D", "E190"]) {
      expect(wakeCategoryOf(t)).toBe("MEDIUM");
    }
  });

  it("keeps the 757 MEDIUM — 116 t is under the 136 t HEAVY floor", () => {
    expect(wakeCategoryOf("B752")).toBe("MEDIUM");
  });

  it("puts ≤7 t types in LIGHT (B350 is 6 804 kg, just under)", () => {
    for (const t of ["B350", "BE20", "C510", "HDJT"]) {
      expect(wakeCategoryOf(t)).toBe("LIGHT");
    }
  });

  it("gives the A380 its own SUPER category", () => {
    expect(wakeCategoryOf("A388")).toBe("SUPER");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(wakeCategoryOf(" b77w ")).toBe("HEAVY");
  });

  it("falls back for an unknown type, and says so", () => {
    expect(wakeCategoryOf("ZZZZ")).toBe("MEDIUM");
    expect(wakeCategoryOf("ZZZZ", "HEAVY")).toBe("HEAVY");
    expect(wakeCategoryOf(undefined)).toBe("MEDIUM");
    expect(isKnownWakeType("ZZZZ")).toBe(false);
    expect(isKnownWakeType("B77W")).toBe(true);
  });
});

describe("wakeMinimumNm — Doc 4444 §8.7.3.4 table", () => {
  it("reproduces the published table exactly", () => {
    // HEAVY leader
    expect(wakeMinimumNm(cfg, "B77W", "B789")).toBe(4.0); // H behind H
    expect(wakeMinimumNm(cfg, "B77W", "A320")).toBe(5.0); // M behind H
    expect(wakeMinimumNm(cfg, "B77W", "C510")).toBe(6.0); // L behind H
    // MEDIUM leader
    expect(wakeMinimumNm(cfg, "A320", "C510")).toBe(5.0); // L behind M
  });

  it("has NO wake minimum for pairs the table omits", () => {
    // A MEDIUM behind a MEDIUM, or anything behind a LIGHT, is separated by the
    // radar minimum alone — returning 0 lets the caller take the max.
    expect(wakeMinimumNm(cfg, "A320", "B738")).toBe(0);
    expect(wakeMinimumNm(cfg, "A320", "B77W")).toBe(0);
    expect(wakeMinimumNm(cfg, "C510", "A320")).toBe(0);
  });

  it("applies the larger A380 minima behind a SUPER", () => {
    expect(wakeMinimumNm(cfg, "A388", "B77W")).toBe(6.0);
    expect(wakeMinimumNm(cfg, "A388", "A320")).toBe(7.0);
    expect(wakeMinimumNm(cfg, "A388", "C510")).toBe(8.0);
  });

  it("treats an unknown type as the configured fallback category", () => {
    // Unknown behind a HEAVY → MEDIUM by default → 5 NM.
    expect(wakeMinimumNm(cfg, "B77W", "ZZZZ")).toBe(5.0);
    const conservative = resolveConfig({ wake: { unknownTypeCategory: "LIGHT" } });
    expect(wakeMinimumNm(conservative, "B77W", "ZZZZ")).toBe(6.0);
  });

  it("lets an operator replace the whole matrix", () => {
    const custom = resolveConfig({
      wake: { matrixNm: { HEAVY: { MEDIUM: 6.0 } } },
    });
    expect(wakeMinimumNm(custom, "B77W", "A320")).toBe(6.0);
    // The replaced matrix does not silently keep the default rows.
    expect(wakeMinimumNm(custom, "A320", "C510")).toBe(0);
  });
});
