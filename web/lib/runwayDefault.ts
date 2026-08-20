/**
 * Default runway in use, by aerodrome and month of year.
 *
 * Reads the measured climatology in `public/data/airports/runway_default.csv`
 * (Cat Analytics' `flight_data.runway_default` — see
 * `Data/Runway/runway_default_README.md` for how it was built). Each row is
 * one airport × month-of-year × direction × runway, with `is_default = t`
 * marking that group's most-used runway (rnk 1).
 *
 * This is MEASURED usage, not the AIP's preferential-runway system: it says
 * what traffic actually did in that month across all pooled years, which is
 * why it is only ever used to PRE-FILL the runway pickers — the user can
 * always override it.
 *
 * Two rules from the README are enforced here:
 *   - Departures read the DEP rows and arrivals the ARR rows. The combined
 *     ALL bucket averages two segregated operations at the parallel-runway
 *     fields (VTBS/VTBD) and describes neither, so it is only a fallback for
 *     the small aerodromes that have no rows at all for one direction.
 *   - `movements` / `n_years` travel with the answer, so a default resting on
 *     a handful of movements can be shown as the thin evidence it is.
 */

/** Which half of the operation a default is wanted for. */
export type RunwayDirection = "DEP" | "ARR";

export interface RunwayDefault {
  /** Runway in the pickers' ARINC form, e.g. "RW21L". */
  ident: string;
  /** Designator as published, e.g. "21L". */
  runway: string;
  /** Share of that airport/month/direction's movements (0–100). */
  pct: number;
  /** Movements behind the figure, and how many years they came from — read
   *  these before trusting `pct` (README: <100 movements is arithmetic, not
   *  evidence). */
  movements: number;
  nYears: number;
  /** Bucket the answer came from: the asked-for direction, or "ALL" when that
   *  direction has no rows for this airport/month. */
  source: RunwayDirection | "ALL";
}

/** `${AIRPORT}|${month}|${DIR}` → that group's rnk-1 runway. */
type DefaultIndex = Map<string, RunwayDefault>;

const key = (airport: string, month: number, dir: string) =>
  `${airport}|${month}|${dir}`;

let _index: Promise<DefaultIndex> | null = null;

/** Parse the CSV. Plain comma-separated, no quoted fields (every column is a
 *  code, a number or an ISO date), so a split is enough. */
function parse(text: string): DefaultIndex {
  const lines = text.trim().split(/\r?\n/);
  const cols = lines[0].split(",").map((c) => c.trim());
  const at = (row: string[], name: string) => row[cols.indexOf(name)] ?? "";
  const out: DefaultIndex = new Map();
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const row = lines[i].split(",");
    // Only the rnk-1 row of each group is a "default"; the rest are the
    // runner-up runways, which nothing here needs.
    if (at(row, "is_default").trim().toLowerCase() !== "t") continue;
    const airport = at(row, "airport").trim().toUpperCase();
    const month = Number(at(row, "month_of_year"));
    const dir = at(row, "direction").trim().toUpperCase();
    const runway = at(row, "runway").trim().toUpperCase();
    if (!airport || !runway || !Number.isFinite(month)) continue;
    out.set(key(airport, month, dir), {
      ident: `RW${runway}`,
      runway,
      pct: Number(at(row, "pct")) || 0,
      movements: Number(at(row, "movements")) || 0,
      nYears: Number(at(row, "n_years")) || 0,
      source: dir === "DEP" || dir === "ARR" ? dir : "ALL",
    });
  }
  return out;
}

/** Load + memoise the whole table (~170 kB, fetched once per session). */
function loadIndex(): Promise<DefaultIndex> {
  if (!_index) {
    _index = fetch("/data/airports/runway_default.csv")
      .then((r) => {
        if (!r.ok) throw new Error(`runway_default.csv: HTTP ${r.status}`);
        return r.text();
      })
      .then(parse)
      .catch(() => {
        _index = null; // let a later call retry the fetch
        return new Map<string, RunwayDefault>();
      });
  }
  return _index;
}

/**
 * The runway an aerodrome normally uses in `month` (1–12) for `dir`.
 * Returns null when the table has nothing for that airport/month.
 */
export async function runwayDefault(
  airport: string,
  month: number,
  dir: RunwayDirection,
): Promise<RunwayDefault | null> {
  const code = airport.trim().toUpperCase();
  if (!code || !Number.isFinite(month) || month < 1 || month > 12) return null;
  const idx = await loadIndex();
  return idx.get(key(code, month, dir)) ?? idx.get(key(code, month, "ALL")) ?? null;
}

/** Month of year (1–12) of an EOBT as typed in the panel — a datetime-local
 *  string ("2026-08-08T00:16") read as UTC. 0 when it isn't a valid stamp. */
export function eobtMonth(eobt: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(eobt.trim());
  if (!m) return 0;
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? month : 0;
}
