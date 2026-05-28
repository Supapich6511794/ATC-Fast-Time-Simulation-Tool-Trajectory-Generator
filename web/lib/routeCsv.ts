/**
 * Loader for the RouteBuilder picker's selectable waypoint idents.
 *
 * Now returns EVERY significant point in the CAAT eAIP cache
 * (`/data/aip_VT.json`) — all 340+ Thai fixes — so the picker can build
 * a route across any airway, not just the Y8 corridor.
 *
 * The Python pipeline still owns trajectory generation — this only reads
 * the ident list for the UI picker.
 */

import { fetchAip } from "@/lib/aip";

/** Every AIP significant-point ident, sorted alphabetically. */
export async function fetchCsvRouteIdents(): Promise<string[]> {
  const aip = await fetchAip();
  return Object.keys(aip.waypoints).sort();
}
