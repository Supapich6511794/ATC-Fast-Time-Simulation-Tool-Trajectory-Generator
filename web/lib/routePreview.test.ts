/**
 * Airway expansion for the live route preview.
 *
 * The panel resolves EVERY plan's route on every render (the "Full" preview
 * scope draws all tabs), so this function runs thousands of times on a bulk
 * import — and it runs synchronously on the main thread. A route it cannot
 * terminate on does not degrade the page, it kills it.
 */
import { describe, expect, it } from "vitest";

import { resolveRoutePreview } from "./routePreview";

const FIXES = [
  { ident: "AAAAA", lat: 10, lon: 100 },
  { ident: "BBBBB", lat: 11, lon: 100 },
  { ident: "CCCCC", lat: 12, lon: 100 },
  { ident: "DDDDD", lat: 13, lon: 100 },
];
const AIRWAYS = { W1: ["AAAAA", "BBBBB", "CCCCC", "DDDDD"] };

describe("resolveRoutePreview", () => {
  it("fills in the fixes between the two ends of an airway leg", () => {
    const pts = resolveRoutePreview("AAAAA W1 DDDDD", FIXES, AIRWAYS);
    expect(pts.map((p) => p.ident)).toEqual(["AAAAA", "BBBBB", "CCCCC", "DDDDD"]);
    expect(pts.map((p) => p.fromUser)).toEqual([true, false, false, true]);
  });

  it("walks the airway backwards too", () => {
    const pts = resolveRoutePreview("DDDDD W1 AAAAA", FIXES, AIRWAYS);
    expect(pts.map((p) => p.ident)).toEqual(["DDDDD", "CCCCC", "BBBBB", "AAAAA"]);
  });

  it("terminates when a route joins and leaves an airway at the SAME fix", () => {
    // "VAPVU P629 VAPVU" — a real filed route in the FTS traffic sample. The
    // walk used to step backwards off the front of the array for ever, which
    // froze the whole page the moment that file was imported.
    const pts = resolveRoutePreview("BBBBB W1 BBBBB", FIXES, AIRWAYS);
    expect(pts.map((p) => p.ident)).toEqual(["BBBBB"]);
  });

  it("terminates on a same-fix leg at either end of the airway", () => {
    expect(
      resolveRoutePreview("AAAAA W1 AAAAA", FIXES, AIRWAYS).map((p) => p.ident),
    ).toEqual(["AAAAA"]);
    expect(
      resolveRoutePreview("DDDDD W1 DDDDD", FIXES, AIRWAYS).map((p) => p.ident),
    ).toEqual(["DDDDD"]);
  });

  it("leaves a DCT leg unexpanded", () => {
    const pts = resolveRoutePreview("AAAAA DCT DDDDD", FIXES, AIRWAYS);
    expect(pts.map((p) => p.ident)).toEqual(["AAAAA", "DDDDD"]);
  });

  it("ignores idents that are still being typed", () => {
    expect(resolveRoutePreview("AAAA", FIXES, AIRWAYS)).toEqual([]);
    expect(
      resolveRoutePreview("AAAAA W1 CCC", FIXES, AIRWAYS).map((p) => p.ident),
    ).toEqual(["AAAAA"]);
  });
});
