# Flight Trajectory Generator — Web UI

Click-driven front-end for **Phase 1** of the BearCat trajectory generator.
A user picks a route, presses one button, and gets a trajectory on an
interactive map plus GeoPackage / CSV / GeoJSON downloads — no code, no
terminal.

The web does **no trajectory math**. It calls the Python FastAPI server,
which runs the real `trajectory_sim` package (route parsing,
`pyproj.Geod` WGS-84 geodesy, GeoPackage export). **One engine.**

## Stack

| Concern   | Choice                          |
| --------- | ------------------------------- |
| Framework | Next.js 14 (App Router)         |
| Language  | TypeScript (strict)             |
| Map       | Leaflet 1.9 via react-leaflet 4 |
| Compute   | Python FastAPI → `trajectory_sim` |

## Run (two processes)

**1 — Python API** (from the project root, venv Python):

```powershell
$env:PYTHONPATH = (Get-Location).Path
.venv\Scripts\python.exe -m uvicorn api.server:app --reload --port 8000
```

**2 — Web** (from `web/`):

```bash
npm install   # first time only
npm run dev
```

Open the printed URL (http://localhost:3000, or :3001 if 3000 is busy).
If the API runs somewhere else, set `NEXT_PUBLIC_API_BASE` before `npm run dev`.

## Architecture

```
Browser (Next.js, :3000)
  └─ GeneratorPanel  ── POST /api/generate ──►  FastAPI (:8000)
                                                   └─ trajectory_sim
                                                      parse_route → navdata
                                                      → pyproj geodesy
                                                      → build_trajectory_gdf
                                                      → write_geopackage/csv
  ◄── stats + points + download URLs ───────────────┘
  └─ LeafletMap renders the trajectory; download links hit the API
```

- Leaflet still loads via `next/dynamic({ ssr:false })` inside the
  `MapApp` client component (App Router requirement).
- `lib/api.ts` is the only backend touchpoint; `lib/trajectory/types.ts`
  holds the shared result shape. The earlier client-side TS pipeline was
  removed so there is exactly one implementation (Python).

## Data

`public/data/` holds the inputs the API reads:

- `VTPStoVTBS.csv` — pre-resolved airway-Y8 legs (CSV route source).
- `airway_waypoint.geojson` — airway network; drawn faint on the map as
  reference, and used to resolve idents in FPL mode.

See [`../api/README.md`](../api/README.md) for the API contract.
