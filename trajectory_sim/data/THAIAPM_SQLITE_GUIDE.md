# Thai APM — aircraft performance SQLite (read-me & Claude briefing)

**Files in this package:** `thaiapm_bada.sqlite` + this guide.

You can hand this whole markdown to Claude as context before asking it to query
the database — it's written to be read by both you and the model. The
["Paste this to Claude"](#paste-this-to-claude-first) block at the bottom is the
quick-start.

---

## What this is

`thaiapm_bada.sqlite` is an **aircraft climb / cruise / descent performance
table** for 66 aircraft types. It answers questions like *"how fast does an
A320 climb through FL200?"*, *"what's a B738's true airspeed in cruise at
FL360?"*, *"how quickly does an A359 descend?"*.

It was built ("Thai APM") by fitting **real radar surveillance data** (Mode-S
downlinked airspeeds) from ~350 days of traffic in the Bangkok flight
information region, 2022–2026. It is laid out in the same shape as the
industry-standard **EUROCONTROL BADA** performance tables, so if your friend has
used BADA before, the columns will look familiar — but **read the "Five things
to get right" section below**, because two of the columns behave differently
than their names suggest.

It is **not** an official BADA / EUROCONTROL product, and it is **kinematic
only**: speeds and climb/descent rates, no fuel, no weight, no thrust.

---

## Five things to get right (please read — Claude especially)

1. **`rocd_lo` / `rocd_hi` are NOT simple low/high percentiles — they're
   inverted for climb.** These follow BADA's *mass-band* convention:
   - `rocd_lo` = **best/fastest** climb rate (a light aircraft) = the 75th
     percentile of observed rates
   - `rocd_nom` = typical (50th percentile)
   - `rocd_hi` = **worst/slowest** climb rate (a heavy aircraft) = the 25th
     percentile

   So numerically **`rocd_lo` > `rocd_nom` > `rocd_hi`** for climb. Do not read
   "lo" as "the low number." If you want the typical value, **use
   `rocd_nom`.**

2. **Units:**
   - `fl` = flight level = **hundreds of feet** (FL200 = 20,000 ft pressure altitude)
   - `tas` = true airspeed in **knots**
   - `rocd_*` = rate of climb/descent in **feet per minute**. Climb rates are
     positive. Descent `rocd_nom` is stored as a **positive magnitude** (a rate
     of descent), not a negative number.

3. **Which columns are populated depends on `phase`:**
   - `phase='climb'`   → `rocd_lo`, `rocd_nom`, `rocd_hi` all present
   - `phase='cruise'`  → all `rocd_*` are **NULL** (level flight); use `tas` only
   - `phase='descent'` → only `rocd_nom` present; `rocd_lo`/`rocd_hi` are NULL by design

4. **There is no fuel data.** The `fuel_lo`, `fuel_nom`, `fuel_hi` columns exist
   only for BADA layout compatibility and are **always NULL**. If a question
   needs fuel burn, weight, or thrust, this dataset cannot answer it — say so
   rather than guessing.

5. **These are Bangkok-region observed values (~ISA+15 warm conditions), not
   standard-atmosphere book figures.** They reflect how airlines *actually*
   flew there, including local ATC speed practices. Expect climb rates a bit
   below a manufacturer's ISA chart. This is a feature (it's real operational
   data), not an error. Treat the numbers as *representative*, not exact for
   any single flight.

---

## Table schema

One table, `thaiapm_performance`:

```sql
CREATE TABLE thaiapm_performance (
    actype     TEXT,      -- ICAO aircraft type designator, e.g. 'A320', 'B738'
    version    TEXT,      -- data vintage tag, e.g. 'thaiapm-202607'
    isa_offset INTEGER,   -- 15  (labels the ~ISA+15 Bangkok conditions; single value)
    phase      TEXT,      -- 'climb' | 'cruise' | 'descent'
    fl         INTEGER,   -- flight level (hundreds of feet)
    tas        REAL,      -- true airspeed, knots
    rocd_lo    REAL,      -- climb: p75 (fastest). see gotcha #1. NULL for cruise; NULL for descent
    rocd_nom   REAL,      -- typical rate, ft/min (the one to use by default)
    rocd_hi    REAL,      -- climb: p25 (slowest). NULL for cruise; NULL for descent
    fuel_lo    REAL,      -- always NULL (no fuel model)
    fuel_nom   REAL,      -- always NULL
    fuel_hi    REAL,      -- always NULL
    PRIMARY KEY (actype, version, phase, fl)
);
```

