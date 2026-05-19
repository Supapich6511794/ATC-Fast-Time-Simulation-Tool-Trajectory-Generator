/**
 * Loader for the airway-leg route CSV (`VTPStoVTBS.csv`).
 *
 * Used to restrict the RouteBuilder picker to ONLY the waypoints that
 * belong to the supervisor-provided FPL/airway route (the fixes of
 * airway Y8: PUT … BKK), instead of every fix in the airway file.
 *
 * The Python pipeline still owns trajectory generation — this only reads
 * the ident list for the UI picker.
 */

const CSV_URL = "/data/VTPStoVTBS.csv";

/** Minimal CSV parse — the file has no quoted fields / embedded commas. */
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}

/**
 * Fetch the route CSV and return its waypoint idents in airway order
 * (chained by `seqno`, duplicates collapsed).
 */
export async function fetchCsvRouteIdents(): Promise<string[]> {
  const res = await fetch(CSV_URL, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Failed to load ${CSV_URL}: ${res.status}`);
  }
  const rows = parseCsv(await res.text());
  rows.sort((a, b) => Number(a.seqno) - Number(b.seqno));

  const ordered: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    if (id && !seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  };
  for (const r of rows) {
    push(r.waypoint_identifier);
    push(r.waypoint_identifier_2);
  }
  return ordered;
}
