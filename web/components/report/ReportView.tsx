"use client";

/**
 * ReportView — a run report's chart, on a page of its own.
 *
 * Opened from the Download dialog's "View" button, in a second browser tab, so
 * the chart can be read while the console keeps running behind it: the replay
 * carries on, the map keeps its position, and nothing has to be downloaded and
 * opened in a spreadsheet to answer "which sector was busiest".
 *
 * It shows the chart and nothing else. The rows are the Download dialog's job
 * (.csv / .xlsx), and building them here — tens of thousands of rows over a
 * traffic day — was most of the wait for a picture.
 *
 * It holds no data of its own. The console builds the chart's series and posts
 * it here (see `lib/report/viewPayload.ts` for why it is a handshake rather
 * than a URL), which means this tab cannot be bookmarked or reloaded into the
 * same report — a reload asks the console again, and says so plainly if the
 * console is gone.
 */

import { useEffect, useRef, useState } from "react";

import ReportChart from "@/components/report/ReportChart";
import {
  HELLO_EVERY_MS,
  HELLO_GIVE_UP_MS,
  REPORT_CHANNEL,
  isDelivery,
  type ReportPayload,
} from "@/lib/report/viewPayload";

type State =
  | { phase: "waiting" }
  | { phase: "ready"; payload: ReportPayload }
  | { phase: "lost"; why: string };

/** Height the chart may take: what the window has left under the heading,
 *  clamped so a small window still gets a readable plot and a huge one does not
 *  get a stretched one. */
function chartHeightFor(windowH: number): number {
  return Math.min(900, Math.max(320, windowH - 190));
}

export default function ReportView() {
  const [state, setState] = useState<State>({ phase: "waiting" });
  // Read once, on the client: reading `window.location` during the server
  // render would not match what the browser then produces.
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [chartH, setChartH] = useState(440);
  const asked = useRef(false);

  // The chart is the whole page, so it follows the window's height instead of
  // sitting at a fixed size in the top of a tall, empty tab.
  useEffect(() => {
    const fit = () => setChartH(chartHeightFor(window.innerHeight));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  useEffect(() => {
    if (asked.current) return;
    asked.current = true;

    const params = new URLSearchParams(window.location.search);
    const nonce = params.get("n") ?? "";
    // The console's theme, so the tab it opened is not the other one.
    if (params.get("theme") === "light") setTheme("light");
    const opener = window.opener as Window | null;

    if (!nonce || !opener || opener.closed) {
      setState({
        phase: "lost",
        why: "This tab was not opened from the console, or the console tab has been closed.",
      });
      return;
    }

    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      if (!isDelivery(e.data, nonce)) return;
      window.clearInterval(timer);
      window.clearTimeout(giveUp);
      if (e.data.type === "error") {
        setState({ phase: "lost", why: e.data.error ?? "The report could not be built." });
        return;
      }
      if (e.data.payload) {
        setState({ phase: "ready", payload: e.data.payload });
        document.title = e.data.payload.title;
      }
    };
    window.addEventListener("message", onMessage);

    // Keep asking: the console may still be walking the flights in the sample.
    const hello = () => {
      if (opener.closed) return;
      opener.postMessage(
        { channel: REPORT_CHANNEL, type: "hello", nonce },
        window.location.origin,
      );
    };
    hello();
    const timer = window.setInterval(hello, HELLO_EVERY_MS);
    const giveUp = window.setTimeout(() => {
      window.clearInterval(timer);
      setState((s) =>
        s.phase === "waiting"
          ? {
              phase: "lost",
              why: "The console never answered. It may have been reloaded since this tab was opened.",
            }
          : s,
      );
    }, HELLO_GIVE_UP_MS);

    return () => {
      window.removeEventListener("message", onMessage);
      window.clearInterval(timer);
      window.clearTimeout(giveUp);
    };
  }, []);

  if (state.phase !== "ready") {
    return (
      <div className={`app theme-${theme}`}>
        <main className="rv rv-blank">
          <div className="rv-blank-card">
            {state.phase === "waiting" ? (
              <>
                <span className="dlm-spin" aria-hidden="true" />
                <h1>Building the report…</h1>
                <p>
                  The console is working through the flights in the sample. A
                  whole traffic day takes a few seconds.
                </p>
              </>
            ) : (
              <>
                <h1>Nothing to show</h1>
                <p>{state.why}</p>
                <p className="rv-blank-hint">
                  Open it again from the console: <strong>Export → View</strong>{" "}
                  beside the report you want.
                </p>
              </>
            )}
          </div>
        </main>
      </div>
    );
  }

  const { payload } = state;
  return (
    <div className={`app theme-${theme}`}>
      <main className="rv">
        <header className="rv-head">
          <div className="rv-head-text">
            <h1>{payload.title}</h1>
            <p>{payload.subtitle}</p>
          </div>
        </header>

        <ReportChart spec={payload.spec} rows={payload.series} height={chartH} />
      </main>
    </div>
  );
}
