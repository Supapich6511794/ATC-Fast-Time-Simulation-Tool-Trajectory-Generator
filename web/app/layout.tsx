import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Aviation Map Viewer",
  description: "Plot aviation GeoJSON (waypoints + airways) on an interactive Leaflet map.",
};

// Without this, mobile browsers lay the page out at ~980px and scale it
// down — the whole UI renders tiny with the page background showing
// around it. `width=device-width` makes 100vw the real device width.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

/**
 * Root layout. Server Component — it only renders static shell markup and
 * imports the global stylesheet (which also pulls in Leaflet's CSS).
 */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
