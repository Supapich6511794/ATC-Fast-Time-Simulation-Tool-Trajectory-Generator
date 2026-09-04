/**
 * PDR conflict detection and route suggestion — the orchestrator.
 *
 * Answers one question about a filed plan: *may this flight fly this route, at
 * this level, at this time?* — and when the answer is no, which published route
 * it could fly instead.
 *
 * Four checks, all against the current AIRAC/AIP data the app already loads:
 *
 *   1. **Restricted airspace** — does the generated trajectory enter a P/D/R
 *      volume while that area is active? (./penetration + ./schedule)
 *   2. **Route availability** — is the filed route one ENR 1.10 publishes for
 *      this city pair? (./routeRules)
 *   3. **Direction** — these routes are one-way; is the filed one the return
 *      leg's routing?
 *   4. **Conditions** — a published route can be conditioned on a time window,
 *      an aircraft class, or another area's activity.
 *
 * Everything here is ADVISORY. Nothing in this module mutates a flight plan:
 * it returns findings with their reasons and a ranked list of alternatives, and
 * applying one is an explicit act by the controller in the UI. That is a
 * deliberate constraint, not an omission — the tool tells the controller what
 * the AIP says and lets them decide.
 *
 * The suggestion pool is the published-route table itself, never a synthesised
 * routing. A route this tool proposes is one the AIP already prints for the
 * pair, so accepting it cannot invent an unpublished path through Thai
 * airspace; the worst case is that it proposes a route the controller rejects.
 */

import type { Fix } from "@/lib/aip";
import type { AipRoute } from "@/lib/aipRoutes";
import { resolveRoutePreview } from "@/lib/routePreview";

import { findIncursions, pathFromFixes, routeLengthNm } from "./penetration";
import {
  matchFiledRoute,
  routeConditionVerdict,
  type ConditionContext,
  type ConditionVerdict,
} from "./routeRules";
import { formatSchedule } from "./schedule";
import type { PdrArea, PdrIncursion, TimedPoint } from "./types";

/** How much a finding matters.
 *  violation — the plan conflicts with a published restriction.
 *  caution   — it may, and the app cannot rule it out (unknown activity, a
 *              Danger area, an unverifiable condition).
 *  info      — worth knowing, nothing to act on. */
export type PdrSeverity = "violation" | "caution" | "info";

export type PdrCategory =
  | "restricted-airspace"
  | "route-availability"
  | "route-direction"
  | "route-condition"
  | "flight-level";

export interface PdrFinding {
  id: string;
  severity: PdrSeverity;
  category: PdrCategory;
  /** One-line headline, e.g. "Route enters VTD43 while active". */
  title: string;
  /** WHY — the published rule and how this plan breaches it. */
  reason: string;
  /** The authority behind it, e.g. "AIP THAILAND ENR 5.1 / AIXM 2608". */
  source: string;
  /** Area ident when the finding is about one, so the UI can focus the map. */
  area?: string;
  /** The incursion behind an airspace finding. */
  incursion?: PdrIncursion;
}

/** A published route offered in place of the filed one. */
export interface RouteSuggestion {
  /** The ENR 1.10 route string, verbatim — what would go in the plan. */
  route: string;
  rnav: boolean;
  /** Why this one is being offered. */
  why: string;
  /** Published condition and how it evaluates for this flight, if any. */
  condition: ConditionVerdict | null;
  /** Areas this route would still enter while they are active/unknown. Empty
   *  is the point of the suggestion. */
  activeAreas: string[];
  /** Areas the filed route hits that this one avoids. */
  clears: string[];
  /** Great-circle length over the resolved fixes (NM), for the cost readout.
   *  Null when the route string could not be resolved to coordinates. */
  distanceNm: number | null;
  /** Ranking score, lower is better. */
  score: number;
}

