# UX/UI Guide — "Night Radar Console"

## Applying the flight-animation design system to the ATC Fast-Time Simulation Tool

**Audience.** An agent working in the ATC Fast-Time Simulation Tool repository
(`Supapich6511794/ATC-Fast-Time-Simulation-Tool-Trajectory-Generator`, local
clone `~/dev/atc-fts`), specifically its `web/` front end.

**Goal.** Bring that front end into visual and interaction alignment with the
flight-animation applications served on `:5173` (historical replay) and `:5174`
(live feed), which are one React application built in two modes from
`~/cat-data-analytics/flight-animation-main`.

**Relationship to `FIGMA_REDESIGN_PROMPT.md`** (already in the simulator repo).
That document is the *functional* contract: it inventories every control in
regions A–K and forbids removing or hiding any of them. This document is the
*visual and behavioural* contract: it says what those controls should look like
and how they should behave. The two do not conflict, and where this guide says
"replace control X with pattern Y" it means restyle in place — the function
survives. **No control listed in the Figma brief's Section 4 may be dropped as
a result of applying this guide.**

---

## 1. Current state of the simulator front end

Verified against `HEAD = 241caa0` (pulled 12 September 2026; the three commits
after PR #4 are "Departure separation, arrival sequencing, conflict-aware
exports", "AIXM 2608 terminal procedures, measurable export downloads", and
"PDR route check, AIXM 5.1.1 source, keyless dark basemap fallback").

| | Simulator (`web/`) | flight-anim (reference) |
|---|---|---|
| Framework | Next.js 14.2, React 18.3 | Vite (rolldown), React 19.2 |
| Map | Leaflet 1.9.4, react-leaflet 4.2.1 | Leaflet 1.9.4, react-leaflet 5.0 |
| Styling | one `app/globals.css`, 9,467 lines | one `src/index.css`, 7,090 lines |
| Layout | 460px fixed sidebar + flex map | full-bleed map, floating chrome |
| Theme | `Theme = dark \| light`, `.app.theme-light` | `body.light-mode` |
| Base map | `Basemap = streets \| satellite \| dark` | `dark \| light \| street \| satellite` |
| Design tokens | 6 | ~40 |
| Raw hex values in CSS | 858 | (tokenised; the residue is the known debt) |
| Icons | Unicode glyphs (`☰ ✕ ⌨ ✈ ▾ ∗`) | inline SVG, `stroke: currentColor` |

Good news: the component vocabulary has already converged. `NavToolbar`,
`FilterPanel`, `LayerOptions`, `TrailsMenu`, `FlightTagsMenu`, `AirspaceMenu`,
`AirwayMenu`, `SimControls`, `AltitudeProfile` and `MapOverlay` all have direct
counterparts in flight-anim. This is a restyling job with a handful of
structural moves, not a rebuild.

---

## 2. Design identity

A dark, instrument-grade console that sits quietly behind a map. The map is the
product; chrome is a thin translucent instrument surface floating over it.
Deliberately not a consumer flight-tracking site and not a light "Apple.com"
page — the approved direction is "Apple polish, dark".

Five rules carry most of the identity:

1. **The map owns the viewport.** Chrome floats over it.
2. **Surfaces are translucent and blurred**, separated by hairlines rather than
   heavy borders or drop shadows.
3. **One accent colour only.** Interactive, active and selected are all the
   same cyan. No second brand colour.
4. **Hierarchy comes from weight, case and colour — not size.** Inside a panel
   every label is the same size.
5. **Controls are ghost by default.** Nothing is filled until it is active.

---

## 3. Token migration — do this first

The simulator has six tokens and 858 raw hex values. Everything else in this
guide depends on the token set existing, so this is step one.

### 3.1 Direct remap of the existing six

| Existing | Existing value | Replace with | New value |
|---|---|---|---|
| `--bg` | `#0f172a` | `--bg-chrome` | `#0a0e14` |
| `--panel` | `#1e293b` | `--bg-elevated` | `#161c27` |
| `--text` | `#e2e8f0` | `--text` | `#f2f5f9` |
| `--muted` | `#94a3b8` | `--text-dim` | `#8b98a9` |
| `--accent` | `#38bdf8` | `--accent` | `#22d3ee` |
| `--sidebar-w` | `460px` | keep, see §5.1 | `460px` → `380px` |

