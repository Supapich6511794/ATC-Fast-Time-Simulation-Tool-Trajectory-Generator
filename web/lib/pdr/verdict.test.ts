import { describe, expect, it } from "vitest";

import type { PdrReport, PdrSeverity } from "@/lib/pdr/detect";
import { inPdrTab, pdrTabCounts, pdrVerdict } from "@/lib/pdr/verdict";

/** Only `findings` is read; the rest of a report is irrelevant to the verdict. */
function report(...severities: PdrSeverity[]): PdrReport {
  return {
    findings: severities.map((severity, i) => ({
      id: "f" + i,
      severity,
    })),
  } as unknown as PdrReport;
}

describe("pdrVerdict", () => {
  it("is pending — not clear — for a flight the scan has not reached", () => {
    expect(pdrVerdict(undefined)).toBe("pending");
  });

  it("is clear with no findings, and with only info-level notes", () => {
    expect(pdrVerdict(report())).toBe("clear");
    expect(pdrVerdict(report("info", "info"))).toBe("clear");
  });

  it("is check when the worst finding is a caution", () => {
    expect(pdrVerdict(report("caution"))).toBe("check");
    expect(pdrVerdict(report("info", "caution"))).toBe("check");
  });

  it("is rejected as soon as any finding is a violation, whatever else there is", () => {
    expect(pdrVerdict(report("violation"))).toBe("rejected");
    expect(pdrVerdict(report("caution", "info", "violation"))).toBe("rejected");
  });
});

describe("pdrTabCounts / inPdrTab", () => {
  const verdicts = ["clear", "clear", "check", "rejected", "pending"] as const;

  it("counts each tab, with pending flights in All only", () => {
    expect(pdrTabCounts(verdicts)).toEqual({
      all: 5,
      clear: 2,
      check: 1,
      rejected: 1,
    });
  });

  it("puts a flight on All and on its own tab, nowhere else", () => {
    expect(inPdrTab("check", "all")).toBe(true);
    expect(inPdrTab("check", "check")).toBe(true);
    expect(inPdrTab("check", "clear")).toBe(false);
    expect(inPdrTab("check", "rejected")).toBe(false);
    expect(inPdrTab("pending", "all")).toBe(true);
    expect(inPdrTab("pending", "clear")).toBe(false);
  });
});