export interface PdrReport {
  findings: PdrFinding[];
  suggestions: RouteSuggestion[];
  /** Every area the filed route enters, active or not — the full picture the
   *  panel shows under "areas crossed". */
  incursions: PdrIncursion[];
  /** How the filed route relates to ENR 1.10. */
  routeMatch: ReturnType<typeof matchFiledRoute>;
  /** Number of PDR areas actually tested. 0 means the overlay was not loaded,
   *  and the panel must say so rather than report "no conflicts". */
  areasChecked: number;
  /** Worst severity present, or null when the plan is clean. */
  worst: PdrSeverity | null;
}

export interface PdrCheckInput {
  adep: string;
  ades: string;
  /** The filed en-route string, as typed into the generator. */
  filedRoute: string;
  actype?: string | null;
  /** Requested level, in feet. */
  rflFt: number;
  /** Cruise ground speed (kt), for estimating when a candidate route would be
   *  at each area. */
  gsKt: number;
  /** Off-blocks time, UTC epoch ms — the clock every schedule is read against. */
  eobtMs: number;
  /** The filed plan's generated trajectory, absolute-timed. */
  path: TimedPoint[];
  areas: PdrArea[];
  publishedRoutes: AipRoute[];
  fixes: Fix[];
  airways: Record<string, string[]>;
  /** Filed RNAV capability — picks which half of the published table applies. */
  rnav?: boolean;
}

const AIP_SOURCE = "AIP THAILAND ENR 5.1 / AIXM 2608";
const ENR_SOURCE = "AIP THAILAND ENR 1.10";

const SEVERITY_RANK: Record<PdrSeverity, number> = {
  violation: 0,
  caution: 1,
  info: 2,
};

function hhmm(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16) + "Z";
}

/** Lowest usable cruising level (ft) that clears an area's ceiling. Null when
 *  the area has no ceiling (UNL) — nothing to climb above. */
function levelAbove(area: PdrArea): number | null {
  if (!Number.isFinite(area.upperFt)) return null;
  // Next whole thousand at least 1000 ft above the ceiling.
  return Math.ceil((area.upperFt + 1000) / 1000) * 1000;
}

/** Severity for one incursion: a Prohibited or Restricted area is a hard stop,
 *  a Danger area is an advisory (it is legal to enter, and unwise), and an
 *  area whose activity cannot be determined is a caution either way. */
function incursionSeverity(inc: PdrIncursion): PdrSeverity {
  if (inc.worstState === "inactive") return "info";
  if (inc.worstState === "unknown") return "caution";
  return inc.area.kind === "D" ? "caution" : "violation";
}

function incursionFinding(inc: PdrIncursion, seq: number): PdrFinding {
  const a = inc.area;
  const label = a.ident + (a.name ? " " + a.name : "");
  const kindWord =
    a.kind === "P" ? "Prohibited" : a.kind === "D" ? "Danger" : "Restricted";
  const v = inc.activityAtEntry;
  const when =
    inc.exitMs > inc.entryMs
      ? hhmm(inc.entryMs) + "-" + hhmm(inc.exitMs)
      : hhmm(inc.entryMs);

  const band =
    inc.minAltFt === inc.maxAltFt
      ? Math.round(inc.minAltFt) + " ft"
      : Math.round(inc.minAltFt) + "-" + Math.round(inc.maxAltFt) + " ft";
  const areaBand =
    (a.lowerFt <= 0 ? "GND" : Math.round(a.lowerFt) + " ft") +
    " to " +
    (Number.isFinite(a.upperFt) ? Math.round(a.upperFt) + " ft" : "UNL");

  const parts = [
    "The route is inside " + label + " (" + kindWord + ", " + areaBand + ") for " +
      inc.transitNm.toFixed(1) + " NM at " + when + ", crossing at " + band + ".",
    "Published activity: " + v.schedule + ". " + v.detail,
  ];
  // The nature of the restriction and the hazard are published per area and are
  // the difference between "a training area" and "live gunnery" — the reason a
  // controller actually needs to see, not just the ident.
  const restriction = a.activity?.restriction?.trim();
  const hazard = a.activity?.hazard?.trim();
  if (restriction && restriction !== "-") parts.push("Restriction: " + restriction + ".");
  if (hazard && hazard !== "-") parts.push("Hazard: " + hazard + ".");
  if (v.holidayCaveat) {
    parts.push(
      "The schedule excludes public holidays and the dataset has no holiday calendar, so this is conditional on the date not being one.",
    );
  }
  const clearFt = levelAbove(a);
  if (clearFt && inc.maxAltFt < a.upperFt) {
    parts.push(
      "Vertically, FL" + Math.round(clearFt / 100) + " or above would overfly it.",
    );
  }

  const stateWord =
    inc.worstState === "active"
      ? "while active"
      : inc.worstState === "unknown"
        ? "with activity undetermined"
        : "while inactive";

  return {
    // Several polygons share one ident (VTD21 is published as three lettered
    // sub-areas), and a route can cross the same area twice, so the id carries
    // the AIXM designator and the position in the sorted list as well.
    id: "area:" + (a.activity?.designator ?? a.ident) + ":" + inc.entryMs + ":" + seq,
    severity: incursionSeverity(inc),
    category: "restricted-airspace",
    title: "Route enters " + a.ident + " " + stateWord,
    reason: parts.join(" "),
    source: AIP_SOURCE,
    area: a.ident,
    incursion: inc,
  };
}

