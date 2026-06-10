# Figma AI Redesign Prompt — Flight Trajectory Generator

> Copy everything below into Figma AI (Make / First Draft). It describes the product,
> every screen region, the end-to-end user workflow, and the **complete list of UI
> functions that must be preserved**. The goal is a fresh visual design that keeps
> **100% of the existing functionality and controls** — nothing removed, nothing hidden
> that was visible, every interaction still reachable.

---

## 1. Product in one line

A single-page web app for ATC fast-time simulation: a user builds one or many flight
plans (callsign, aircraft type, departure/destination, route), generates 4D trajectories
on a server, then **visualizes them on an interactive map with an animated aircraft
playback**, inspects vertical/altitude profiles and stats, and downloads the data in
several geospatial formats.

**Layout:** a left **sidebar panel** (forms + results) over a **full-bleed interactive map**.
Floating toolbars and controls sit on top of the map. Dark theme by default, with a
light theme toggle.

---

## 2. Design intent for the redesign

- Keep the **two-zone layout**: collapsible left sidebar + full-screen map canvas.
- Modern, clean, data-dense but uncluttered. Aviation/ATC feel (dark map, neon route
  lines, altitude color gradient).
- **Do not remove or merge away any control listed in Section 4.** Every button,
  toggle, dropdown, input, tab, search box, chip, slider, and menu item must still exist
  and be reachable. You may restyle, regroup, or improve their placement — but never drop
  a function.
- Must stay **responsive**: on small screens the sidebar becomes a drawer (hamburger),
  floating menus collapse behind a ☰ button.
- Preserve all states: empty, loading, error, results, and the in-progress “preview”.

---

## 3. End-to-end user workflow (the function flow)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 0 · App loads                                                           │
│  - Map fills the screen (airway network shown by default).                    │
│  - Floating top-left tool menu: Generator · Route Profile ▾ · Download.       │
│  - Floating top-right map controls: Layers · Basemap · Theme · Zoom +/−.      │
│  - Sidebar hidden until a tool is opened.                                      │
└─────────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 1 · Build flight plan(s)  → "Generator" panel (left sidebar)            │
│  Multi-plan tab strip at top (Plan 1, Plan 2 … +). Stat pills: Plans /        │
│  Routes / Airports counts, plus "▶ Generate all" (batch).                     │
│  Per plan, fill in:                                                            │
│    • Callsign (text)            • Aircraft type (dropdown, ~18 ICAO types)     │
│    • ADEP (departure combobox)  • ADES (destination combobox)                 │
│    • EOBT (datetime-local)      • RFL (number)   • GS kt (number)             │
│    • Route (Item-15) via 2 modes: "Type" string OR "Pick waypoints" builder   │
│         - Best-routes ranker: suggested routes ranked shortest-first, each     │
│           tagged with distance, ~minutes, PASS/FAIL vs reference time.         │
│         - "+ Add route (n/max)" to queue several routes; queued list with ✕.   │
│    • SID dropdown (at ADEP) · STAR dropdown (at ADES)                          │
│    • Live "PREVIEW FPL STRING" readout.                                        │
│  Bulk import: drag & drop CSV/JSON to fan out many flights into tabs.          │
│  Footer: hint (ADEP→ADES) · "⧉ Duplicate" · "▶ Generate this plan".           │
│  Live faint route preview lines drawn on the map as the user types/picks.     │
└─────────────────────────────────────────────────────────────────────────────┘
                                   │  (Generate)
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 2 · Results appear                                                      │
│  - Trajectory lines drawn on the map (color by altitude).                      │
│  - Auto-switch to "Route Profile / All routes" view in the sidebar.           │
│  - Header status "N / M flights ready". Warnings/errors listed if any.         │
│  - Two-scope search over results: 1·Flight (callsign/ADEP-ADES) 2·Route.      │
└─────────────────────────────────────────────────────────────────────────────┘
                                   │
                 ┌─────────────────┼──────────────────┐
                 ▼                 ▼                  ▼
