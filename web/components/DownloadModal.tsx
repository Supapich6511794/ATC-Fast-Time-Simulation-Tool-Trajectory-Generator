"use client";

/**
 * DownloadModal — popup for downloading one route, several routes, or all
 * routes at once, in any combination of formats (.gpkg / .csv / .geojson).
 *
 * Renders nothing when `open` is false; otherwise mounts a backdrop +
 * panel. Closes on backdrop click, ✕ button or Escape.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { API_BASE } from "@/lib/api";
import type { TrajectoryResult } from "@/lib/trajectory/types";

export interface DownloadInfo {
  callsign: string;
  flightKey: string;
  route: string;
  gpkg: string;
  csv: string;
  geojson: string;
}

type Format = "gpkg" | "csv" | "geojson";

const FORMAT_META: Record<Format, { label: string; sub: string }> = {
  gpkg: { label: "GeoPackage (.gpkg)", sub: "POINT Z + indices" },
  csv: { label: "CSV (.csv)", sub: "ATC trajectory format" },
  geojson: { label: "GeoJSON (.geojson)", sub: "3D points, all fields" },
};

interface Props {
  open: boolean;
  onClose: () => void;
  results: TrajectoryResult[];
  downloads: DownloadInfo[];
}

/** Kick off a single file download.
 *
 * Why an iframe instead of `<a>.click()`?
 *   The web and the FastAPI host live on different origins (Vercel vs
 *   Render in prod, :3000 vs :8000 in dev). Cross-origin `<a download>`
 *   triggers a *navigation*, and Chrome / Firefox collapse multiple
 *   navigations into one — meaning all but the last file get dropped
 *   silently. A hidden iframe per file is the canonical workaround: the
 *   server's ``Content-Disposition: attachment`` (set by FastAPI's
 *   `FileResponse(filename=…)`) makes the browser download instead of
 *   render, and each iframe navigation is independent.
 */
function fireDownload(url: string): void {
  const iframe = document.createElement("iframe");
  iframe.src = url;
  iframe.style.display = "none";
  document.body.appendChild(iframe);
  // Give the browser plenty of time to consume the response before
  // removing the iframe — pulling it too early can cancel the transfer.
  setTimeout(() => {
    iframe.parentNode?.removeChild(iframe);
  }, 30000);
}