Keep the old names as aliases for one commit so the change lands without
touching all 528 existing `var()` call sites at once:

```css
--bg: var(--bg-chrome);
--panel: var(--bg-elevated);
--muted: var(--text-dim);
```

Then remove the aliases in a follow-up.

### 3.2 The missing tokens

Four raw values account for most of the 858 occurrences and each is a token
that does not exist yet. Introduce these and sweep:

| Raw value | Occurrences | Token to introduce |
|---|---|---|
| `#334155` (plus `88`/`66`/`44` alpha suffixes) | ~147 | `--border` / `--hairline` |
| `#cbd5e1` | 40 | `--text` at reduced emphasis, or `--text-dim` |
| `#0f172a` | 38 | `--bg-chrome` |
| `#06283d` | 33 | `--accent-soft` |
| `#fbbf24` | 29 | `--warn` |
| `#22c55e` / `#34d399` | 43 | `--live` |
| `#f87171` / `#fca5a5` | 33 | `--danger` |

### 3.3 The full token block

Paste this into the top of `app/globals.css`, after the Leaflet import.

```css
:root {
  /* Safe-area insets — non-zero only on notched devices / standalone PWA.
     Requires viewport-fit=cover in the viewport meta. Desktop: all 0px. */
  --safe-top: env(safe-area-inset-top, 0px);
  --safe-right: env(safe-area-inset-right, 0px);
  --safe-bottom: env(safe-area-inset-bottom, 0px);
  --safe-left: env(safe-area-inset-left, 0px);

  /* Type — one system sans stack for the entire UI. No monospace anywhere. */
  --font-ui: ui-sans-serif, system-ui, -apple-system, 'SF Pro Text',
             'Segoe UI', Roboto, Helvetica, Arial, sans-serif;

  /* Surfaces */
  --bg-chrome: #0a0e14;          /* toolbar / panel base            */
  --bg-elevated: #161c27;        /* buttons, chips                  */
  --bg-elevated-hover: #1e2533;  /* hover lift                      */
  --bg-sunken: #06090e;          /* timeline track, insets          */

  /* Lines */
  --border: #222c3b;             /* hairline                        */
  --border-strong: #303c4e;      /* emphasised edges                */

  /* Materials — translucent panel surfaces */
  --material: rgba(21, 27, 38, 0.68);
  --material-strong: rgba(21, 27, 38, 0.85);
  --hairline: rgba(255, 255, 255, 0.08);
  --blur: blur(24px) saturate(1.5);

  /* Text */
  --text: #f2f5f9;               /* primary                         */
  --text-dim: #8b98a9;           /* labels                          */
  --text-faint: #586677;         /* captions, inactive              */

  /* Signal colours */
  --accent: #22d3ee;             /* cyan — interactive / active     */
  --accent-press: #11b6d6;
  --accent-soft: rgba(34, 211, 238, 0.14);
  --live: #2fd968;               /* running / connected / go        */
  --warn: #ffb020;               /* paused / caution                */
  --danger: #ff5c6e;             /* stopped / disconnect / alert    */

  /* Geometry */
  --radius: 10px;
  --radius-sm: 8px;
  --radius-lg: 16px;

  /* Micro-label treatment shared by instrument keys */
  --label-tracking: 0.6px;
}

/* Native controls must follow the accent so no system blue leaks in.
   The simulator already does this on .sim-scrub; make it global. */
input[type="checkbox"],
input[type="radio"],
input[type="range"],
progress { accent-color: var(--accent); }
```

The existing CD&R tokens (`--cdr-los`, `--cdr-mtcd`, `--cdr-stca`) stay — they
are semantic alert colours, not brand colours. Re-point them at `--danger`,
`--warn` and `--accent` respectively so they participate in the one palette.

---

## 4. Typography

There is no type scale in the usual sense. Four sizes, assigned by *structural
role*, not by importance:

| Role | Size | Weight | Case |
|---|---|---|---|
| Toolbar buttons (`.tool-label`) | 13px | 500 | Sentence case |
| Panel / dropdown body — every label, option, select, input | 11px | 400–500 | Sentence case |
| Group headings inside panels | 10–11px | 600 | UPPERCASE, `letter-spacing: .06em` |
| Segmented-control buttons | 11px | 600 | UPPERCASE, `letter-spacing: var(--label-tracking)` |
| Micro-captions (stat keys, ribbon labels) | 9–10px | 500 | UPPERCASE, `letter-spacing: .07em` |

