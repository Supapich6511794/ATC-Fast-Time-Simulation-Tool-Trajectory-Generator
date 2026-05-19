# ATC Fast-Time Simulation Tool — Trajectory Generator

BearCat internship Module 1. A Python package converts ICAO flight plans into
4D WGS-84 trajectories (pyproj) for a B738 on VTBS–VTSP with
climb/cruise/descent and GeoPackage/CSV export. A FastAPI server powers a
Next.js + Leaflet web app: one-click generation, aircraft animation,
basemaps, FIR, and a route builder.

## Layout

| Path | What |
|------|------|
| `trajectory_sim/` | Core Python engine — route parsing, WGS-84 geodesy, vertical profile, GeoPackage/CSV output, tests |
| `api/` | FastAPI server exposing `trajectory_sim` to the web ([api/README.md](api/README.md)) |
| `web/` | Next.js + TypeScript + react-leaflet front-end ([web/README.md](web/README.md)) |
| `scripts/` | CLI entry points (`run_phase1.py`, `run_phase1_csv.py`) |

## Run

```bash
# 1. Python deps (virtualenv recommended)
pip install -r requirements.txt

# 2. Web deps + run API + web together
cd web
npm install
npm run dev:all       # FastAPI :8000 + Next.js :3000
```

Open http://localhost:3000.

The Python package is the canonical engine; the web is a click-driven
front-end that calls it (no duplicated logic).
