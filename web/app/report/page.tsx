import ReportView from "@/components/report/ReportView";

export const metadata = {
  title: "Run report",
};

/**
 * The report tab (Server Component).
 *
 * Renders nothing of its own: the report is built in the console tab and handed
 * over by `postMessage`, so everything here is browser-side and lives in
 * <ReportView>. There is no server render to do and nothing to prefetch — this
 * URL on its own is an empty page by design, and says so.
 */
export default function ReportPage() {
  return <ReportView />;
}