Rules:

- **One family everywhere** (`--font-ui`). No monospace, including numeric
  read-outs. Use `font-variant-numeric: tabular-nums` where columns of numbers
  must align — this matters for `.sim-time`, `.sim-alt` and the trajectory
  summary tables, which currently jitter as digits change.
- **Everything that opens underneath a toolbar button shares one size (11px).**
  In the simulator that is `FilterPanel`, `LayerOptions`, `TrailsMenu`,
  `FlightTagsMenu`, `AirspaceMenu`, `AirwayMenu` and the `.tm-menu` route
  picker. Deviating from this is the fastest way to stop looking like one
  system.
- Structural chrome is exempt: close controls and numeric value read-outs
  (opacity percentages, counts) keep their own size.
- The sidebar `h1` at 18px/800 is the one legitimate large element. Everything
  else in the sidebar steps down to the panel scale.

---

## 5. Layout

### 5.1 The sidebar stays, but narrows and lightens

The simulator's two-zone layout (`.app` = `.sidebar` + map) is correct for a
tool whose primary job is *building* flight plans — flight-anim loads a dataset
and then gets out of the way, which is why it has no sidebar. **Do not convert
the simulator to flight-anim's floating-only chrome.** Keep the sidebar.

Three changes:

- **460px → 380px.** 460px is wider than the content needs and eats the map at
  1280px. flight-anim's docked panels are 280px; 380px is the compromise that
  keeps the generator form comfortable.
- **Give it the panel material**, not a flat fill:
  `background: var(--material-strong)`, `backdrop-filter: var(--blur)`,
  `border-right: 1px solid var(--hairline)`.
- **Collapsible on desktop, not only on mobile.** The `.sidebar-close` control
  already exists but is `display: none` above the mobile breakpoint. Show it
  everywhere and let the map go full-bleed — this is the single highest-value
  change for a user watching a simulation run.

### 5.2 z-index ladder

The simulator currently uses `z-index: 1000` for both `.sim` and several
overlays, which is why menus and the playback bar occasionally collide. Adopt
these bands:

| Band | Contents |
|---|---|
| 0 | Map and map panes |
| 999–1002 | Sidebar, playback bar, docked panels |
| 1500 | Corner controls: zoom stack, base-map/theme controls |
| 1600 | Slide-over panels (`LayerOptions`, `FilterPanel`) |
| 2000–2200 | Dropdowns and menus portalled to `<body>` |
| 9999–10000 | Modals (`DownloadModal`), toasts, blocking banners |

All edge offsets become `calc(Npx + var(--safe-*))`.

---

## 6. Component patterns

Mapped to the Figma brief's region letters.

### 6.1 Floating tool menu — brief region B (`NavToolbar`)

```css
.nav-toolbar {
  background: var(--material);
  -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  display: flex; align-items: center; gap: 8px;
  padding: 0 14px;
}
.nav-toolbar button {
  background: none; color: var(--text-dim);
  border: 1px solid transparent; padding: 8px 13px;
  border-radius: var(--radius-sm);
  font: 500 13px var(--font-ui);
  white-space: nowrap; flex-shrink: 0; cursor: pointer;
  transition: color .15s, background .15s, border-color .15s;
}
.nav-toolbar button:hover  { background: rgba(255,255,255,0.06); color: var(--text); }
.nav-toolbar button.active { background: rgba(255,255,255,0.10); color: var(--text); }
.nav-toolbar button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
```

**Replace the Unicode glyph icons with inline SVG.** `☰ ✕ ⌨ ✈ ▾ ∗` render at
different weights and baselines on every platform, and they cannot inherit
colour cleanly. Use inline SVG with `stroke: currentColor`, `strokeWidth 2.2`,
`strokeLinecap="round"`, so the icon dims and brightens with its button. This
applies to `.tool-ico`, `.tool-caret`, `.caret`, `.ov-hamburger` and
`.sim-route-tag.all`.

`.tool-count` becomes the badge pattern: `--accent-soft` fill, `--accent` text,
10px/700, `border-radius: 8px`, `padding: 1px 6px`.

