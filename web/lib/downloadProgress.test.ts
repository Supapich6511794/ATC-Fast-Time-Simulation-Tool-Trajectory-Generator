/**
 * Tests for the export download progress accounting (see downloadProgress.ts).
 *
 * The point of `readBody` is that the caller learns how far a download has got
 * WHILE it is arriving — `res.blob()` only resolves at the end, which is why
 * the dialog used to sit on "Preparing…" for the whole transfer.
 */

import { describe, expect, it, vi } from "vitest";

import {
  formatBytes,
  progressNote,
  progressPercent,
  readBody,
  startProgress,
  type Progress,
} from "./downloadProgress";

/** A Response whose body arrives in the given chunks. */
function streamed(
  chunks: number[][],
  headers: Record<string, string> = {},
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new Uint8Array(c));
      controller.close();
    },
  });
  return new Response(body, { headers });
}

const progress = (over: Partial<Progress> = {}): Progress =>
  startProgress({ phase: "transfer", label: "GeoPackage (.gpkg)", ...over });

describe("readBody", () => {
  it("reports the running byte count as chunks arrive", async () => {
    const seen: [number, number | null][] = [];
    const blob = await readBody(
      streamed([[1, 2, 3], [4, 5], [6]], { "content-length": "6" }),
      (received, total) => seen.push([received, total]),
    );

    // One call before the first chunk so the bar starts at 0, then one per
    // chunk — cumulative, not per-chunk sizes.
    expect(seen).toEqual([
      [0, 6],
      [3, 6],
      [5, 6],
      [6, 6],
    ]);
    expect(blob.size).toBe(6);
  });

  it("returns the whole body even when nobody is watching", async () => {
    const blob = await readBody(streamed([[1, 2], [3]]));
    expect(blob.size).toBe(3);
  });

  it("reports a null total when Content-Length is absent or unusable", async () => {
    const seen: (number | null)[] = [];
    await readBody(streamed([[1]]), (_r, total) => seen.push(total));
    expect(seen).toEqual([null, null]);

    // A cross-origin response that hides the header sends nothing readable;
    // a chunked one can send "0". Neither is a size.
    const zero: (number | null)[] = [];
    await readBody(streamed([[1]], { "content-length": "0" }), (_r, total) =>
      zero.push(total),
    );
    expect(zero).toEqual([null, null]);
  });

  it("falls back to blob() when the body cannot be streamed", async () => {
    const res = {
      body: null,
      headers: new Headers({ "content-length": "2" }),
      blob: vi.fn(async () => new Blob(["ab"])),
    };
    const blob = await readBody(res as unknown as Response, () => {});
    expect(res.blob).toHaveBeenCalled();
    expect(blob.size).toBe(2);
  });
});

describe("progressPercent", () => {
  it("is null when the phase has nothing countable", () => {
    expect(progressPercent(progress({ phase: "stamp" }))).toBeNull();
    // A prepare that isn't driving the per-route render itself (no route
    // count) is back to being an opaque wait.
    expect(
      progressPercent(progress({ phase: "prepare", totalFiles: 0 })),
    ).toBeNull();
    // A transfer whose response never stated its size.
    expect(
      progressPercent(progress({ receivedBytes: 500, totalBytes: null })),
    ).toBeNull();
  });

  it("counts routes rendered while preparing", () => {
    const preparing = (done: number) =>
      progress({ phase: "prepare", preparedFiles: done, totalFiles: 20 });
    expect(progressPercent(preparing(0))).toBe(0);
    expect(progressPercent(preparing(5))).toBe(25);
    expect(progressPercent(preparing(20))).toBe(100);
  });

  it("rounds to whole percent", () => {
    expect(
      progressPercent(progress({ receivedBytes: 1, totalBytes: 3 })),
    ).toBe(33);
    expect(
      progressPercent(progress({ receivedBytes: 0, totalBytes: 800 })),
    ).toBe(0);
  });

  it("clamps at 100 when a proxy compresses the body", () => {
    // Content-Length is the compressed size; the reader yields more than that.
    expect(
      progressPercent(progress({ receivedBytes: 4000, totalBytes: 1000 })),
    ).toBe(100);
  });
});

describe("formatBytes", () => {
  it("scales the unit to the size", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 kB");
    expect(formatBytes(12_373_197)).toBe("11.8 MB");
  });
});

describe("progressNote", () => {
  it("names the phase the export is in", () => {
    expect(progressNote(progress({ phase: "stamp" }), 1)).toMatch(
      /conflict state/,
    );
    expect(progressNote(progress({ phase: "prepare" }), 1)).toMatch(
      /^Preparing GeoPackage \(\.gpkg\) on the server/,
    );
  });

  it("counts the files only when there is more than one", () => {
    const many = progress({ phase: "prepare", step: 2, steps: 3 });
    expect(progressNote(many, 3)).toContain("(file 2 of 3)");
    expect(progressNote(progress({ phase: "prepare" }), 1)).not.toContain(
      "file 1 of 1",
    );
  });

  it("reports the route being rendered and the bytes ready", () => {
    const p = progress({
      phase: "prepare",
      preparedFiles: 7,
      totalFiles: 20,
      preparedBytes: 626_688,
    });
    // "route 8" — the one being worked on, not the seven already done.
    expect(progressNote(p, 1)).toBe(
      "Rendering GeoPackage (.gpkg) — route 8 of 20 — 612 kB ready",
    );
  });

  it("does not count past the last route on the final batch", () => {
    const done = progress({
      phase: "prepare",
      preparedFiles: 4,
      totalFiles: 4,
      preparedBytes: 2048,
    });
    expect(progressNote(done, 1)).toContain("route 4 of 4");
  });

  it("shows received against total while transferring", () => {
    const p = progress({ receivedBytes: 1_048_576, totalBytes: 4_194_304 });
    expect(progressNote(p, 1)).toBe(
      "Downloading GeoPackage (.gpkg) — 1.0 MB of 4.0 MB",
    );
    // Unknown size: report what has arrived, and claim nothing about the rest.
    expect(progressNote(progress({ receivedBytes: 2048 }), 1)).toBe(
      "Downloading GeoPackage (.gpkg) — 2 kB",
    );
  });

  it("falls back to a file count before any phase has started", () => {
    expect(progressNote(null, 2)).toBe("Preparing 2 files…");
    expect(progressNote(null, 1)).toBe("Preparing 1 file…");
  });
});