/** Build the findings that are about the route itself rather than airspace. */
function routeFindings(
  input: PdrCheckInput,
  match: ReturnType<typeof matchFiledRoute>,
  ctx: ConditionContext,
): PdrFinding[] {
  const out: PdrFinding[] = [];
  const pair = input.adep + "-" + input.ades;

  if (match.kind === "reverse") {
    out.push({
      id: "route:direction",
      severity: "violation",
      category: "route-direction",
      title: "Filed route is published for the opposite direction",
      reason:
        "ENR 1.10 routes are directional. This routing is published for " +
        input.ades + "-" + input.adep + ", not for " + pair +
        ". It is not available in the direction of flight.",
      source: ENR_SOURCE,
    });
  } else if (match.kind === "none") {
    out.push({
      id: "route:availability",
      severity: "caution",
      category: "route-availability",
      title: "Filed route is not a published route for " + pair,
      reason:
        "ENR 1.10 publishes " + match.forPair.length + " route(s) for " + pair +
        " and the filed routing is not one of them. A non-standard routing is not " +
        "invalid, but it is not covered by the pre-agreed flight-planning table " +
        "and may need coordination.",
      source: ENR_SOURCE,
    });
  } else if (match.kind === "none-published") {
    out.push({
      id: "route:availability",
      severity: "info",
      category: "route-availability",
      title: "No published route for " + pair,
      reason:
        "ENR 1.10 has no flight-planning route for this city pair, so there is " +
        "nothing to check the filed routing against and no alternative to offer.",
      source: ENR_SOURCE,
    });
  }

  // The filed route IS published, but carries a condition that does not hold.
  if (match.matched) {
    const verdict = routeConditionVerdict(match.matched, ctx);
    if (verdict && verdict.state !== "met") {
      out.push({
        id: "route:condition",
        severity: verdict.state === "unmet" ? "violation" : "caution",
        category: "route-condition",
        title:
          verdict.state === "unmet"
            ? "Published route's condition is not satisfied"
            : "Published route's condition cannot be verified",
        reason:
          'ENR 1.10 publishes this route with the condition "' +
          match.matched.condition +
          '". ' + verdict.detail,
        source: ENR_SOURCE,
      });
    }
  }
  return out;
}

/**
 * Rank the published alternatives for the pair.
 *
 * A candidate is scored on what a controller would actually weigh: does its
 * condition hold, does it still cross something hot, and how much longer is it.
 * Routes identical to the filed one are dropped, and so are ones whose
 * condition is definitively unmet for this flight — offering a route the AIP
 * says is unavailable would be worse than offering nothing.
 */
