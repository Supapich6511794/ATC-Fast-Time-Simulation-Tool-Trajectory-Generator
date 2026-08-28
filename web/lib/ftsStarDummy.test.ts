/**
 * The re-filed FTS traffic day (dummy_data/fts_traffic_20260709Star.csv).
 *
 * It is the same 1 990 flights as fts_traffic_20260709.csv, but filed the way
 * the generator panel would file them: AIP route, measured runway, SID/STAR,
 * and the approach where the runway publishes only one. A fixture that nobody
 * checks drifts, so this reads the checked-in file through the SAME parser the
 * upload button uses and holds it to those claims.
 *
 * Regenerate with:
 *   python scripts/make_fts_star_traffic.py
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { parseFlightFile } from "./flightFile";

const FILE = resolve(__dirname, "../../dummy_data/fts_traffic_20260709Star.csv");
const SOURCE = resolve(__dirname, "../../dummy_data/fts_traffic_20260709.csv");

// Generated artefacts, legitimately absent on a fresh clone.
const present = existsSync(FILE);
const suite = present ? describe : describe.skip;

const records = present
  ? await parseFlightFile(
      new File([readFileSync(FILE, "utf-8")], "fts_traffic_20260709Star.csv"),
    )
  : [];

/** A Thai aerodrome — the only ones the AIP data covers. */
const isVT = (icao?: string) => !!icao && icao.startsWith("VT");

suite("fts_traffic_20260709Star fixture", () => {
  it("imports as editable plans, not as trajectories", () => {
    // The point of the file is to be GENERATED with its procedures; a file
    // carrying 4D samples would be loaded as-is and never fly them.
    expect(records.length).toBe(1990);
    expect(records.every((r) => r.trajectory == null)).toBe(true);
  });

  it("keeps every flight of the source day", () => {
    const src = readFileSync(SOURCE, "utf-8");
    const blocks = (src.match(/^FLIGHT \d+ of \d+/gm) ?? []).length;
    expect(records.length).toBe(blocks);
  });

  it("gives every row a callsign, city pair, level, EOBT and route", () => {
    for (const r of records) {
      expect(r.callsign).toMatch(/^[A-Z0-9]{3,}$/);
      expect(r.adep).toMatch(/^[A-Z]{4}$/);
      expect(r.ades).toMatch(/^[A-Z]{4}$/);
      expect(r.eobt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
      expect(r.rfl).toBeGreaterThan(0);
      expect(r.route && r.route.length).toBeGreaterThan(0);
    }
  });

  it("files procedures at the THAI end of a flight, not the foreign one", () => {
    // The AIP data is Thai. A departure from a foreign field cannot carry a
    // SID and must not pretend to; the same flight's arrival still can.
    for (const r of records) {
      if (!isVT(r.adep)) {
        expect(r.sid ?? "").toBe("");
        expect(r.depRwy ?? "").toBe("");
      }
      if (!isVT(r.ades)) {
        expect(r.star ?? "").toBe("");
        expect(r.arrRwy ?? "").toBe("");
        expect(r.approach ?? "").toBe("");
      }
    }
  });

  it("actually files procedures — most of the day, not a token few", () => {
    const withSid = records.filter((r) => r.sid).length;
    const withStar = records.filter((r) => r.star).length;
    const withRwy = records.filter((r) => r.depRwy || r.arrRwy).length;
    expect(withSid).toBeGreaterThan(1000);
    expect(withStar).toBeGreaterThan(900);
    expect(withRwy).toBeGreaterThan(1400);
  });

  it("names a runway whenever the procedure is coded to one", () => {
    // The runway is what a runway-specific SID/STAR is coded to; filed against
    // "Auto" it would resolve to whichever runway the engine picked first.
    // OMNI is the exception and the reason this is not a blanket rule: an
    // omnidirectional departure serves every runway, so it has none to name.
    for (const r of records) {
      if (r.sid && r.sid !== "OMNI") expect(r.depRwy).toBeTruthy();
      if (r.star) expect(r.arrRwy).toBeTruthy();
    }
    // …and the exception really is only that.
    const noRwy = records.filter((r) => r.sid && !r.depRwy);
    expect(noRwy.every((r) => r.sid === "OMNI")).toBe(true);
  });

  it("only files an approach for the runway it belongs to", () => {
    // R36 is RW36's approach. A mismatch would be dropped by the panel the
    // moment the file was imported.
    for (const r of records) {
      if (!r.approach) continue;
      expect(r.arrRwy).toBeTruthy();
      const m = /^R(\d{2}[LCR]?)(?:-.*)?$/.exec(r.approach.toUpperCase());
      expect(m).not.toBeNull();
      expect(`RW${m![1]}`).toBe(r.arrRwy);
    }
  });

  it("carries the AIP filed route on the domestic pairs", () => {
    // Sampled against the published routes rather than asserted wholesale:
    // pairs the AIP publishes nothing for keep the route they came with.
    const aip = JSON.parse(
      readFileSync(
        resolve(__dirname, "../public/data/aip_routes_VT.json"),
        "utf-8",
      ),
    ) as { routes: { adep: string; ades: string; route: string }[] };
    const byPair = new Map<string, Set<string>>();
    for (const r of aip.routes) {
      const key = `${r.adep}|${r.ades}`;
      byPair.set(key, (byPair.get(key) ?? new Set()).add(r.route));
    }
    const domestic = records.filter(
      (r) => isVT(r.adep) && isVT(r.ades) && byPair.has(`${r.adep}|${r.ades}`),
    );
    expect(domestic.length).toBeGreaterThan(500);
    const filed = domestic.filter((r) =>
      byPair.get(`${r.adep}|${r.ades}`)!.has(r.route ?? ""),
    );
    // Every domestic flight whose pair HAS a published route flies one.
    expect(filed.length).toBe(domestic.length);
  });
});