### 6.2 Map controls — brief region C (`MapOverlay`)

`.ov-chip` is already close to the right idea. Make it ghost rather than
filled, and move the base-map and theme choice into a segmented control
anchored bottom-right (see §6.3). `.ov-zoom` becomes a vertical stack at
`z-index: 1500`, and **it must step aside when a panel opens on the same
edge** — translate it, do not change its `right` inset, because inside a
Leaflet container the inset is resolved by the map and overriding `right` has
no effect.

### 6.3 Segmented control — the one-of-N pattern

**Every mutually exclusive choice uses this one class.** In the simulator that
is: base map (`streets | satellite | dark`), theme (`dark | light`), playback
speed (see §6.5), and any future units or source switch.

```css
.theme-buttons {
  display: flex; gap: 2px; padding: 4px;
  background: var(--bg-chrome);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 6px 20px rgba(0,0,0,0.45);   /* only when floating over the map */
}
.theme-buttons button {
  background: transparent; border: none; color: var(--text-dim);
  font: 600 11px var(--font-ui);
  letter-spacing: var(--label-tracking); text-transform: uppercase;
  padding: 6px 12px; border-radius: var(--radius-sm); cursor: pointer;
  transition: color .15s, background .15s;
}
.theme-buttons button:hover  { background: var(--bg-elevated-hover); color: var(--text); }
.theme-buttons button.active { background: var(--accent-soft); color: var(--accent); }
.theme-buttons button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
```

Two traps, both learned the hard way in flight-anim:

1. An id-scoped rule such as `#panel button.active { background: … }`
   **outranks** `.theme-buttons button.active`, and the control silently
   renders a flat fill instead of the soft accent one. Any override must carry
   the same id. The simulator's `.ov-chip.active` and `.sim-speed-pop .active`
   rules are the equivalent hazard here.
2. Drop the lift shadow when the control sits inside an already-elevated
   panel; it only muddies the panel edge.

A two-value choice does not earn a disclosure chevron — put it inline.

### 6.4 Panels — brief regions D and I (`GeneratorPanel`, `LayerOptions`, `FilterPanel`)

```css
.panel {
  position: fixed;
  top: calc(100px + var(--safe-top));
  right: calc(10px + var(--safe-right));
  width: 280px; height: 600px; max-height: calc(100vh - 120px);
  background: var(--material-strong);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-lg);
  box-shadow: 0 16px 48px rgba(0,0,0,0.4);
  -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur);
  display: none; flex-direction: column; overflow: hidden;
  z-index: 1600;
}
.panel.visible { display: flex; }
```

- **280px is the standard dock width.** The generator form stays in the
  380px sidebar; `LayerOptions` and `FilterPanel` become 280px slide-overs.
- Filtering docks **left**; layers and detail dock **right**. One panel per
  edge at a time — opening one closes its sibling.
- Slide-in is `transform: translateX(300px) → 0` plus opacity, 0.15s ease-out,
  with `pointer-events: none` while closed.
- `LayerOptions` is tabbed today. Tabs are fine; style them as the segmented
  control, and normalise every label inside to 11px.

### 6.5 Layer row — the panel workhorse

Applies to `LayerOptions`, `AirspaceMenu`, `AirwayMenu`, `TrailsMenu`,
`FlightTagsMenu`.

```css
.layer-group-title {          /* quiet caption, must not compete with controls */
  padding: 10px 12px 4px;
  font: 600 10px var(--font-ui);
  letter-spacing: .06em; text-transform: uppercase;
  color: var(--text-dim); background: var(--bg-chrome);
  border-top: 1px solid var(--border);
}
.layer-group:first-child .layer-group-title { border-top: none; }

.layer-row { border-bottom: 1px solid var(--border); }
.layer-row-head {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px; background: var(--bg-chrome);
}
.layer-row-toggle {
  display: flex; align-items: center; gap: 6px; flex: 1;
  cursor: pointer; user-select: none;
  color: var(--text); font: 500 13px var(--font-ui);
}
.layer-row-toggle input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--accent); }
.layer-row-badge {
  color: var(--text-faint); font-size: 11px; padding: 2px 6px;
  background: var(--bg-elevated); border-radius: var(--radius-sm); flex-shrink: 0;
}

/* Nested sub-row: a vertical rule carries the grouping. Indentation alone
   reads as a stray margin once the parent scrolls out of view. */
.layer-row-nested > .layer-row-head { padding-left: 30px; position: relative; }
.layer-row-nested > .layer-row-head::before {
  content: ''; position: absolute; left: 16px; top: 0; bottom: 0;
  border-left: 1px solid var(--border);
}
```

