"use client";

/**
 * IdentCombobox — a single-value typeahead (type freely AND get ranked
 * suggestions), used for the ADEP/ADES ICAO fields.
 *
 * Same look/behaviour as the RouteBuilder waypoint search (it reuses the
 * .rb-search / .rb-suggest styles): ranked matches (exact → prefix →
 * substring), keyboard nav (↑/↓/Enter/Esc), matched-text highlight, ARIA
 * combobox. Unlike RouteBuilder this keeps a single editable value — the
 * user may type an ICAO not in the list and it is still accepted.
 */

import { useMemo, useRef, useState } from "react";

export interface ComboOption {
  code: string;
  label: string;
}

interface Props {
  value: string;
  onChange: (next: string) => void;
  options: ComboOption[];
  placeholder?: string;
}

const MAX_SUGGESTIONS = 8;

/** Rank: exact (0) < prefix (1) < substring (2); unranked filtered out. */
function rank(hay: string, q: string): number {
  if (hay === q) return 0;
  if (hay.startsWith(q)) return 1;
  if (hay.includes(q)) return 2;
  return -1;
}

export default function IdentCombobox({
  value,
  onChange,
  options,
  placeholder,
}: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const matches = useMemo(() => {
    const q = value.trim().toUpperCase();
    if (!q) return options.slice(0, MAX_SUGGESTIONS);
    return options
      .map((o) => ({
        o,
        r: Math.min(
          ...[rank(o.code.toUpperCase(), q), rank(o.label.toUpperCase(), q)]
            .map((x) => (x < 0 ? 9 : x)),
        ),
      }))
      .filter((m) => m.r < 9)
      .sort((a, b) => a.r - b.r || a.o.code.localeCompare(b.o.code))
      .slice(0, MAX_SUGGESTIONS)
      .map((m) => m.o);
  }, [options, value]);

  const showList = open && matches.length > 0;

  const pick = (code: string) => {
    onChange(code);
    setOpen(false);
    setActive(0);
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
      pick(matches[Math.min(active, matches.length - 1)].code);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  function highlight(text: string) {
    const q = value.trim();
    const i = text.toUpperCase().indexOf(q.toUpperCase());
    if (!q || i < 0) return text;
    return (
      <>
        {text.slice(0, i)}
        <mark>{text.slice(i, i + q.length)}</mark>
        {text.slice(i + q.length)}
      </>
    );
  }

  return (
    <div className="rb-search">
      <input
        type="text"
        role="combobox"
        aria-expanded={showList}
        aria-autocomplete="list"
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value.toUpperCase());
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          blurTimer.current = setTimeout(() => setOpen(false), 120);
        }}
        onKeyDown={onKeyDown}
      />
      {showList && (
        <ul className="rb-suggest" role="listbox">
          {matches.map((m, idx) => (
            <li key={m.code} role="option" aria-selected={idx === active}>
              <button
                type="button"
                className={idx === active ? "active" : undefined}
                onMouseEnter={() => setActive(idx)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  if (blurTimer.current) clearTimeout(blurTimer.current);
                }}
                onClick={() => pick(m.code)}
              >
                <strong>{highlight(m.code)}</strong>{" "}
                <span className="combo-label">{highlight(m.label)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
