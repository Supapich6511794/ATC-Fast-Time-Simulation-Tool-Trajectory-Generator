"""Aircraft vertical performance — Phase 2 (simplified, B738).

Builds a climb → cruise → descent altitude profile and labels each
trajectory sample's flight phase.

This is a deliberately simple, dependency-free model: constant ROC/ROD
within the brief's 1500–2500 ft/min band and a flat cruise at the
Requested Flight Level. It is structured behind `aircraft_roc_rod()` so a
more realistic backend (e.g. `openap` / BADA 3 for B738) can be slotted in
later **without touching callers** — only that function changes.

Units: altitude in feet, rates in ft/min, time in seconds.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

#: Flight phase along the vertical profile.
Phase = Literal["climb", "cruise", "descent"]

# Speed scheduling is Phase 3; here we only model the vertical dimension.

# Simplified B738 climb/descent rates. Mid-band values from the brief's
# 1500–2500 ft/min range (a real B738 climbs faster low, slower high; a
# single average is adequate for Phase 2 and is what `openap` would refine).
_B738_ROC_FPM = 2200.0
_B738_ROD_FPM = 1800.0

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


def aircraft_roc_rod(aircraft_type: str) -> tuple[float, float]:
    """Return (ROC, ROD) in ft/min for an aircraft type.

    Seam for a future `openap`/BADA backend: replace the body with a
    performance-model lookup keyed on `aircraft_type`; the return contract
    (a clamped ROC/ROD pair) stays the same so nothing else changes.
    """
    # Single airframe in scope for the whole internship.
    roc, rod = _B738_ROC_FPM, _B738_ROD_FPM

    def clamp(v: float) -> float:
        # Keep within the brief's stated envelope regardless of backend.
        return max(1500.0, min(2500.0, v))

    return clamp(roc), clamp(rod)


@dataclass(frozen=True)
class VerticalProfile:
    """Climb/cruise/descent altitude profile over a flight's timeline.

    Construct with :meth:`build`, then call :meth:`at` per trajectory
    sample to get its altitude and phase.
    """

    total_time_s: float
    dep_elev_ft: float
    des_elev_ft: float
    cruise_alt_ft: float
    toc_time_s: float  # end of climb (Top Of Climb)
    tod_time_s: float  # start of descent (Top Of Descent)
    roc_fps: float
    rod_fps: float

    @classmethod
    def build(
        cls,
        total_time_s: float,
        rfl_ft: float,
        aircraft_type: str,
        dep_elev_ft: float,
        des_elev_ft: float,
    ) -> VerticalProfile:
        roc_fpm, rod_fpm = aircraft_roc_rod(aircraft_type)
        roc_fps = roc_fpm / 60.0
        rod_fps = rod_fpm / 60.0

        climb_time = max(0.0, (rfl_ft - dep_elev_ft) / roc_fps)
        descent_time = max(0.0, (rfl_ft - des_elev_ft) / rod_fps)

        cruise_alt = rfl_ft
        if climb_time + descent_time >= total_time_s and total_time_s > 0:
            # Flight too short to reach RFL: shrink climb/descent
            # proportionally; the aircraft tops out where they meet.
            scale = total_time_s / (climb_time + descent_time)
            climb_time *= scale
            descent_time *= scale
            cruise_alt = dep_elev_ft + roc_fps * climb_time

        return cls(
            total_time_s=total_time_s,
            dep_elev_ft=dep_elev_ft,
            des_elev_ft=des_elev_ft,
            cruise_alt_ft=cruise_alt,
            toc_time_s=climb_time,
            tod_time_s=total_time_s - descent_time,
            roc_fps=roc_fps,
            rod_fps=rod_fps,
        )

    def at(self, elapsed_s: float) -> tuple[float, Phase]:
        """Return (altitude_ft, phase) at an elapsed time into the flight."""
        if elapsed_s <= self.toc_time_s:
            alt = self.dep_elev_ft + self.roc_fps * elapsed_s
            return round(min(alt, self.cruise_alt_ft), 1), "climb"
        if elapsed_s >= self.tod_time_s:
            remaining = max(0.0, self.total_time_s - elapsed_s)
            alt = self.des_elev_ft + self.rod_fps * remaining
            return round(min(alt, self.cruise_alt_ft), 1), "descent"
        return round(self.cruise_alt_ft, 1), "cruise"