export default function DownloadModal({
  open,
  onClose,
  results,
  downloads,
}: Props) {
  // Default: all routes + all formats selected.
  const allRouteIdx = useMemo(
    () => downloads.map((_, i) => i),
    [downloads],
  );
  // Both selectors open empty — the user explicitly picks what to
  // download. "Select all" / "All" buttons remain one click away.
  const [routeSel, setRouteSel] = useState<Set<number>>(() => new Set());
  const [fmtSel, setFmtSel] = useState<Set<Format>>(() => new Set());

  // Bundle mode — "separate" downloads each route as its own file
  // (zipped when several); "combined" merges every selected route into
  // a single file per format on the server.
  const [bundleMode, setBundleMode] = useState<"separate" | "combined">(
    "separate",
  );

  // Typeahead state for the route picker — open while focused / typing.
  const [routeQuery, setRouteQuery] = useState("");
  const [routeOpen, setRouteOpen] = useState(false);
  const [routeActive, setRouteActive] = useState(0);
  const routeBlurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset selections to empty whenever the modal opens fresh — the
  // user explicitly picks both routes and formats each session.
  useEffect(() => {
    if (open) {
      setRouteSel(new Set());
      setFmtSel(new Set());
      setBundleMode("separate");
      setRouteQuery("");
      setRouteOpen(false);
      setRouteActive(0);
    }
  }, [open]);

  // Esc closes the modal.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // NOTE: every hook must run on every render. The early `return null`
  // happens **after** all hooks below to keep the hook count stable —
  // React's "Rendered more hooks than during the previous render" error
  // fires the moment any hook sits below this conditional return.

  // Build a ranked typeahead match list over unselected routes only — the
  // selected ones live in the chip row above and don't need to be in the
  // suggestion list. Ranking mirrors IdentCombobox: exact < prefix <
  // substring across the R-tag, the flightKey and the route string.
  const routeMatches = useMemo(() => {
    const q = routeQuery.trim().toUpperCase();
    const candidates = downloads
      .map((d, i) => ({ d, i }))
      .filter(({ i }) => !routeSel.has(i));
    // Return *all* unpicked routes so the user can scroll through them —
    // the dropdown shows ~4 rows at a time and scrolls internally for
    // the rest.
    if (!q) return candidates;
    const rank = (hay: string): number => {
      const h = hay.toUpperCase();
      if (h === q) return 0;
      if (h.startsWith(q)) return 1;
      if (h.includes(q)) return 2;
      return 9;
    };
    return candidates
      .map(({ d, i }) => ({
        d,
        i,
        r: Math.min(rank(`R${i + 1}`), rank(d.flightKey), rank(d.route)),
      }))
      .filter((m) => m.r < 9)
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map(({ d, i }) => ({ d, i }));
  }, [downloads, routeQuery, routeSel]);

  const showRouteList = routeOpen && routeMatches.length > 0;

  const pickRoute = (i: number) => {
    setRouteSel((prev) => new Set(prev).add(i));
    setRouteQuery("");
    setRouteActive(0);
  };

  const removeRoute = (i: number) =>
    setRouteSel((prev) => {
      const next = new Set(prev);
      next.delete(i);
      return next;
    });

  /** Map one user-typed chunk (e.g. "R1", "R12", or a substring of the
   *  route/flightKey) to a download index, or -1 if no match. */
  const matchOneChunk = (raw: string): number => {
    const t = raw.trim().toUpperCase();
    if (!t) return -1;
    // Exact R-tag form: R1, R2, R12, …
    const m = t.match(/^R(\d+)$/);
    if (m) {
      const idx = parseInt(m[1], 10) - 1;
      if (idx >= 0 && idx < downloads.length) return idx;
    }
    // Substring fallback — flightKey or route string.
    for (let i = 0; i < downloads.length; i++) {
      const d = downloads[i];
      if (
        d.flightKey.toUpperCase().includes(t) ||
        d.route.toUpperCase().includes(t)
      ) {
        return i;
      }
    }
    return -1;
  };

  /** Comma / semicolon / pipe / whitespace all act as batch separators —
   *  type "R1,R2,R3" (or paste it) to add three chips at once. */
  const SEPARATORS_RE = /[,;|\s]+/;

  const handleQueryChange = (value: string) => {
    // If the user typed (or pasted) a separator, every fully-typed chunk
    // before the last separator is committed as a chip; the trailing
    // fragment stays in the input so they can keep typing.
    if (SEPARATORS_RE.test(value)) {
      const parts = value.split(SEPARATORS_RE);
      const tail = parts[parts.length - 1];
      const chunks = parts.slice(0, -1).filter(Boolean);
      if (chunks.length > 0) {
        setRouteSel((prev) => {
          const next = new Set(prev);
          for (const c of chunks) {
            const idx = matchOneChunk(c);
            if (idx !== -1) next.add(idx);
          }
          return next;
        });
        setRouteQuery(tail);
        setRouteActive(0);
        return;
      }
    }
    setRouteQuery(value);
    setRouteActive(0);
    setRouteOpen(true);
  };

  function onRouteKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!showRouteList) {
      if (e.key === "ArrowDown" && routeMatches.length) setRouteOpen(true);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setRouteActive((a) => (a + 1) % routeMatches.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setRouteActive(
        (a) => (a - 1 + routeMatches.length) % routeMatches.length,
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Batch path: input contains separators → split + add each chunk.
      const trimmed = routeQuery.trim();
      if (SEPARATORS_RE.test(trimmed)) {
        const chunks = trimmed.split(SEPARATORS_RE).filter(Boolean);
        setRouteSel((prev) => {
          const next = new Set(prev);
          for (const c of chunks) {
            const idx = matchOneChunk(c);
            if (idx !== -1) next.add(idx);
          }
          return next;
        });
        setRouteQuery("");
        setRouteActive(0);
        return;
      }
      // Single path: use the highlighted suggestion.
      const idx = Math.min(routeActive, routeMatches.length - 1);
      pickRoute(routeMatches[idx].i);
    } else if (e.key === "Escape") {
      setRouteOpen(false);
    } else if (e.key === "Backspace" && routeQuery === "" && routeSel.size > 0) {
      // Quick remove: backspace on empty input pops the most recently
      // added route (largest index in the set).
      const last = Math.max(...Array.from(routeSel));
      removeRoute(last);
    }
  }

  function highlight(text: string) {
    const q = routeQuery.trim();
    if (!q) return text;
    const i = text.toUpperCase().indexOf(q.toUpperCase());
    if (i < 0) return text;
    return (
      <>
        {text.slice(0, i)}
        <mark>{text.slice(i, i + q.length)}</mark>
        {text.slice(i + q.length)}
      </>
    );
  }

  const toggleFmt = (f: Format) =>
    setFmtSel((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });

  const total = routeSel.size * fmtSel.size;

  // All hooks have run by this point — safe to short-circuit before the
  // JSX when the modal is closed.
  if (!open) return null;

  // POST a JSON body to an endpoint that returns a file blob, then save
  // it. Returns false on any failure so the caller can fall back.
  const downloadFromEndpoint = async (
    endpoint: string,
    body: unknown,
    fallbackName: string,
  ): Promise<boolean> => {
    try {
      const res = await fetch(`${API_BASE}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      // Cross-origin responses often strip Content-Disposition, so fall
      // back to our own stamped name when the header isn't readable.
      const cd = res.headers.get("content-disposition") ?? "";
      const m = cd.match(/filename="([^"]+)"/);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = m?.[1] ?? fallbackName;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      return true;
    } catch {
      return false;
    }
  };

  const runDownload = async () => {
    const rIdx = Array.from(routeSel).sort((a, b) => a - b);
    const fmts = Array.from(fmtSel);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

    // ---- Combined mode: merge every selected route into ONE file per
    // format (server-side). Single format → that file; several → a zip.
    if (bundleMode === "combined") {
      const flightKeys = rIdx
        .map((i) => downloads[i]?.flightKey)
        .filter((k): k is string => !!k);
      const ext = fmts.length === 1 ? fmts[0] : "zip";
      await downloadFromEndpoint(
        "/api/download_combined",
        { flight_keys: flightKeys, formats: fmts },
        `combined_${stamp}.${ext}`,
      );
      onClose();
      return;
    }

    // ---- Separate mode ----
    const totalFiles = rIdx.length * fmts.length;

    // Single file → direct cross-origin iframe download (no zip overhead).
    if (totalFiles === 1) {
      const d = downloads[rIdx[0]];
      if (d) fireDownload(d[fmts[0]]);
      onClose();
      return;
    }

    // Multiple files → ask the API to bundle them into one .zip. One
    // request, one file, no browser "allow multiple downloads" prompt.
    const files = rIdx.flatMap((i) => {
      const d = downloads[i];
      if (!d) return [] as { flight_key: string; ext: string }[];
      return fmts.map((f) => ({ flight_key: d.flightKey, ext: f }));
    });

    const ok = await downloadFromEndpoint(
      "/api/download_zip",
      { files },
      `trajectories_${stamp}.zip`,
    );
    if (!ok) {
      // Network / server failure: fall back to staggered individual
      // downloads so the user always gets *something*.
      let n = 0;
      for (const i of rIdx) {
        const d = downloads[i];
        if (!d) continue;
        for (const f of fmts) {
          setTimeout(() => fireDownload(d[f]), 250 * n);
          n++;
        }
      }
    }
    onClose();
  };

  return (
    <div className="dlm-backdrop" onClick={onClose} role="presentation">
      <div
        className="dlm-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dlm-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dlm-head">
          <h3 id="dlm-title">⬇ Download trajectories</h3>
          <button
            className="dlm-close"
            onClick={onClose}
            aria-label="Close download dialog"
          >
            ✕
          </button>
        </div>

        {/* Bundle mode — choose BEFORE picking routes. Each option has
            a ⓘ note explained on hover. */}
        <section className="dlm-section">
          <div className="dlm-section-head">
            <span>How to download</span>
          </div>
          <div className="dlm-mode" role="radiogroup" aria-label="Bundle mode">
            <button
              type="button"
              role="radio"
              aria-checked={bundleMode === "separate"}
              className={`dlm-mode-opt${bundleMode === "separate" ? " on" : ""}`}
              onClick={() => setBundleMode("separate")}
            >
              <span className="dlm-mode-radio" aria-hidden="true" />
              <span className="dlm-mode-text">
                <span className="dlm-mode-title">
                  Separate
                  <span
                    className="dlm-note"
                    title="Each selected route is downloaded as its own file (zipped together when you pick several). One file per route × format."
                    aria-label="Download each route as a separate file"
                  >
                    ⓘ
                  </span>
                </span>
                <span className="dlm-mode-sub">one file per route</span>
              </span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={bundleMode === "combined"}
              className={`dlm-mode-opt${bundleMode === "combined" ? " on" : ""}`}
              onClick={() => setBundleMode("combined")}
            >
              <span className="dlm-mode-radio" aria-hidden="true" />
              <span className="dlm-mode-text">
                <span className="dlm-mode-title">
                  Combined
                  <span
                    className="dlm-note"
                    title="All selected routes are merged into a single file per format (e.g. one GeoPackage holding every flight). Best for loading a whole traffic scenario at once."
                    aria-label="Merge all routes into one file"
                  >
                    ⓘ
                  </span>
                </span>
                <span className="dlm-mode-sub">all routes in one file</span>
              </span>
            </button>
          </div>
        </section>

        <section className="dlm-section">
          <div className="dlm-section-head">
            <span>Routes</span>
            <div className="dlm-quick">
              <button onClick={() => setRouteSel(new Set(allRouteIdx))}>
                Select all
              </button>
              <button onClick={() => setRouteSel(new Set())}>None</button>
            </div>
          </div>

          {/* Selected routes appear as chips. Click ✕ on a chip to drop
              it; selected routes are also removed from the typeahead
              suggestions so the user can't pick the same one twice. */}
          <div
            className={`dlm-combo${routeOpen ? " open" : ""}`}
            onClick={() => {
              setRouteOpen(true);
            }}
          >
            {routeSel.size > 0 && (
              <div className="dlm-chips">
                {Array.from(routeSel)
                  .sort((a, b) => a - b)
                  .map((i) => {
                    const d = downloads[i];
                    if (!d) return null;
                    return (
                      <span
                        key={d.flightKey}
                        className="dlm-chip"
                        title={d.route}
                      >
                        <span className="dlm-chip-tag">R{i + 1}</span>
                        <span className="dlm-chip-route">{d.route}</span>
                        <button
                          type="button"
                          className="dlm-chip-x"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeRoute(i);
                          }}
                          aria-label={`Remove R${i + 1}`}
                        >
                          ✕
                        </button>
                      </span>
                    );
                  })}
              </div>
            )}

            <input
              type="text"
              className="dlm-combo-input"
              placeholder={
                routeSel.size === 0
                  ? "Type R1, R2, R3… or paste a list to add many at once"
                  : "Add more — e.g. R3, R4"
              }
              value={routeQuery}
              onChange={(e) => handleQueryChange(e.target.value)}
              onFocus={() => setRouteOpen(true)}
              onBlur={() => {
                // Delay close so a click on a suggestion still fires.
                routeBlurTimer.current = setTimeout(
                  () => setRouteOpen(false),
                  140,
                );
              }}
              onKeyDown={onRouteKeyDown}
              aria-autocomplete="list"
              aria-expanded={showRouteList}
              role="combobox"
              autoComplete="off"
            />

            {showRouteList && (
              <ul className="dlm-suggest" role="listbox">
                {routeMatches.map(({ d, i }, idx) => (
                  <li
                    key={d.flightKey}
                    role="option"
                    aria-selected={idx === routeActive}
                  >
                    <button
                      type="button"
                      className={idx === routeActive ? "active" : undefined}
                      onMouseEnter={() => setRouteActive(idx)}
                      onMouseDown={(e) => {
                        // Don't blur the input — keeps the picker open
                        // when the user adds several routes in a row.
                        e.preventDefault();
                        if (routeBlurTimer.current)
                          clearTimeout(routeBlurTimer.current);
                      }}
                      onClick={() => pickRoute(i)}
                    >
                      <span className="dlm-sug-tag">R{i + 1}</span>
                      <span className="dlm-sug-main">
                        <span className="dlm-sug-key">
                          {highlight(d.flightKey)}
                        </span>
                        <span className="dlm-sug-route">
                          ↳ {highlight(d.route)}
                        </span>
                      </span>
                      {results[i] && (
                        <span className="dlm-sug-meta">
                          {results[i].stats.distanceNm} NM
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {routeSel.size === 0 && (
            <p className="dlm-empty-hint">
              No routes selected — pick one from the list above to enable
              download.
            </p>
          )}
        </section>

        <section className="dlm-section">
          <div className="dlm-section-head">
            <span>Formats</span>
            <div className="dlm-quick">
              <button
                onClick={() => setFmtSel(new Set(["gpkg", "csv", "geojson"]))}
              >
                All
              </button>
              <button onClick={() => setFmtSel(new Set())}>None</button>
            </div>
          </div>
          {/* Horizontal pill row — click any pill to toggle that format
              on/off; multi-select preserved (any combination allowed). */}
          <div
            className="dlm-fmt-row"
            role="group"
            aria-label="File formats"
          >
            {(Object.keys(FORMAT_META) as Format[]).map((f) => {
              const meta = FORMAT_META[f];
              const checked = fmtSel.has(f);
              return (
                <button
                  key={f}
                  type="button"
                  className={`dlm-fmt-pill${checked ? " on" : ""}`}
                  onClick={() => toggleFmt(f)}
                  aria-pressed={checked}
                  title={meta.sub}
                >
                  <span className="dlm-fmt-check" aria-hidden="true">
                    {checked ? "✓" : ""}
                  </span>
                  <span className="dlm-fmt-pill-label">{meta.label}</span>
                </button>
              );
            })}
          </div>
        </section>

        <div className="dlm-foot">
          <span className="dlm-foot-note">
            {total === 0
              ? "Pick at least one route and one format"
              : bundleMode === "combined"
                ? `${routeSel.size} route${routeSel.size === 1 ? "" : "s"} merged → ${
                    fmtSel.size === 1
                      ? `1 ${Array.from(fmtSel)[0]} file`
                      : `${fmtSel.size} files (zip)`
                  }`
                : `${total} file${total === 1 ? "" : "s"} will download`}
          </span>
          <div className="dlm-foot-btns">
            <button className="dlm-cancel" onClick={onClose}>
              Cancel
            </button>
            <button
              className="dlm-go"
              onClick={runDownload}
              disabled={total === 0}
            >
              ⬇ Download {total > 0 ? `(${total})` : ""}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