Each group heading should answer one operational question, and every row in it
should be an answer to that question.

### 6.6 Playback bar — brief region G (`SimControls`)

This is the region that differs most, and it matters most for a simulator.

Current: a floating bottom-centre pill (`.sim`) with a native
`<input type="range">` scrubber 220px wide, two `mm:ss` labels, and a speed
**dropdown** reading `x1 ▾`.

Target:

- **Keep the floating bottom-centre placement.** It suits a tool where the map
  is the workspace; flight-anim's full-width top timeline belongs to a replay
  app. Restyle the pill with `--material-strong`, `--blur`, a `--hairline`
  border and `--radius-lg`.
- **Replace the native range input with the custom scrubber.** A native range
  cannot carry a progress fill, a hover-time bubble, or event marks, all of
  which a simulator needs:

```css
.sim-bar {
  position: relative; flex: 1; min-width: 220px; height: 6px;
  background: var(--bg-sunken); border: 1px solid var(--border);
  border-radius: 3px; cursor: pointer;
}
/* Invisible hit-area extension: the visible bar is 6px, the whole 24px row
   catches clicks and hover. */
.sim-bar::before { content: ''; position: absolute; left: 0; right: 0; top: -9px; bottom: -9px; }
.sim-bar:hover { background: var(--bg-elevated); border-color: var(--border-strong); }
.sim-progress { position: absolute; left: 0; top: 0; height: 100%;
  background: linear-gradient(90deg, var(--accent-press), var(--accent));
  border-radius: 3px; pointer-events: none; }
.sim-handle {
  position: absolute; top: 50%; width: 14px; height: 14px;
  background: #fff; border-radius: 50%; transform: translate(-50%, -50%);
  cursor: grab; box-shadow: 0 0 4px rgba(0,0,0,0.5); z-index: 10;
}
.sim-handle:active { cursor: grabbing; transform: translate(-50%,-50%) scale(1.2); }
.sim-bar:hover .sim-handle { transform: translate(-50%,-50%) scale(1.15); box-shadow: 0 0 6px var(--accent); }
```

  Keep `aria-label="Timeline"` and full keyboard operation — if the native
  input is replaced, the custom control must handle arrow keys, Home and End.
- **Replace the speed dropdown with a segmented control.** `x1 … x200` is a
  one-of-N choice and it is the control a user reaches for most during a run;
  burying it behind a popup costs two interactions every time. If the full
  preset list is too wide, show `x1 x2 x4 x8` inline and keep the rest behind
  a "more" affordance — but the common values must be one click.
- **Encode run state in the chrome, not only in the data.** Use `--live` for
  running, `--warn` for paused, `--danger` for stopped or disconnected.
  `.sim-live` already exists with `aria-live="polite"`; give it a coloured dot
  plus a word, so state does not rely on colour alone.
- Mark conflict and separation events on the scrubber as 2px ticks with an 8px
  dot head, coloured by severity. The departure-separation and
  arrival-sequencing work in `7f76114` produces exactly the events that belong
  there.

### 6.7 Route detail — brief region H (`RouteResultTabs`, `AltitudeProfile`)

Order the detail view as:

1. **Hero line** — callsign at 18–20px/600 with a dim sub-line (type,
   departure/destination).
2. **Route progress** — origin and destination at 14px/600 with a 2px progress
   bar between them and times at 10px underneath.
3. **The altitude profile** as a phase-coloured ribbon roughly 60px tall, with
   a playhead synchronised to `useSimPlayback`. `AltitudeProfile` already
   computes the data; this is a restyle plus a playhead.
4. **A four-up stat grid** (`grid-template-columns: repeat(4, 1fr)`): 9px
   uppercase key over a 12px tabular-nums value.
5. **One primary action**, rendered as a soft accent fill
   (`background: var(--accent-soft); color: var(--accent)`), not a solid button.

### 6.8 Modal — brief region J (`DownloadModal`)