function buildSuggestions(
  input: PdrCheckInput,
  match: ReturnType<typeof matchFiledRoute>,
  ctx: ConditionContext,
  filedActiveAreas: Set<string>,
): RouteSuggestion[] {
  const out: RouteSuggestion[] = [];

  for (const r of match.forPair) {
    if (match.matched && r.route === match.matched.route && r.rnav === match.matched.rnav) {
      continue; // this is what is already filed
    }
    // Keep the capability halves apart when the plan states one.
    if (input.rnav != null && r.rnav !== input.rnav) continue;

    const verdict = routeConditionVerdict(r, ctx);
    if (verdict?.state === "unmet") continue;

    const pts = resolveRoutePreview(r.route, input.fixes, input.airways);
    const distanceNm = pts.length > 1 ? routeLengthNm(pts) : null;

    // Re-run the airspace check on the candidate. Times are estimated from the
    // EOBT and cruise speed — good enough to tell "crosses D60 while hot" from
    // "crosses it cold", which is the decision this drives.
    let activeAreas: string[] = [];
    if (pts.length > 1) {
      const candidatePath = pathFromFixes(pts, {
        startMs: input.eobtMs,
        gsKt: input.gsKt,
        altFt: input.rflFt,
      });
      activeAreas = [
        ...new Set(
          findIncursions(candidatePath, input.areas)
            .filter((i) => i.worstState !== "inactive")
            .map((i) => i.area.ident),
        ),
      ];
    }

    const clears = [...filedActiveAreas].filter((id) => !activeAreas.includes(id));

    const why =
      activeAreas.length === 0 && clears.length > 0
        ? "Published route that avoids " + clears.join(", ") + " at this time."
        : activeAreas.length === 0
          ? "Published route with no active area on it at this time."
          : "Published route, but still crosses " + activeAreas.join(", ") + ".";

    // Lower is better: unresolved conditions and remaining hot areas dominate,
    // then track distance as the tie-break.
    const score =
      activeAreas.length * 100 +
      (verdict?.state === "unknown" ? 40 : 0) +
      (pts.length > 1 ? 0 : 25) +
      (distanceNm ?? 0) / 100;

    out.push({
      route: r.route,
      rnav: r.rnav,
      why,
      condition: verdict,
      activeAreas,
      clears,
      distanceNm,
      score,
    });
  }

  return out.sort((a, b) => a.score - b.score);
}

/** Run the whole PDR check for one flight plan. Pure — no fetching, no React. */
export function analysePdr(input: PdrCheckInput): PdrReport {
  const incursions = findIncursions(input.path, input.areas);

  const areasByIdent = new Map<string, PdrArea>();
  for (const a of input.areas) if (!areasByIdent.has(a.ident)) areasByIdent.set(a.ident, a);

  // Conditions are read at the time the flight would actually be en route.
  // Mid-flight is a better single instant than the EOBT for a route that is
  // hours long, and it is the same instant for every candidate, so they are
  // compared on equal terms.
  const lastMs = input.path.length ? input.path[input.path.length - 1].timeMs : input.eobtMs;
  const ctx: ConditionContext = {
    whenMs: input.eobtMs + (lastMs - input.eobtMs) / 2,
    areasByIdent,
    actype: input.actype,
  };

  const match = matchFiledRoute(
    input.filedRoute,
    input.publishedRoutes,
    input.adep,
    input.ades,
  );

  const findings = [
    ...incursions.map((inc, i) => incursionFinding(inc, i)),
    ...routeFindings(input, match, ctx),
  ].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.category.localeCompare(b.category),
  );

  const filedActiveAreas = new Set(
    incursions.filter((i) => i.worstState !== "inactive").map((i) => i.area.ident),
  );

  // Only offer alternatives when there is something to fix. A clean plan does
  // not need the controller reading a list of other routes.
  const needsAlternative = findings.some((f) => f.severity !== "info");
  const suggestions = needsAlternative
    ? buildSuggestions(input, match, ctx, filedActiveAreas)
    : [];

  const worst = findings.length
    ? findings.reduce<PdrSeverity>(
        (w, f) => (SEVERITY_RANK[f.severity] < SEVERITY_RANK[w] ? f.severity : w),
        "info",
      )
    : null;

  return {
    findings,
    suggestions,
    incursions,
    routeMatch: match,
    areasChecked: input.areas.length,
    worst,
  };
}

/** Convenience for the panel header: the schedule line for one area. */
export function areaScheduleText(area: PdrArea): string {
  return formatSchedule(area.activity);
}
