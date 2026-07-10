"""Shared runway / threshold-elevation helpers for the dummy-flight generators.

Keeps every generator consistent with the web app + trajectory engine:
  * procedures carry the concrete ``RW…`` transition (e.g. OLVU1B -> RW03L),
  * the ARINC "both parallels" code (RWxxB, e.g. a STAR serving 21L/21R) is
    expanded to a real side so it matches the app's L/R runway picker and the
    threshold table,
  * the Thai AIP AD 2 threshold table drives the departure/arrival elevations.

Import from a generator that lives in this ``scripts/`` directory:

    from _dummy_procs import load_proc_runways, load_thr_elevs, make_expand_runway
"""

from __future__ import annotations

import csv
import json
import re
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
THR_ELEV_PATH = _ROOT / "thai_aip_ad2_thr_elevations.csv"


def load_proc_runways(path: Path) -> tuple[dict[str, list[str]], dict[tuple, str]]:
    """Return ``(airport -> sorted procedure names, (airport, proc) -> runway)``.

    The runway is the first ``RW…`` transition_identifier on that procedure
    (e.g. OLVU1B -> "RW03L"); enroute-transition fixes are ignored for this.
    """
    names: dict[str, set[str]] = {}
    rwy: dict[tuple, str] = {}
    try:
        gj = json.loads(Path(path).read_text(encoding="utf-8"))
    except OSError:
        return {}, {}
    for f in gj.get("features", []):
        p = f.get("properties") or {}
        a, pr = p.get("airport_identifier"), p.get("procedure_identifier")
        tr = p.get("transition_identifier")
        if a and pr:
            names.setdefault(a, set()).add(pr)
            if tr and str(tr).upper().startswith("RW"):
                rwy.setdefault((a, pr), str(tr).upper())
    return {k: sorted(v) for k, v in names.items()}, rwy


def load_thr_elevs() -> dict[tuple[str, str], float]:
    """``(ICAO, bare-runway) -> threshold elevation (ft)`` from the Thai AIP AD 2
    table, e.g. ``("VTSP", "09") -> 22.0``, ``("VTBD", "21L") -> 6.4``."""
    thr: dict[tuple[str, str], float] = {}
    try:
        with THR_ELEV_PATH.open(encoding="utf-8-sig", newline="") as fh:
            for row in csv.DictReader(fh):
                icao = (row.get("ICAO") or "").strip().upper()
                rwy = (row.get("RWY_NR") or "").strip().upper()
                raw = (row.get("THR_elev_ft") or "").strip()
                if not icao or not rwy or not raw:
                    continue
                try:
                    thr[(icao, rwy)] = float(raw)
                except ValueError:
                    pass
    except OSError:
        pass
    return thr


def make_expand_runway(thr: dict[tuple[str, str], float]):
    """Build an expander resolving an ARINC "both parallels" runway (RWxxB) to
    a concrete side present in the threshold table (L first). A STAR serving
    21L/21R is coded RW21B; the app lists RW21L/RW21R and the threshold table
    is keyed per side, so the dummy must pick a real side. Non-B idents pass
    through unchanged."""

    def expand(icao: str, rwy: str) -> str:
        m = re.match(r"^RW(\d{2})B$", (rwy or "").upper())
        if not m:
            return rwy
        num = m.group(1)
        for side in ("L", "R"):
            if (icao.upper(), num + side) in thr:
                return f"RW{num}{side}"
        return f"RW{num}L"

    return expand
