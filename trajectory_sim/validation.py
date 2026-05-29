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
# to RFL350, sampled from build_flight_timeline. A single affine fit
# overshoots short hops that never reach cruise (e.g. a 51 NM leg tops out
# ~8 600 ft and takes ~9 min, not the ~14 min an affine predicts) — so we
# interpolate this measured curve instead. The client mirrors the same
# table (web/lib/cat62.ts) so its PASS/FAIL prediction matches the server.
_SIM_TIME_TABLE: tuple[tuple[float, float], ...] = (
    (0, 0.0), (20, 3.7), (40, 7.3), (60, 11.0), (80, 14.4), (100, 17.7),
    (130, 22.5), (160, 27.1), (200, 32.9), (260, 40.9), (320, 48.9),
    (400, 59.6), (500, 73.0), (650, 93.0), (800, 113.0), (1000, 139.7),
    (1300, 179.7),
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