- **3,301 rows**, **66 aircraft types**, one `version` (`thaiapm-202607`), one
  `isa_offset` (15). You generally don't need to filter on `version` or
  `isa_offset` — there's only one of each.
- **FL grid:** 0, 5, 10, 15, 20, 30, 40, then every 20 levels (60, 80, 100, …)
  up to each type's cruising range. Not every type reaches every level — a
  turboprop tops out much lower than a widebody. If you want a value between
  grid points, interpolate linearly.

---

## Example queries

```sql
-- Typical climb rate of an A320 by altitude
SELECT fl, tas, rocd_nom
FROM thaiapm_performance
WHERE actype='A320' AND phase='climb'
ORDER BY fl;

-- Cruise true airspeed of a B738 at FL360
SELECT tas
FROM thaiapm_performance
WHERE actype='B738' AND phase='cruise' AND fl=360;

-- Descent rate profile for an A359
SELECT fl, tas, rocd_nom AS rate_of_descent_fpm
FROM thaiapm_performance
WHERE actype='A359' AND phase='descent'
ORDER BY fl DESC;

-- Fast vs slow climb spread at FL200 (remember: lo = fastest, hi = slowest)
SELECT rocd_hi AS slow_heavy, rocd_nom AS typical, rocd_lo AS fast_light
FROM thaiapm_performance
WHERE actype='A320' AND phase='climb' AND fl=200;

-- Which aircraft types are available?
SELECT DISTINCT actype FROM thaiapm_performance ORDER BY actype;
```

---

## The 66 aircraft types included

Airbus: A20N, A21N, A319, A320, A321, A332, A333, A338, A339, A343, A346, A359,
A35K, A388
Boeing: B38M, B39M, B733, B734, B737, B738, B739, B744, B748, B752, B763, B772,
B773, B77L, B77W, B788, B789, B78X
Embraer / regional: E135, E190, E290, SU95, AJ27, SF34, C909, DH8D
ATR / turboprop: AT75, AT76, C295, CN35, B350
Business jets: BE20, C510, C750, CL35, CL60, E35L, F2TH, FA7X, GALX, GL5T, GL7T,
GLEX, GLF4, GLF5, GLF6, H25B, HDJT, LJ60
Military / other: C130, C17, TEX2

If you ask for a type that isn't here (e.g. a helicopter, light GA, or a rare
type), it simply won't be in the table — 20 types were seen too rarely or too
incompletely to model and were left out.

---

## What this dataset can and can't answer

**Can:** true airspeed, climb rate, descent rate at any altitude for the 66
types; typical vs light-vs-heavy climb spread; comparisons between types;
building simple trajectory / time-to-climb estimates.

**Can't:** fuel burn, aircraft weight/mass, thrust or drag, engine data,
takeoff/landing distances, anything below the lowest tabulated FL in fine
detail, or exact figures for one specific flight. It's a statistical picture of
a fleet, in one region, warm conditions.

---

## Paste this to Claude first

> I'm giving you a SQLite database, `thaiapm_bada.sqlite`, with one table
> `thaiapm_performance` describing aircraft climb/cruise/descent performance for
> 66 aircraft types, fitted from real Bangkok-region radar data. Before you
> query it, note these rules:
> - `fl` is flight level (hundreds of feet), `tas` is knots, `rocd_*` is
>   feet/minute.
> - **`rocd_lo`/`rocd_hi` are inverted mass bands, not plain percentiles:** for
>   climb, `rocd_lo` is the *fastest* rate (p75) and `rocd_hi` is the *slowest*
>   (p25), so `rocd_lo > rocd_nom > rocd_hi`. Default to `rocd_nom` for "typical".
> - `rocd_*` is only meaningful for `phase='climb'`; cruise rows have NULL rocd
>   (use `tas`), and descent rows only populate `rocd_nom` (a positive rate of
>   descent).
> - All `fuel_*` columns are NULL — there is no fuel/weight/thrust data. Don't
>   invent it.
> - Values reflect actual operations in ~ISA+15 conditions, so they're
>   representative, not exact standard-atmosphere figures.
> Now, using the database, please help me with: <your question>
