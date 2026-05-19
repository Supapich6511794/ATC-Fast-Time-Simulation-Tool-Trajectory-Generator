import MapApp from "@/components/MapApp";

/**
 * Home route (Server Component).
 *
 * It renders nothing browser-specific itself — all Leaflet / window access is
 * isolated inside <MapApp>, which is a Client Component. This keeps the
 * server render clean and avoids "window is not defined" during SSR.
 */
export default function Page() {
  return <MapApp />;
}
