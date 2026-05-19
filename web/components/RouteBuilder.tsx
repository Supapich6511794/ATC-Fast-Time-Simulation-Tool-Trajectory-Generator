"use client";

/**
 * RouteBuilder — build a route by picking waypoints by hand instead of
 * typing an Item-15 string.
 *
 * Proper typeahead/autosuggest: ranked matches (exact → prefix →
 * substring), full keyboard navigation (↑/↓/Enter/Esc), matched-text
 * highlighting, and an ARIA combobox. Click or Enter appends; the chosen
 * idents reorder/remove as an ordered list. Scales to long routes.
 */

import { useMemo, useRef, useState } from "react";

interface Props {
  /** All selectable waypoint idents (from the airway file). */
  idents: string[];
  /** Current ordered selection. */
  selected: string[];
  onChange: (next: string[]) => void;
}

const MAX_SUGGESTIONS = 10;

/** Rank: exact (0) < prefix (1) < substring (2); unranked filtered out. */
function rank(ident: string, q: string): number {
  if (ident === q) return 0;
  if (ident.startsWith(q)) return 1;
  if (ident.includes(q)) return 2;
  return -1;
}

export default function RouteBuilder({ idents, selected, onChange }: Props) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const matches = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return [];
    return idents
      .map((id) => ({ id, r: rank(id.toUpperCase(), q) }))
      .filter((m) => m.r >= 0)
      .sort((a, b) => a.r - b.r || a.id.localeCompare(b.id))
      .slice(0, MAX_SUGGESTIONS)
      .map((m) => m.id);
  }, [idents, query]);

  const showList = open && matches.length > 0;

  const add = (ident: string) => {
    onChange([...selected, ident]);
    setQuery("");
    setActive(0);
    setOpen(false);
  };
  const removeAt = (i: number) =>
    onChange(selected.filter((_, idx) => idx !== i));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= selected.length) return;
    const next = [...selected];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!showList) {
      if (e.key === "ArrowDown" && matches.length) setOpen(true);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % matches.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + matches.length) % matches.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      add(matches[Math.min(active, matches.length - 1)]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  /** Bold the part of the ident that matched the query. */
  function highlight(ident: string) {
    const q = query.trim();
    const i = ident.toUpperCase().indexOf(q.toUpperCase());
    if (!q || i < 0) return ident;
    return (
      <>
        {ident.slice(0, i)}
        <mark>{ident.slice(i, i + q.length)}</mark>
        {ident.slice(i + q.length)}
      </>
    );
  }

  return (
    <div className="rb">
      <div className="rb-search">
        <input
          type="text"
          role="combobox"
          aria-expanded={showList}
          aria-controls="rb-listbox"
          aria-autocomplete="list"
          autoComplete="off"
          value={query}
          placeholder="Search waypoint (e.g. MOTNA)…"
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            // Delay so a suggestion click registers before closing.
            blurTimer.current = setTimeout(() => setOpen(false), 120);
          }}
          onKeyDown={onKeyDown}
        />
        {showList && (
          <ul className="rb-suggest" id="rb-listbox" role="listbox">
            {matches.map((m, idx) => (
              <li key={m} role="option" aria-selected={idx === active}>
                <button
                  type="button"
                  className={idx === active ? "active" : undefined}
                  onMouseEnter={() => setActive(idx)}
                  onMouseDown={(e) => {
                    // Prevent input blur before the click handler runs.
                    e.preventDefault();
                    if (blurTimer.current) clearTimeout(blurTimer.current);
                  }}
                  onClick={() => add(m)}
                >
                  {highlight(m)}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {selected.length === 0 ? (
        <p className="rb-empty">No waypoints yet — search and add above.</p>
      ) : (
        <ol className="rb-list">
          {selected.map((id, i) => (
            <li key={`${id}-${i}`}>
              <span className="rb-seq">{i + 1}</span>
              <span className="rb-ident">{id}</span>
              <span className="rb-actions">
                <button
                  type="button"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  title="Move up"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => move(i, 1)}
                  disabled={i === selected.length - 1}
                  title="Move down"
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="rb-del"
                  onClick={() => removeAt(i)}
                  title="Remove"
                >
                  ✕
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}

      {selected.length > 0 && (
        <button
          type="button"
          className="rb-clear"
          onClick={() => onChange([])}
        >
          Clear all
        </button>
      )}
    </div>
  );
}