Modals keep `--material-strong` and `--blur`, sit at `z-index: 9999`, and use
a scrim of `rgba(0,0,0,0.5)`. The measurable download progress added in
`a01f6c6` should use `--accent` on a `--bg-sunken` track, matching the
scrubber's progress treatment rather than inventing a second bar style.

---

## 7. Map and symbology

### 7.1 Resolve theme and base map into one value

This is the most consequential structural finding. The simulator keeps **two
independent axes** — `Theme = dark | light` and
`Basemap = streets | satellite | dark` — which is six combinations, and
`LeafletMap.tsx` references neither when choosing overlay colours. Overlay
geometry is therefore drawn in fixed colours over a white Google-style roadmap,
over dark Esri imagery, and over the CARTO dark canvas alike.

flight-anim hit exactly this and solved it by resolving to a single value that
every layer palette reads:

```ts
export type Basemap = 'dark' | 'light' | 'satellite' | 'street';

export function resolveBasemap(f: {lightMode: boolean; satelliteMode: boolean; streetMode: boolean}): Basemap {
  if (f.satelliteMode) return 'satellite';
  if (f.streetMode)    return 'street';
  if (f.lightMode)     return 'light';
  return 'dark';
}

export function isBrightBasemap(b: Basemap) { return b === 'light' || b === 'street'; }
```

For the simulator, collapse the two axes into one four-way choice presented as
a single segmented control — `DARK | LIGHT | STREET | SATELLITE` — and derive
the document theme class from it. Then keep **one palette per base map**, with
contrast measured against each base map's own background:

| Base map | Background | Line treatment |
|---|---|---|
| dark | near-black canvas | light grey lines |
| light | pale land fill | dark lines |
| street | white and already busy | darkest lines plus white halo |
| satellite | dark, textured imagery | near-white lines plus dark halo |

Satellite is bright in places and near-black in others, so it needs its own
palette and must **not** be folded in with light. The keyless CARTO fallback
added in `241caa0` makes the dark case reliable; this makes the other three
legible.

### 7.2 Line-weight hierarchy

Reference geometry is ranked by weight so the picture reads at a glance. In
flight-anim: outer FIR boundary 2.5 > ACC and TMA 1.8 > sector and CTR 1.0,
with restricted areas at 1.2 drawn red in every mode. The simulator's airspace
hierarchy (`lib/airspace.ts`, sectors added in `b40b36b`) should adopt the same
ladder in a constants module. Never set a weight inline.

Procedure geometry — the AIXM 2608 terminal procedures from `a01f6c6` — stays
one step quieter than route geometry, because it is reference material drawn
*under* the traffic.

### 7.3 Labels

- **Gate labels by zoom.** One table of minimum zooms per label type (FIR 5,
  ACC 6, TMA and airways 7, CTR and waypoints 8). Compute the gate boolean
  *before* the render effects so layers rebuild only when it flips, not on
  every zoom tick.
- Labels are chart-style: **transparent background plus a halo text-shadow**,
  never a filled box. Give each label the colour of the boundary it belongs to.
- Area labels read better on the **inner boundary** than at the centroid, and
  nested areas must use opposite edges (TMA north, CTR south) to avoid
  collisions.

### 7.4 Target symbol and data block

The simulator animates generated trajectories, so it should offer both symbol
modes:

- **Pictorial** — a rotating aircraft icon coloured by flight phase.
- **Console** — a non-rotating hollow square with an in-icon velocity vector
  whose length is ground speed × a selectable lookahead (0/1/2/3/6/9 minutes),
  plus history dots at fixed time epochs behind the target. Draw the history
  dots on **one** canvas overlay that redraws only on epoch change, movement or
  filter change — not one Leaflet layer per target.

`FlightTagsMenu` already exists, so the data block is three lines with each
slot independently switchable:

```
line 1   CALLSIGN(700)  TYPE  REG  HEX
line 2   FL350↑         CFL   S360            (assigned/selected level slots)
line 3   A7421  IAS  GS  M.82  HDG°  ±ROC
```

Fixed-width zero-padded numerics (`035`, `---` when unknown), callsign at
weight 700 and everything else lighter, the block transparent with no border,
and font size stepped by zoom (6px at zoom ≤5 rising to 9px at zoom ≥10).