┌────────────────────┐ ┌────────────────────┐ ┌────────────────────────────────┐
│ STEP 3a · Inspect  │ │ STEP 3b · Animate  │ │ STEP 3c · Manage map layers     │
│ Route Profile menu │ │ Sim playback bar   │ │ Layers panel / Layer Options    │
│ • All routes:      │ │ (bottom of map):   │ │ • Airway network, Waypoints, FIR│
│   Overview /       │ │ play/pause/reset,  │ │ • Airports (per-airport toggle),│
│   Vertical / Summ. │ │ scrubber, time,    │ │   Runways, Gates                │
│ • Per route R1,R2: │ │ speed x1…x100,     │ │ • SID / STAR / PBN / ILS proc   │
│   Vertical profile │ │ live ALT/SPD/phase,│ │   layers (filter by airport &   │
│   (altitude chart),│ │ route source picker│ │   procedure, opacity, thickness)│
│   Trajectory summ. │ │ (R1/R2/All), hide  │ │ • Click a SID/STAR on the map → │
│   (stats + CAT62   │ │ route lines toggle.│ │   procedure inspector (legs +   │
│   PASS/FAIL check).│ │ Spacebar = play.   │ │   altitude/speed constraints).  │
│ Remove route ✕.    │ │                    │ │ • Aircraft-type filter (top).   │
│                    │ │                    │ │ • Flight Tags menu (label fields)│
└────────────────────┘ └────────────────────┘ └────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 4 · Download  → "Download" opens a modal                                │
│  • Mode: Separate (one file per route) OR Combined (merge into one file).     │
│  • Route picker: typeahead + chips, "Select all" / "None", paste "R1,R2,R3".  │
│  • Format pills (multi-select): GeoPackage .gpkg · CSV · GeoJSON, All/None.    │
│  • Footer count "(n files)" + Download / Cancel.                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Complete UI inventory — every function that must survive the redesign

### A. Global shell
- **Left sidebar** with header title "Flight Trajectory Generator", a ready-status badge,
  and a ✕ close button. Collapsible; becomes a drawer on mobile with a backdrop.
- **Breadcrumb** ("Generator › R1 · Vertical profile") when viewing a result.
- **Full-screen map canvas** behind everything.

### B. Floating top-left tool menu (NavToolbar)
- **Generator** button (opens the plan form).
- **Route Profile ▾** — disabled until a trajectory exists; shows a count badge.
  Cascading menu:
  - All routes → **Overview** (vertical + summary), **Vertical profile**, **Trajectory summary**.
  - Per-route list R1, R2… each expanding to: route string, **Vertical profile**, **Trajectory summary**.
- **Download** button (opens the download modal; disabled until results exist).
- Mobile: collapses behind a ☰ hamburger with a count badge.

### C. Floating top-right map controls (MapOverlay)
- **🗂 Layers** popover: checkboxes for Airway network, Waypoints, FIR (with "loading…"),
  and "⚙ More Layer Options".
- **Basemap** selector: Dark / Streets / Satellite.
- **Theme** toggle: ☀ Light / 🌙 Dark.
- **Zoom** + / − buttons.
- Mobile sidebar hamburger.

### D. Generator panel (the core form)
- **Stat pills**: Plans, Routes, Airports counts.
- **▶ Generate all** (batch generation with live progress text like "Generating 80/242…").
- **Plan tab strip**: tabs per plan, ✕ to remove, **+** to add a plan.
- Inputs: **Callsign**, **Aircraft type** (dropdown), **ADEP** (combobox), **ADES**
  (combobox), **EOBT** (datetime), **RFL** (number), **GS kt** (number).
- **Route section** with mode tabs **Type** / **Pick waypoints**:
  - Type mode: route string input + **Best routes** suggestion list (each clickable,
    showing distance · ~min · PASS/FAIL), "See more / See less".
  - Pick-waypoints mode: searchable waypoint builder (ordered selection).
  - **+ Add route (n/max)** queue with removable entries.
  - Hints for invalid/empty ADEP-ADES or no routing found.
- **SID** dropdown (at ADEP) and **STAR** dropdown (at ADES), with "None" options and
  "no coded procedure" hints.
