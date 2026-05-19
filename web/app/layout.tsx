import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Aviation Map Viewer",
  description: "Plot aviation GeoJSON (waypoints + airways) on an interactive Leaflet map.",
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
