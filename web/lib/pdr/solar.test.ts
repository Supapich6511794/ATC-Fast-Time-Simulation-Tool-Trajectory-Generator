/**
 * Six Thai P/R areas are active "sunset to sunrise", so these instants decide
 * whether a night flight conflicts with a PROHIBITED area. The values are
 * pinned against published Bangkok almanac times (ICT = UTC+7) rather than
 * against the implementation, so a regression in the solar maths shows up as a
 * wrong clock time instead of a silently shifted window.
 */
import { describe, expect, it } from "vitest";

import { sunTimes } from "./solar";

/** Bangkok (VTBS/VTBD reference point). */
const BKK = { lat: 13.7563, lon: 100.5018 };

/** Local (ICT) hour of an instant, as a decimal. */
function localHour(ms: number): number {
  return (((ms + 7 * 3600000) % 86400000) / 3600000 + 24) % 24;
}

function times(y: number, m: number, d: number, at = BKK) {
  const t = sunTimes(new Date(Date.UTC(y, m, d)), at.lat, at.lon);
  if (!t) throw new Error("no sun times");
  return t;
}

describe("sunTimes over Bangkok", () => {
  it("puts the September equinox sunrise near 0605 local", () => {
    const t = times(2026, 8, 7); // 7 Sep 2026
    expect(localHour(t.sunriseMs)).toBeGreaterThan(5.8);
    expect(localHour(t.sunriseMs)).toBeLessThan(6.4);
  });

  it("puts the same day's sunset near 1825 local", () => {
    const t = times(2026, 8, 7);
    expect(localHour(t.sunsetMs)).toBeGreaterThan(18.1);
    expect(localHour(t.sunsetMs)).toBeLessThan(18.7);
  });

  it("gives a near-12-hour day at the equinox", () => {
    const t = times(2026, 8, 23); // ~equinox
    const hours = (t.sunsetMs - t.sunriseMs) / 3600000;
    expect(hours).toBeGreaterThan(11.9);
    expect(hours).toBeLessThan(12.3);
  });

  it("gives the longest day in June and the shortest in December", () => {
    const june = times(2026, 5, 21);
    const dec = times(2026, 11, 21);
    const len = (t: { sunriseMs: number; sunsetMs: number }) =>
      (t.sunsetMs - t.sunriseMs) / 3600000;
    // Bangkok's swing is small (13.8°N): about 12h56m to 11h21m.
    expect(len(june)).toBeGreaterThan(12.7);
    expect(len(june)).toBeLessThan(13.2);
    expect(len(dec)).toBeGreaterThan(11.1);
    expect(len(dec)).toBeLessThan(11.6);
    expect(len(june)).toBeGreaterThan(len(dec));
  });

  it("has sunrise before sunset on the same UTC day frame", () => {
    const t = times(2026, 8, 7);
    expect(t.sunriseMs).toBeLessThan(t.sunsetMs);
  });

  it("returns null inside the polar night", () => {
    expect(sunTimes(new Date(Date.UTC(2026, 11, 21)), 85, 0)).toBeNull();
  });
});
