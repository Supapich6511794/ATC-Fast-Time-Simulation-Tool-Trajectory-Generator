/**
 * Give the browser its turn, and get it back — without a timer.
 *
 * `setTimeout(0)` is the usual way to break a long loop into slices, and it is
 * the wrong one for the run reports. "View" opens the report in a NEW tab in
 * front of the console, so the console — the tab that does the building — is
 * hidden for the whole build, and a browser holds a hidden tab's timers back:
 * to about one wake-up a second, then to a ~1% CPU budget. Measured in Chrome,
 * 12 slices of 50 ms of work each:
 *
 *   visible tab,  setTimeout(0)         0.6 s
 *   hidden tab,   setTimeout(0)         6.3 s
 *   hidden tab,   MessageChannel        0.6 s
 *
 * A traffic day is ~45 slices, so the report sat on "Building…" for the better
 * part of a minute while ~2 s of actual work was done.
 *
 * A posted message is an ordinary task, not a timer, so it is not held back —
 * and it still lets input and painting run between slices in a visible tab,
 * which is the reason to yield at all.
 */
export function yieldToMain(): Promise<void> {
  if (typeof MessageChannel === "undefined") {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close();
      port2.close();
      resolve();
    };
    port2.postMessage(null);
  });
}