Note for the simulator specifically: the upstream engine contract asks for
`cas_kt` per point (item 8) precisely because there is no IAS equivalent today
— until that lands, the IAS slot must render `---`, not an empty gap.

### 7.5 Separation and conflict cues

Measurement and separation lines are weight 1 in neutral grey (`#b8bcc2` dark
/ `#6b7076` light); only the *value* changes colour. A separation read-out
below minimum turns `--warn` and marks the predicted closest point of
approach. Reserve `--danger` for stop/disconnect actions and true alerts.

This keeps the map calm until something is actually wrong — which matters more
in a simulator than in a replay tool, because conflicts are routine training
events rather than exceptions. The CD&R subtree's existing
LOS/MTCD/STCA distinction maps cleanly onto danger/warn/accent.

---

## 8. Light mode

The simulator has **95 `.app.theme-light` rules**, each overriding a specific
component selector. flight-anim has the same debt and it is the single largest
source of its visual regressions: every new component needs a matching
light-mode override, and the ones that get forgotten render dark-on-light.

**Do not extend that pattern.** Put every colour behind a token and redefine
only the tokens:

```css
.app.theme-light {
  --bg-chrome: #f5f7fa;
  --bg-elevated: #ffffff;
  --bg-elevated-hover: #eef1f5;
  --bg-sunken: #f3f4f6;
  --border: #e5e7eb;
  --border-strong: #d1d5db;
  --material: rgba(255, 255, 255, 0.72);
  --material-strong: rgba(255, 255, 255, 0.90);
  --hairline: rgba(0, 0, 0, 0.10);
  --text: #111827;
  --text-dim: #6b7280;
  --text-faint: #9ca3af;
  --accent: #4f46e5;
  --accent-press: #4338ca;
  --accent-soft: rgba(79, 70, 229, 0.10);
}
```

Then delete the 95 per-selector rules as each component is tokenised. Map
background is `#0a0e17` on dark and `#dde5ec` on light — the background *is*
the water when only coastline polygons are drawn.

**Target: zero light-mode rules that name a component selector.**

---

## 9. Responsive and touch

Breakpoints: **1440px** (tighten toolbar spacing so no control is pushed
off-screen), **1024px**, **768px**, **480px** (sidebar and panels become
full-width bottom sheets or a drawer), plus
`@media (hover: none) and (pointer: coarse)` for touch.

The Figma brief already requires the sidebar to become a hamburger drawer on
small screens and floating menus to collapse — that stays. Add: enlarge hit
areas rather than visible controls (the scrubber's invisible `::before` is the
pattern), and give every hover-only affordance a tap path.

---

## 10. Accessibility

- Every control carries `title` and, where it is icon-only, `aria-label`. The
  simulator is largely good here already (`aria-label="Timeline"`,
  `role="listbox"`, `aria-selected`, `aria-live="polite"`); keep that standard
  as controls are restyled.
- `:focus-visible` is always `2px solid var(--accent)` at `2px` offset. Never
  remove the outline.
- Colour is never the only channel: run state pairs a coloured dot with a word;
  a conflict shows a mark as well as a colour; an active control changes
  background as well as text colour.
- If a native `<input type="range">` is replaced with a custom scrubber,
  keyboard operation must be reimplemented — arrow keys, Home, End, and a
  focus ring. This is a regression risk, not a nice-to-have.

---

## 11. Motion

Short and functional. No decorative animation.

| Interaction | Transition |
|---|---|
| Button colour/background | 0.15s |
| Panel slide-over | 0.15s ease-out on transform and opacity |
| Panel re-anchor when chrome hides | 0.4s `cubic-bezier(.4,0,.2,1)` |
| Corner control step-aside | 0.18s ease |
| Screen entry | 0.2s ease-out fade with 8px upward translate |

Marker positions must **not** carry a CSS transition — set
`transition: none !important` on marker contents, or playback interpolation
fights the animation frame loop. This bites hardest at high simulation rates.

---

## 12. Implementation traps

1. **Portal every dropdown.** If a toolbar is given `overflow-x: auto` for
   narrow windows, in-toolbar dropdowns are clipped with no visible error.
   Render `.tm-menu`, `.sim-speed-pop` and `.sim-route-menu` into
   `document.body` with a clamped fixed position.
