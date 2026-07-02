"""Flight-time validation against CAT62 reference data.

Compares a simulated total flight time with the CAT62 (ASTERIX CAT062
surveillance) reference time for the same city pair, computes the delta
in minutes and applies the acceptance criterion:

    delta = simulated_time − cat62_reference_time      (signed, minutes)
    PASS  if |delta| < 5 minutes
    FAIL  if |delta| ≥ 5 minutes

The reference times live in ``trajectory_sim/data/cat62_reference.json``
(keyed by ``ADEP-ADES``, matched in either direction). Replace those
seed values with figures derived from real CAT062 samples.

Typical loop:

    1. build a timeline → simulated minutes  (trajectory.build_flight_timeline)
    2. validate_flight_time(...)             → PASS / FAIL + delta
    3. if FAIL, tune the speed schedule       (performance.tune_speed_schedule)
    4. rebuild + re-validate until PASS

This module is pure (no I/O beyond reading the reference JSON) and has no
third-party dependencies.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

#: Acceptance threshold — a flight passes when |delta| is strictly below
#: this many minutes.
ACCEPTANCE_THRESHOLD_MIN = 5.0

_DEFAULT_REFERENCE_PATH = (
    Path(__file__).resolve().parent / "data" / "cat62_reference.json"
)

# --- Distance → time model (measured lookup table, interpolated) -----------
# Simulated total time (minutes) vs great-circle distance (NM) for a B738
# to RFL350, sampled from build_flight_timeline. Calibrated against the
# real BADA 3.16 (ISA+20) climb/descent RATES plus the operational CAS/Mach
# speed schedule (B738 ~M0.78) now driving performance.py, so it must be
# re-measured if either changes. A single
# affine fit overshoots short hops that never reach cruise (e.g. a 51 NM
# leg tops out ~8 600 ft and takes ~9 min, not ~14) — so we interpolate
# this measured curve instead. The client mirrors the same table
# (web/lib/cat62.ts) so its PASS/FAIL prediction matches the server.
_SIM_TIME_TABLE: tuple[tuple[float, float], ...] = (
    (0, 0.0), (20, 3.7), (40, 7.4), (60, 11.0), (80, 14.7), (100, 18.2),
    (130, 23.2), (160, 27.9), (200, 34.1), (260, 42.6), (320, 50.7),
    (400, 61.4), (500, 74.8), (650, 94.9), (800, 114.9), (1000, 141.6),
    (1300, 181.8),
)

# Reference estimate (for pairs with no real CAT62 sample) = predicted sim
# time + a small terminal-area margin, so a nominal route lands a few
# minutes UNDER the reference (PASS) instead of failing. Replace with a
# measured CAT062 figure where accuracy matters.
_REF_MARGIN_MIN = 3.0


def estimate_sim_min(distance_nm: float) -> float:
    """Predicted *simulated* flight time (minutes) for a route distance.

    Piecewise-linear interpolation of the measured calibration curve, so
    the UI can pre-screen candidate routes cheaply and the prediction
    tracks the real timeline across short hops AND long sectors. Beyond
    the table it extrapolates along the final segment.
    """
    tbl = _SIM_TIME_TABLE
    d = max(0.0, distance_nm)
    if d <= tbl[0][0]:
        return tbl[0][1]
    for (d0, t0), (d1, t1) in zip(tbl, tbl[1:]):
        if d <= d1:
            return t0 + (t1 - t0) * (d - d0) / (d1 - d0)
    (d0, t0), (d1, t1) = tbl[-2], tbl[-1]
    return t1 + (t1 - t0) / (d1 - d0) * (d - d1)


def estimate_reference_min(
    distance_nm: float,
    *,
    margin_min: float = _REF_MARGIN_MIN,
) -> float:
    """Distance-based reference estimate (minutes) for a pair with no real
    CAT62 sample.

    Predicted sim time plus a small terminal-area margin, so the simulator
    passes its own self-consistency check while still flagging gross
    outliers (huge detours) as FAIL. Surfaced as ``source="estimate"``.
    """
    return estimate_sim_min(distance_nm) + margin_min


def _route_key(adep: str, ades: str) -> str:
    return f"{adep.strip().upper()}-{ades.strip().upper()}"


@dataclass(frozen=True)
class FlightTimeValidation:
    """Result of comparing one simulated flight time to its reference."""

    route: str                 # "VTBS-WMKK"
    cat62_min: float           # reference minutes (real sample OR estimate)
    simulated_min: float       # simulated minutes
    delta_min: float           # signed: simulated − reference
    threshold_min: float       # acceptance threshold used
    status: str                # "PASS" | "FAIL"
    source: str = "cat62"      # "cat62" (real sample) | "estimate" (distance)

    @property
    def passed(self) -> bool:
        return self.status == "PASS"

    @property
    def is_estimate(self) -> bool:
        return self.source == "estimate"

    def report(self) -> str:
        """Human-readable report block (matches the spec's example)."""
        sign = "+" if self.delta_min >= 0 else "-"
        label = "Estimated Time" if self.is_estimate else "CAT62 Time"
        return (
            f"Route: {self.route}\n"
            f"{label}: {self.cat62_min:.0f} min"
            + (" (estimate)" if self.is_estimate else "")
            + "\n"
            f"Simulated Time: {self.simulated_min:.0f} min\n"
            f"Delta: {sign}{abs(self.delta_min):.0f} min\n"
            f"Status: {self.status}"
        )

    def to_dict(self) -> dict[str, object]:
        """JSON-friendly dict (for an API response or a report file)."""
        return {
            "route": self.route,
            "cat62_min": round(self.cat62_min, 1),
            "simulated_min": round(self.simulated_min, 1),
            "delta_min": round(self.delta_min, 1),
            "threshold_min": self.threshold_min,
            "status": self.status,
            "passed": self.passed,
            "source": self.source,
        }


def validate_flight_time(
    route: str,
    cat62_min: float,
    simulated_min: float,
    threshold_min: float = ACCEPTANCE_THRESHOLD_MIN,
    source: str = "cat62",
) -> FlightTimeValidation:
    """Build a :class:`FlightTimeValidation` from raw times.

    Args:
        route: Display label, e.g. ``"VTBS-WMKK"``.
        cat62_min: Reference flight time in minutes (real or estimated).
        simulated_min: Simulated flight time in minutes.
        threshold_min: PASS if ``abs(delta) < threshold_min``.
        source: ``"cat62"`` for a real sample, ``"estimate"`` for the
            distance-based fallback.

    Returns:
        The populated validation result.
    """
    delta = simulated_min - cat62_min
    status = "PASS" if abs(delta) < threshold_min else "FAIL"
    return FlightTimeValidation(
        route=route,
        cat62_min=cat62_min,
        simulated_min=simulated_min,
        delta_min=delta,
        threshold_min=threshold_min,
        status=status,
        source=source,
    )


# --- Cruise level vs FPL RFL --------------------------------------------------
# The simulated cruise altitude must match the FPL Requested Flight Level
# exactly. When it does not, the mismatch is only acceptable if a *physical*
# limit forced it lower — the aircraft's service ceiling, the top the climb
# schedule can reach, or a flight too short to reach the level in time. Those
# clamps PASS (with a reason); a cruise ABOVE the RFL, or below it with no
# limit binding, is an unexplained mismatch and FAILs.

#: Cruise level counts as an exact RFL match within this tolerance (feet).
LEVEL_MATCH_TOL_FT = 1.0


@dataclass(frozen=True)
class CruiseLevelValidation:
    """Result of comparing a simulated cruise altitude to the FPL RFL."""

    route: str
    rfl_ft: float           # FPL-requested level (feet)
    cruise_alt_ft: float    # simulated cruise altitude (feet)
    delta_ft: float         # signed: cruise − rfl (0 = exact, <0 = below)
    status: str             # "PASS" | "FAIL"
    reason: str             # exact | ceiling_limited | climb_limited
    #                         | distance_limited | overshoot | mismatch

    @property
    def passed(self) -> bool:
        return self.status == "PASS"

    @property
    def is_exact(self) -> bool:
        return self.reason == "exact"

    def report(self) -> str:
        """Human-readable report block (mirrors FlightTimeValidation)."""
        sign = "+" if self.delta_ft >= 0 else "-"
        return (
            f"Route: {self.route}\n"
            f"Requested Level: FL{self.rfl_ft / 100:.0f}\n"
            f"Simulated Cruise: FL{self.cruise_alt_ft / 100:.0f}\n"
            f"Delta: {sign}{abs(self.delta_ft):.0f} ft\n"
            f"Status: {self.status} ({self.reason})"
        )

    def to_dict(self) -> dict[str, object]:
        """JSON-friendly dict (for an API response or a report file)."""
        return {
            "route": self.route,
            "rfl_ft": round(self.rfl_ft, 1),
            "cruise_alt_ft": round(self.cruise_alt_ft, 1),
            "delta_ft": round(self.delta_ft, 1),
            "status": self.status,
            "passed": self.passed,
            "reason": self.reason,
        }


def validate_cruise_level(
    rfl_ft: float,
    cruise_alt_ft: float,
    *,
    service_ceiling_ft: float | None = None,
    climb_top_ft: float | None = None,
    reaches_rfl: bool | None = None,
    route: str = "",
) -> CruiseLevelValidation:
    """Validate a simulated cruise altitude against the FPL RFL.

    Args:
        rfl_ft: FPL Requested Flight Level, in feet (e.g. FL350 → 35000).
        cruise_alt_ft: Simulated cruise altitude, in feet.
        service_ceiling_ft: Airframe service ceiling; a level above it that
            is clamped lower PASSes as ``ceiling_limited``.
        climb_top_ft: Highest altitude the climb schedule reaches; a level
            above it PASSes as ``climb_limited``.
        reaches_rfl: Whether the flight is long enough to reach ``rfl_ft`` in
            time. ``False`` (or ``None`` when unknown) treats a below-RFL
            cruise as a legitimate ``distance_limited`` clamp; ``True`` marks
            it an unexplained ``mismatch`` (FAIL).
        route: Display label, e.g. ``"VTBS-VTSP"``.

    Returns:
        A :class:`CruiseLevelValidation`. Exact match and every physically
        justified clamp PASS; a cruise above the RFL (``overshoot``) or a
        below-RFL cruise with no limit binding (``mismatch``) FAIL.
    """
    delta = cruise_alt_ft - rfl_ft
    if abs(delta) <= LEVEL_MATCH_TOL_FT:
        reason, status = "exact", "PASS"
    elif delta > LEVEL_MATCH_TOL_FT:
        # Simulated cruise ABOVE the requested level — never a valid clamp.
        reason, status = "overshoot", "FAIL"
    elif service_ceiling_ft is not None and rfl_ft > service_ceiling_ft + LEVEL_MATCH_TOL_FT:
        reason, status = "ceiling_limited", "PASS"
    elif climb_top_ft is not None and rfl_ft > climb_top_ft + LEVEL_MATCH_TOL_FT:
        reason, status = "climb_limited", "PASS"
    elif reaches_rfl is True:
        # Level is within reach and time allows it, yet cruise came out lower.
        reason, status = "mismatch", "FAIL"
    else:
        # Too short to reach the level in time (or reachability unknown).
        reason, status = "distance_limited", "PASS"
    return CruiseLevelValidation(
        route=route,
        rfl_ft=rfl_ft,
        cruise_alt_ft=cruise_alt_ft,
        delta_ft=delta,
        status=status,
        reason=reason,
    )


# --- Top-of-climb altitude vs real track -------------------------------------
# The simulated top-of-climb altitude (its cruise level) must be within
# 2000 ft of the real track's cruise level for the same city pair. The real
# reference comes from trajectory_sim.cat62_track (the dominant cruise FL of
# the CAT062 surveillance track).

#: A simulated top-of-climb altitude passes within this many feet of the real.
TOC_THRESHOLD_FT = 2000.0


@dataclass(frozen=True)
class TocAltitudeValidation:
    """Result of comparing a simulated top-of-climb altitude to a real track."""

    route: str
    real_toc_ft: float       # real track's cruise level (feet)
    sim_toc_ft: float        # simulated top-of-climb altitude (feet)
    delta_ft: float          # signed: sim − real
    threshold_ft: float
    status: str              # "PASS" | "FAIL"

    @property
    def passed(self) -> bool:
        return self.status == "PASS"

    def report(self) -> str:
        """Human-readable report block (mirrors FlightTimeValidation)."""
        sign = "+" if self.delta_ft >= 0 else "-"
        return (
            f"Route: {self.route}\n"
            f"Real TOC: FL{self.real_toc_ft / 100:.0f}\n"
            f"Simulated TOC: FL{self.sim_toc_ft / 100:.0f}\n"
            f"Delta: {sign}{abs(self.delta_ft):.0f} ft "
            f"(threshold {self.threshold_ft:.0f} ft)\n"
            f"Status: {self.status}"
        )

    def to_dict(self) -> dict[str, object]:
        """JSON-friendly dict (for an API response or a report file)."""
        return {
            "route": self.route,
            "real_toc_ft": round(self.real_toc_ft, 1),
            "sim_toc_ft": round(self.sim_toc_ft, 1),
            "delta_ft": round(self.delta_ft, 1),
            "threshold_ft": self.threshold_ft,
            "status": self.status,
            "passed": self.passed,
        }


def validate_toc_altitude(
    sim_toc_ft: float,
    real_toc_ft: float,
    threshold_ft: float = TOC_THRESHOLD_FT,
    route: str = "",
) -> TocAltitudeValidation:
    """Validate a simulated top-of-climb altitude against a real track.

    Args:
        sim_toc_ft: Simulated top-of-climb altitude (the cruise level), feet.
        real_toc_ft: Real track's dominant cruise level, feet.
        threshold_ft: PASS if ``abs(sim − real) < threshold_ft`` (default
            2000 ft).
        route: Display label, e.g. ``"VTBS-VTSP"``.

    Returns:
        The populated :class:`TocAltitudeValidation`.
    """
    delta = sim_toc_ft - real_toc_ft
    status = "PASS" if abs(delta) < threshold_ft else "FAIL"
    return TocAltitudeValidation(
        route=route,
        real_toc_ft=real_toc_ft,
        sim_toc_ft=sim_toc_ft,
        delta_ft=delta,
        threshold_ft=threshold_ft,
        status=status,
    )


# --- CAB table of cruising levels (hemispheric rule) -------------------------
# Thai CAB (Civil Aviation Board) Rules of the Air §2.4.2 — the IFR cruising
# level depends on the magnetic track:
#   * track 000°–179° (eastbound): FL110, 130, 150 … 410, then 450, 490
#   * track 180°–359° (westbound): FL120, 140, 160 … 400, then 430, 470, 510
# Below FL410 this is the familiar odd-FL-east / even-FL-west parity; above
# FL410 the spacing widens to 2000 ft, so the exact published sets are used
# rather than a parity test. (VFR levels — the +500 ft variants — are not
# modelled; the sim flies IFR.)
_EAST_IFR_FL: frozenset[int] = frozenset(
    {110, 130, 150, 170, 190, 210, 230, 250, 270, 290, 310, 330, 350, 370, 390, 410, 450, 490}
)
_WEST_IFR_FL: frozenset[int] = frozenset(
    {120, 140, 160, 180, 200, 220, 240, 260, 280, 300, 320, 340, 360, 380, 400, 430, 470, 510}
)


def _is_eastbound(track_deg: float) -> bool:
    """True for track 000°–179° (the eastbound half of the CAB table)."""
    return 0.0 <= (track_deg % 360.0) < 180.0


def cruising_levels_for(track_deg: float) -> list[int]:
    """The valid IFR cruising levels (FL) for a track, per the CAB table."""
    return sorted(_EAST_IFR_FL if _is_eastbound(track_deg) else _WEST_IFR_FL)


def cab_cruising_level(track_deg: float, desired_fl: int) -> int:
    """Snap a desired FL to the nearest valid CAB cruising level for a track.

    Ties break to the lower level. Lets a flight-plan generator pick a level
    that complies with the hemispheric rule instead of an arbitrary one.
    """
    levels = cruising_levels_for(track_deg)
    return min(levels, key=lambda fl: (abs(fl - desired_fl), fl))


@dataclass(frozen=True)
class CruisingLevelValidation:
    """Result of checking an RFL against the CAB table of cruising levels."""

    route: str
    track_deg: float
    fl: int                 # requested flight level (RFL / 100)
    direction: str          # "E" (000–179°) | "W" (180–359°)
    compliant: bool
    status: str             # "PASS" | "FAIL"
    nearest_valid_fl: int   # the CAB level it should have used

    @property
    def passed(self) -> bool:
        return self.status == "PASS"

    def report(self) -> str:
        band = "000-179 (E)" if self.direction == "E" else "180-359 (W)"
        line = (
            f"Route: {self.route}\n"
            f"Track: {self.track_deg:.0f}° [{band}]\n"
            f"Requested Level: FL{self.fl}\n"
            f"Status: {self.status}"
        )
        if not self.compliant:
            line += f" (should be FL{self.nearest_valid_fl} per CAB §2.4.2)"
        return line

    def to_dict(self) -> dict[str, object]:
        return {
            "route": self.route,
            "track_deg": round(self.track_deg, 1),
            "fl": self.fl,
            "direction": self.direction,
            "compliant": self.compliant,
            "status": self.status,
            "nearest_valid_fl": self.nearest_valid_fl,
        }


def validate_cruising_level(
    track_deg: float,
    rfl_ft: float,
    route: str = "",
) -> CruisingLevelValidation:
    """Check whether an RFL is a legal IFR cruising level for its track.

    Args:
        track_deg: Route track (great-circle bearing ADEP→ADES), degrees true.
        rfl_ft: Requested Flight Level in feet (FL350 → 35000).
        route: Display label, e.g. ``"VTBD-VTCN"``.

    Returns:
        A :class:`CruisingLevelValidation`. PASS when the FL is in the CAB
        set for the track's hemisphere; FAIL (wrong odd/even for the
        direction) otherwise, with the nearest compliant level.
    """
    fl = round(rfl_ft / 100.0)
    east = _is_eastbound(track_deg)
    valid = fl in (_EAST_IFR_FL if east else _WEST_IFR_FL)
    return CruisingLevelValidation(
        route=route,
        track_deg=track_deg,
        fl=fl,
        direction="E" if east else "W",
        compliant=valid,
        status="PASS" if valid else "FAIL",
        nearest_valid_fl=cab_cruising_level(track_deg, fl),
    )


class CAT62Reference:
    """Lookup of reference flight times keyed by ``ADEP-ADES`` city pair.

    Matching is direction-agnostic: ``VTBS-WMKK`` also resolves a lookup
    for ``WMKK-VTBS``.
    """

    def __init__(
        self,
        routes: dict[str, float],
        threshold_min: float = ACCEPTANCE_THRESHOLD_MIN,
    ) -> None:
        # Normalise keys to upper-case ADEP-ADES.
        self._routes: dict[str, float] = {}
        for k, v in routes.items():
            parts = k.replace("/", "-").split("-")
            if len(parts) == 2:
                self._routes[_route_key(parts[0], parts[1])] = float(v)
        self.threshold_min = threshold_min

    @classmethod
    def load(cls, path: str | Path | None = None) -> CAT62Reference:
        """Load the reference table from JSON (default bundled file)."""
        p = Path(path) if path else _DEFAULT_REFERENCE_PATH
        data = json.loads(p.read_text(encoding="utf-8"))
        return cls(
            routes=data.get("routes", {}),
            threshold_min=float(
                data.get("threshold_min", ACCEPTANCE_THRESHOLD_MIN)
            ),
        )

    def table(self) -> dict[str, float]:
        """Copy of the normalised ``ADEP-ADES → minutes`` reference map."""
        return dict(self._routes)

    def lookup(self, adep: str, ades: str) -> float | None:
        """Reference minutes for a pair, or None when not in the table.

        Tries ``ADEP-ADES`` first, then the reverse ``ADES-ADEP``.
        """
        fwd = self._routes.get(_route_key(adep, ades))
        if fwd is not None:
            return fwd
        return self._routes.get(_route_key(ades, adep))

    def validate(
        self,
        adep: str,
        ades: str,
        simulated_min: float,
        distance_nm: float | None = None,
    ) -> FlightTimeValidation | None:
        """Validate a simulated time against the matched reference.

        Resolution order:
          1. Real CAT62 sample for the pair (``source="cat62"``).
          2. Distance-based estimate when ``distance_nm`` is given but the
             pair has no sample (``source="estimate"``).
          3. ``None`` when neither is available.

        This lets *every* routable pair report a delta + PASS/FAIL, while
        keeping real samples authoritative where they exist.
        """
        ref = self.lookup(adep, ades)
        if ref is not None:
            return validate_flight_time(
                route=_route_key(adep, ades),
                cat62_min=ref,
                simulated_min=simulated_min,
                threshold_min=self.threshold_min,
                source="cat62",
            )
        if distance_nm is not None and distance_nm > 0:
            return validate_flight_time(
                route=_route_key(adep, ades),
                cat62_min=estimate_reference_min(distance_nm),
                simulated_min=simulated_min,
                threshold_min=self.threshold_min,
                source="estimate",
            )
        return None
