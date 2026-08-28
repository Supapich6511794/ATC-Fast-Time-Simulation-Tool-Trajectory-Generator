/**
 * Progress accounting for the export downloads (see `DownloadModal`).
 *
 * An export runs in two measurable phases:
 *
 *   prepare   the server renders one file per route (GDAL writing the
 *             GeoPackage is the slow part, and each route's file is written
 *             lazily on first download). The dialog drives this itself via
 *             `/api/export_prepare`, so it can count routes rendered and the
 *             bytes they came to — otherwise this phase happens invisibly
 *             inside the download request, which is what left the dialog
 *             sitting on "Preparing…".
 *   transfer  the response body streams back, counted against Content-Length.
 *
 * `res.blob()` resolves only when the whole file is in, so `readBody` drains
 * the stream by hand to count the bytes as they arrive.
 */

/** How far an export has got. */
export interface Progress {
  /** What the export is doing right now. */
  phase: "stamp" | "prepare" | "transfer";
  /** 1-based output file being produced, and how many this run will produce. */
  step: number;
  steps: number;
  /** What is being produced, e.g. "GeoPackage (.gpkg)" or "zip of 6 files". */
  label: string;
  /** Prepare phase: per-route files rendered, of how many, and their size. */
  preparedFiles: number;
  totalFiles: number;
  preparedBytes: number;
  /** Transfer phase. `totalBytes` is null when the response carried no
   *  readable Content-Length, which leaves the bar indeterminate. */
  receivedBytes: number;
  totalBytes: number | null;
}

/** A fresh Progress for the start of a phase. */
export function startProgress(over: Partial<Progress> = {}): Progress {
  return {
    phase: "prepare",
    step: 1,
    steps: 1,
    label: "",
    preparedFiles: 0,
    totalFiles: 0,
    preparedBytes: 0,
    receivedBytes: 0,
    totalBytes: null,
    ...over,
  };
}

/**
 * Read a response body to a Blob, reporting bytes as they arrive.
 *
 * Content-Length is CORS-safelisted, so the total is readable even though the
 * API is a different origin (unlike Content-Disposition, which needs an
 * explicit expose header). Falls back to `res.blob()` when the body cannot be
 * streamed or nobody is listening.
 */
export async function readBody(
  res: Response,
  onBytes?: (received: number, total: number | null) => void,
): Promise<Blob> {
  const header = Number(res.headers.get("content-length"));
  const total = Number.isFinite(header) && header > 0 ? header : null;
  if (!res.body || !onBytes) return res.blob();

  const reader = res.body.getReader();
  const chunks: BlobPart[] = [];
  let received = 0;
  onBytes(0, total);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onBytes(received, total);
  }
  return new Blob(chunks, {
    type: res.headers.get("content-type") ?? "application/octet-stream",
  });
}

/** Bytes as a short human string: 934 kB, 11.8 MB. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Whole-percent done, or null when the phase has nothing countable —
 *  stamping, or a transfer whose size the response never stated. */
export function progressPercent(p: Progress): number | null {
  if (p.phase === "prepare") {
    if (!p.totalFiles) return null;
    return Math.round((p.preparedFiles / p.totalFiles) * 100);
  }
  if (p.phase === "transfer" && p.totalBytes) {
    // A proxy that re-compresses the body reports the compressed length while
    // the reader yields the decompressed bytes, so this can overshoot.
    return Math.min(100, Math.round((p.receivedBytes / p.totalBytes) * 100));
  }
  return null;
}

/** The line shown under the bar: what is happening, and how far in. */
export function progressNote(p: Progress | null, fileCount: number): string {
  if (!p) {
    return `Preparing ${fileCount} file${fileCount === 1 ? "" : "s"}…`;
  }
  const ofFiles = p.steps > 1 ? ` (file ${p.step} of ${p.steps})` : "";
  if (p.phase === "stamp") {
    return "Stamping the exports with their current conflict state…";
  }
  if (p.phase === "prepare") {
    if (!p.totalFiles) {
      return `Preparing ${p.label}${ofFiles} on the server… (large exports can take a few seconds)`;
    }
    const size = p.preparedBytes ? ` — ${formatBytes(p.preparedBytes)} ready` : "";
    return `Rendering ${p.label}${ofFiles} — route ${Math.min(p.preparedFiles + 1, p.totalFiles)} of ${p.totalFiles}${size}`;
  }
  const of = p.totalBytes ? ` of ${formatBytes(p.totalBytes)}` : "";
  return `Downloading ${p.label}${ofFiles} — ${formatBytes(p.receivedBytes)}${of}`;
}