2. **Id-scoped rules beat class-scoped ones.** One `#panel button.active` rule
   silently breaks every shared control nested inside. Prefer class scoping; if
   an id rule exists, overrides must carry the same id.
3. **Corner controls step aside, not get buried.** Translate them; changing
   `right` inside a Leaflet container has no effect.
4. **Delete dead classes as you go.** A class referenced from JSX with no CSS
   rule renders as an OS-default control on a dark panel — that is how a
   white-and-blue button appears mid-console.
5. **Compute derived booleans before effects run** (zoom gates, resolved base
   map) so layers rebuild only when the boolean flips.
6. **One canvas overlay for repeated per-target decoration**, not one layer per
   target.
7. **`NEXT_PUBLIC_*` is inlined at build time.** Anything theme- or
   basemap-related driven by env (the CARTO key) cannot be changed at runtime;
   do not build a runtime theme switch on top of one.

---

## 13. Suggested order of work

Each step is independently shippable and leaves the app working.

1. Token block in, six existing tokens aliased (§3.1, §3.3).
2. Sweep the four highest-count raw values to tokens (§3.2).
3. Typography normalisation — one family, the role table (§4).
4. Segmented control introduced; base map and theme collapsed into one
   four-way choice (§6.3, §7.1).
5. Toolbar and chip restyle; Unicode glyphs replaced with SVG (§6.1, §6.2).
6. Panel material and 280px dock geometry; sidebar to 380px and collapsible on
   desktop (§5.1, §6.4, §6.5).
7. Playback bar: custom scrubber, speed as segmented control, run-state colour
   (§6.6). Keyboard parity verified.
8. Light mode tokenised; per-selector rules deleted as each component lands
   (§8).
9. Per-basemap layer palettes and zoom-gated halo labels (§7.2, §7.3).
10. Symbol modes and the three-line data block (§7.4).

Steps 1–3 are mechanical and can go in one pull request. Step 7 carries the
accessibility regression risk. Step 9 is the largest visual payoff.

---

## 14. Review checklist

- [ ] No raw hex in `globals.css` outside the `:root` blocks.
- [ ] Every label inside a panel or dropdown is 11px in `--font-ui`.
- [ ] Every one-of-N control uses `.theme-buttons`.
- [ ] Panels are 280px, docked left for filtering and right for everything
      else, mutually exclusive per edge; sidebar is 380px and collapsible.
- [ ] All edge offsets use `calc(Npx + var(--safe-*))`.
- [ ] Base map resolves through one resolver; layer palettes key on the
      resolved value.
- [ ] Labels are halo text on transparent backgrounds, gated by zoom.
- [ ] Every control has `title`; icon-only controls have `aria-label`;
      `:focus-visible` shows the accent outline; the scrubber is keyboard
      operable.
- [ ] Checked in dark, light, street and satellite, at 1440, 1024, 768, 480px.
- [ ] Running, paused and stopped simulation states are visually distinct.
- [ ] Every control in `FIGMA_REDESIGN_PROMPT.md` Section 4 regions A–K is
      still present and reachable.

---

## 15. References

**Reference implementation** — `~/cat-data-analytics/flight-animation-main`:
`src/index.css` (all chrome), `src/theme/basemap.ts` and
`src/theme/layerColors.ts` (map palettes), `src/App.tsx` (shell),
`src/components/LayersPanel.tsx` and `FlightTagsLayer.tsx` (panel and data
block). Built to `dist-historical` / `dist-live`, served on `:5173` / `:5174`.

**Target** — `~/dev/atc-fts/web` at `241caa0`: `app/globals.css`,
`components/` (`NavToolbar`, `MapOverlay`, `SimControls`, `LayerOptions`,
`FilterPanel`, `LeafletMap`, `MapApp`, `AltitudeProfile`, `DownloadModal`),
`lib/mapPrefs.ts`, `lib/airspace.ts`, `lib/useSimPlayback.ts`.

**Functional contract** — `FIGMA_REDESIGN_PROMPT.md` in the simulator repo,
Section 4 regions A–K.

**Working discipline** — the clone is pull-only (`git pull --ff-only` refuses
if local commits exist). Contribute by pushing a branch to the fork
`pabhakara/ATC-Fast-Time-Simulation-Tool-Trajectory-Generator` (remote `fork`)
and opening a cross-repo pull request against `Supapich6511794:main`.