- **PREVIEW FPL STRING** readout.
- **Drag & drop CSV/JSON bulk import** zone.
- Footer: pair hint, **⧉ Duplicate**, **▶ Generate this plan** (label changes for multi-route).
- **Error** banner + **warnings** list.
- **Results search**: 1·Flight and 2·Route comboboxes + "Showing X of Y routes".

### E. Live route preview (floating FAB on the map)
- **👁 Preview / Show preview** toggle.
- Scope buttons: **Full (n)** / **Current**.

### F. Map top-center bar (after results)
- **Flight Tags menu** — toggle which fields show on each aircraft label
  (callsign, FL, IAS, HDG).
- **Aircraft-type filter** search input with datalist, match count "X of Y", clear ✕.

### G. Simulation playback bar (bottom of map)
- **All-routes line visibility** master eye toggle.
- **Route source picker** (R1 / R2 / … / All routes) with per-route eye (hide on map).
- **Live readouts**: altitude (FL/ft), ground speed/TAS, climb/cruise/descent phase chip.
- **Play/Pause**, **Reset**, **time elapsed / total**, **scrubber** (draggable),
  **speed menu** (x1 real-time … x100). Spacebar toggles play/pause.

### H. Route result block (Vertical profile + Trajectory summary)
- Header with R-tag, flightKey, route string, **✕ remove**.
- Tab strip: **Vertical profile** / **Trajectory summary** (or stacked in overview).
- Vertical profile: **altitude chart** with a moving aircraft synced to playback; stats
  Cruise / Requested FL / TOC / TOD; optional speed schedule + per-phase breakdown.
- Trajectory summary: Waypoints / Points / Distance (NM) / Flight time (min);
  **CAT62 PASS/FAIL** check with Ref vs Sim and Δ; metadata (callsign, aircraft, ADEP→ADES).

### I. Layer Options panel (tabbed)
- Tabs: **Airports**, **SID**, **STAR** (PBN/ILS/Gates exist in code, currently hidden).
- Airports tab: per-airport visibility list, **Show all / Hide all**, **Runways** toggle, Gates toggle.
- SID/STAR tabs: **Routes** toggle, **Waypoints** toggle, **airport filter**,
  **procedure filter**, **opacity** slider, **thickness** slider, and a **direct lookup**
  form (airport → procedure → transition) that highlights it on the map.
- **Procedure inspector** (separate floating panel): leg list with path terminator, ident,
  and altitude/speed constraints; close ✕.

### J. Download modal
- **How to download**: Separate / Combined radio cards (with ⓘ tooltips).
- **Routes** picker: typeahead input, chips, Select all / None, batch paste, keyboard nav.
- **Formats** pills: GeoPackage .gpkg / CSV / GeoJSON, All / None.
- Footer: dynamic file count, **Cancel**, **⬇ Download (n)**.
- Closes on backdrop click, ✕, or Escape.

### K. Map-rendered elements (visual, keep affordances)
- Airway lines, waypoint markers, FIR boundary, airport/runway/gate markers,
  SID/STAR/PBN/ILS procedure tracks, generated trajectory polylines colored by altitude
  with an **altitude legend**, animated aircraft icons with tag labels, faint preview lines.
- Clickable procedure tracks open the inspector.

---

## 5. Hard constraints for Figma AI

1. **Preserve every control in Section 4** — restyle freely, but do not delete, disable,
   or bury any function that is currently reachable.
2. Keep the **sidebar + full-map** structure and all **floating overlays** (tool menu,
   map controls, preview FAB, top-center bar, playback bar, altitude legend).
3. Maintain **dark/light theming** and the **altitude color gradient** for routes.
4. Keep it **responsive** (drawer sidebar + hamburger menus on mobile).
5. Design all **states**: empty (no results), loading, error/warnings, results, and the
   live in-progress preview.
6. Aviation/ATC visual language: dark basemap, glowing route lines, clear data readouts,
   monospace for codes/idents where it helps legibility.

> Output: a redesigned, modern UI for this exact app with the same information
> architecture and the same complete set of functions — just a better look and feel.
```
