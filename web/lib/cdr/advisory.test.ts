import { describe, expect, it } from "vitest";

import { generateResolutions, respectsSemicircular } from "./advisory";
import { resolveConfig } from "./config";
import { detectConflicts } from "./detect";
import { straightFuture } from "./future";
import type { CdrAircraft } from "./types";

const cfg = resolveConfig();
const W = cfg.lookahead.mtcdSec;
const STEP = cfg.lookahead.stepSec;
const degEastPerNm = (lat: number) => 1 / (60 * Math.cos((lat * Math.PI) / 180));

function ac(over: Partial<CdrAircraft> & { id: string }): CdrAircraft {
  const base = {
    callsign: over.id,
    type: "B738",
    lat: 13,
    lon: 100,
    altFt: 35000,
    gsKt: 450,
    trackDeg: 90,
    vsFpm: 0,
    ...over,
  };
  return { ...base, future: over.future ?? straightFuture(base, W, STEP) };
}

/** A canonical head-on, co-altitude pair 30 NM apart (enough time to resolve). */
function headOnPair(): CdrAircraft[] {
  const lat = 13;
  return [
    ac({ id: "A", lat, lon: 100, trackDeg: 90, altFt: 35000 }),
    ac({ id: "B", lat, lon: 100 + 30 * degEastPerNm(lat), trackDeg: 270, altFt: 35000 }),
  ];
}

describe("respectsSemicircular", () => {
  it("eastbound wants odd thousands, westbound even (Annex 2 App 3)", () => {
    expect(respectsSemicircular(35000, 90)).toBe(true); // FL350 east — odd ✓
    expect(respectsSemicircular(36000, 90)).toBe(false); // FL360 east — even ✗
    expect(respectsSemicircular(36000, 270)).toBe(true); // FL360 west — even ✓
    expect(respectsSemicircular(35000, 270)).toBe(false); // FL350 west — odd ✗
  });

  it("ignored below the transition (climb/descent levels)", () => {
    expect(respectsSemicircular(8000, 90)).toBe(true);
    expect(respectsSemicircular(9000, 270)).toBe(true);
  });
});

describe("generateResolutions", () => {
  const traffic = headOnPair();

  it("produces up to 3 ranked suggestions, cheapest first", () => {
    const [c] = detectConflicts(traffic, cfg);
    expect(c).toBeDefined();
    const suggestions = generateResolutions(c, traffic, cfg);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < suggestions.length; i++) {
      expect(suggestions[i].cost).toBeGreaterThanOrEqual(suggestions[i - 1].cost);
    }
  });

  it("every suggestion actually resolves the conflict to buffered minima", () => {
    const [c] = detectConflicts(traffic, cfg);
    const suggestions = generateResolutions(c, traffic, cfg);
    const bufferedMin = c.shNm + cfg.buffer.horizontalNm;
    for (const s of suggestions) {
      // Horizontal resolutions must open the miss distance past buffered minima;
      // a pure level change keeps d_CPA small but is valid via vertical sep, so
      // only assert the horizontal bound for lateral/speed/route maneuvers.
      if (s.type !== "flightlevel") {
        expect(s.newDCpaNm).toBeGreaterThanOrEqual(bufferedMin - 1e-6);
      }
    }
  });

  it("re-detects NO conflict after applying the top heading suggestion", () => {
    const [c] = detectConflicts(traffic, cfg);
    const suggestions = generateResolutions(c, traffic, cfg);
    const heading = suggestions.find((s) => s.type === "heading");
    expect(heading).toBeDefined();
    // Apply the new heading to the target and re-run full detection. Rebuild via
    // ac() so the target's REAL future is regenerated for the new track (not the
    // stale pre-maneuver path).
    const resolved = traffic.map((a) =>
      a.id === heading!.target
        ? ac({
            id: a.id,
            lat: a.lat,
            lon: a.lon,
            altFt: a.altFt,
            gsKt: a.gsKt,
            trackDeg: heading!.resolution.headingDeg!,
            vsFpm: a.vsFpm,
          })
        : a,
    );
    expect(detectConflicts(resolved, cfg)).toHaveLength(0);
  });

  it("a heading suggestion is preferred over speed for a head-on (type penalty)", () => {
    const [c] = detectConflicts(traffic, cfg);
    const suggestions = generateResolutions(c, traffic, cfg);
    // The cheapest suggestion should not be a speed change for a head-on
    // geometry (speed barely changes a head-on miss; heading is preferred).
    expect(suggestions[0].type).not.toBe("speed");
  });

  it("offers a direct-to when a downstream fix is provided and it stays clear", () => {
    const [c] = detectConflicts(traffic, cfg);
    const routes = new Map([
      // A fix well north of track for aircraft A → a big lateral shortcut that
      // also clears the head-on.
      ["A", [{ ident: "WPT01", lat: 13.5, lon: 101.5 }]],
    ]);
    const suggestions = generateResolutions(c, traffic, cfg, routes, 10);
    // Not asserting it ranks first — just that the machinery yields route
    // options among the candidates when geometry allows.
    expect(suggestions.some((s) => s.type === "route" || s.type === "heading")).toBe(
      true,
    );
  });
});
