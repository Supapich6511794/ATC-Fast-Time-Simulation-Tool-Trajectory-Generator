"""Aircraft vertical performance — Phase 2 (BADA-style segmented model).

Builds a climb → cruise → descent altitude profile and labels each
trajectory sample's flight phase using a BADA-3-style piecewise model
keyed on altitude band: real airframes climb faster low than high and
descend at a roughly constant rate. The data tables here mirror the
shape of BADA OPF entries for the in-scope airframes; values are
typical published performance, not the licensed BADA dataset.

The public surface stays the contract output.py was already written
against — :class:`VerticalProfile` with :meth:`build` and :meth:`at` —
so swapping the old constant-rate placeholder for this segmented model
needed no caller changes.

Units: altitude in feet, rates in ft/min, time in seconds.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

#: Flight phase along the vertical profile.
Phase = Literal["climb", "cruise", "descent"]


@dataclass(frozen=True)
class _Segment:
    """One altitude band with a constant vertical rate (fpm)."""

    alt_lo_ft: float
    alt_hi_ft: float
    rate_fpm: float


# BADA-style climb / descent schedules. Climb ROC drops with altitude
# (engine thrust falls off, induced drag rises). Descent ROD is roughly
# constant at idle thrust + speed brakes as needed. Numbers are
# representative published B738 performance and align with the brief's
# 1500–2500 ft/min envelope below FL300; above FL300 the model lets ROC
# fall below 1500 fpm because that's what the airframe actually does
# (the brief's envelope is a planning average, not a physical limit).
_B738_CLIMB: tuple[_Segment, ...] = (
    _Segment(0,     10000, 2500.0),
    _Segment(10000, 20000, 2000.0),
    _Segment(20000, 30000, 1500.0),
    _Segment(30000, 37000, 1100.0),
    _Segment(37000, 41000,  700.0),
)
_B738_DESCENT: tuple[_Segment, ...] = (
    _Segment(0,     10000, 1500.0),
    _Segment(10000, 24000, 1800.0),
    _Segment(24000, 41000, 1800.0),
)

# A320 — same family of numbers, slightly weaker climb at altitude.
_A320_CLIMB: tuple[_Segment, ...] = (
    _Segment(0,     10000, 2400.0),
    _Segment(10000, 20000, 1900.0),
    _Segment(20000, 30000, 1400.0),
    _Segment(30000, 37000, 1000.0),
    _Segment(37000, 41000,  600.0),
)
_A320_DESCENT: tuple[_Segment, ...] = (
    _Segment(0,     10000, 1500.0),
    _Segment(10000, 24000, 1700.0),
    _Segment(24000, 41000, 1700.0),
)

# B77W — heavy long-haul; lower fpm but higher ceiling.
_B77W_CLIMB: tuple[_Segment, ...] = (
    _Segment(0,     10000, 2200.0),
    _Segment(10000, 20000, 1800.0),
    _Segment(20000, 30000, 1300.0),
    _Segment(30000, 37000,  900.0),
    _Segment(37000, 43000,  500.0),
)
_B77W_DESCENT: tuple[_Segment, ...] = (
    _Segment(0,     10000, 1500.0),
    _Segment(10000, 24000, 1700.0),
    _Segment(24000, 43000, 1700.0),
)

_PERF_TABLES: dict[str, tuple[tuple[_Segment, ...], tuple[_Segment, ...]]] = {
    "B738": (_B738_CLIMB, _B738_DESCENT),
    "A320": (_A320_CLIMB, _A320_DESCENT),
    "B77W": (_B77W_CLIMB, _B77W_DESCENT),
}

# Field elevations (ft AMSL) for the airports in scope. Real navdata
# (airports layer) isn't delivered yet, so these are the published AIP
# elevations for the single city pair; default 0 elsewhere.
_FIELD_ELEV_FT: dict[str, float] = {
    "VTBS": 5.0,    # Bangkok Suvarnabhumi
    "VTSP": 25.0,   # Phuket
    "VTBD": 9.0,    # Bangkok Don Mueang (in case of reroute)
}


def field_elevation_ft(icao: str) -> float:
    """Published field elevation in feet, or 0.0 if unknown."""
    return _FIELD_ELEV_FT.get(icao.upper(), 0.0)


def _segments_for(aircraft_type: str) -> tuple[tuple[_Segment, ...], tuple[_Segment, ...]]:
    """Return (climb_segments, descent_segments) for an aircraft type.

    Unknown types fall back to the B738 table — the brief only flies the
    B738; A320/B77W are forward-compat slots.
    """
    return _PERF_TABLES.get(aircraft_type.upper(), _PERF_TABLES["B738"])


def _time_to_climb(
    segs: tuple[_Segment, ...], from_ft: float, to_ft: float
) -> float:
    """Seconds to climb between two altitudes through a segmented schedule."""
    if to_ft <= from_ft:
        return 0.0
    total_s = 0.0
    for s in segs:
        lo = max(s.alt_lo_ft, from_ft)
        hi = min(s.alt_hi_ft, to_ft)
        if hi > lo and s.rate_fpm > 0:
            total_s += (hi - lo) / s.rate_fpm * 60.0
    return total_s


def _altitude_after_climb(
    segs: tuple[_Segment, ...],
    from_ft: float,
    elapsed_s: float,
    cap_ft: float,
) -> float:
    """Altitude reached after climbing for `elapsed_s` from `from_ft`."""
    if elapsed_s <= 0:
        return min(from_ft, cap_ft)
    remaining_s = elapsed_s
    cur = from_ft
    for s in segs:
        if s.alt_hi_ft <= cur:
            continue
        lo = max(s.alt_lo_ft, cur)
        seg_time_s = (s.alt_hi_ft - lo) / s.rate_fpm * 60.0
        if remaining_s >= seg_time_s:
            cur = s.alt_hi_ft
            remaining_s -= seg_time_s
        else:
            cur = lo + s.rate_fpm * remaining_s / 60.0
            return min(cur, cap_ft)
    return min(cur, cap_ft)


def _altitude_after_descent(
    segs: tuple[_Segment, ...],
    from_ft: float,
    elapsed_s: float,
    floor_ft: float,
) -> float:
    """Altitude reached after descending for `elapsed_s` from `from_ft`."""
    if elapsed_s <= 0:
        return max(from_ft, floor_ft)
    remaining_s = elapsed_s
    cur = from_ft
    # Walk the table top-down so highest-altitude segment burns first.
    for s in reversed(segs):
        if s.alt_lo_ft >= cur:
            continue
        hi = min(s.alt_hi_ft, cur)
        seg_time_s = (hi - s.alt_lo_ft) / s.rate_fpm * 60.0
        if remaining_s >= seg_time_s:
            cur = s.alt_lo_ft
            remaining_s -= seg_time_s
        else:
            cur = hi - s.rate_fpm * remaining_s / 60.0
            return max(cur, floor_ft)
    return max(cur, floor_ft)


def aircraft_roc_rod(aircraft_type: str) -> tuple[float, float]:
    """Return (average ROC, average ROD) in ft/min for an aircraft type.

    Kept for callers / tests that want a single planning number. Internally
    the vertical profile uses the full segmented schedule (see
    :class:`VerticalProfile`); this function averages the schedule over
    its full altitude band and clamps to the brief's 1500–2500 ft/min
    envelope so the long-standing API contract still holds.
    """
    climb_segs, desc_segs = _segments_for(aircraft_type)

    def _avg(segs: tuple[_Segment, ...]) -> float:
        num = sum(s.rate_fpm * (s.alt_hi_ft - s.alt_lo_ft) for s in segs)
        den = sum(s.alt_hi_ft - s.alt_lo_ft for s in segs) or 1.0
        return num / den

    def _clamp(v: float) -> float:
        return max(1500.0, min(2500.0, v))

    return _clamp(_avg(climb_segs)), _clamp(_avg(desc_segs))


@dataclass(frozen=True)
class VerticalProfile:
    """Climb/cruise/descent altitude profile over a flight's timeline.

    Construct with :meth:`build`, then call :meth:`at` per trajectory
    sample to get its altitude and phase. The profile uses a BADA-style
    segmented climb/descent schedule so ROC drops realistically with
    altitude rather than a single constant rate.
    """

    total_time_s: float
    dep_elev_ft: float
    des_elev_ft: float
    cruise_alt_ft: float
    toc_time_s: float  # end of climb (Top Of Climb)
    tod_time_s: float  # start of descent (Top Of Descent)
    _climb_segs: tuple[_Segment, ...]
    _desc_segs: tuple[_Segment, ...]

    @classmethod
    def build(
        cls,
        total_time_s: float,
        rfl_ft: float,
        aircraft_type: str,
        dep_elev_ft: float,
        des_elev_ft: float,
    ) -> VerticalProfile:
        climb_segs, desc_segs = _segments_for(aircraft_type)

        climb_time = _time_to_climb(climb_segs, dep_elev_ft, rfl_ft)
        descent_time = _time_to_climb(desc_segs, des_elev_ft, rfl_ft)
        cruise_alt = rfl_ft

        if (
            total_time_s > 0
            and climb_time + descent_time >= total_time_s
        ):
            # Flight too short to reach RFL: binary-search the highest
            # cruise altitude where climb_t + descent_t fits in the slot.
            # The BADA schedule is monotonic in altitude so this is well-
            # behaved.
            lo = max(dep_elev_ft, des_elev_ft)
            hi = rfl_ft
            for _ in range(48):
                mid = (lo + hi) / 2.0
                t = _time_to_climb(climb_segs, dep_elev_ft, mid) + _time_to_climb(
                    desc_segs, des_elev_ft, mid
                )
                if t <= total_time_s:
                    lo = mid
                else:
                    hi = mid
            cruise_alt = lo
            climb_time = _time_to_climb(climb_segs, dep_elev_ft, cruise_alt)
            descent_time = _time_to_climb(desc_segs, des_elev_ft, cruise_alt)

        return cls(
            total_time_s=total_time_s,
            dep_elev_ft=dep_elev_ft,
            des_elev_ft=des_elev_ft,
            cruise_alt_ft=cruise_alt,
            toc_time_s=climb_time,
            tod_time_s=total_time_s - descent_time,
            _climb_segs=climb_segs,
            _desc_segs=desc_segs,
        )

    def at(self, elapsed_s: float) -> tuple[float, Phase]:
        """Return (altitude_ft, phase) at an elapsed time into the flight."""
        if elapsed_s <= self.toc_time_s:
            alt = _altitude_after_climb(
                self._climb_segs,
                self.dep_elev_ft,
                elapsed_s,
                self.cruise_alt_ft,
            )
            return round(alt, 1), "climb"
        if elapsed_s >= self.tod_time_s:
            time_since_tod = elapsed_s - self.tod_time_s
            alt = _altitude_after_descent(
                self._desc_segs,
                self.cruise_alt_ft,
                time_since_tod,
                self.des_elev_ft,
            )
            return round(alt, 1), "descent"
        return round(self.cruise_alt_ft, 1), "cruise"
