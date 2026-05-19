# Trajectory API (FastAPI)

Thin HTTP wrapper so the web app can run the **real** `trajectory_sim`
Phase 1 pipeline (route parsing, `pyproj.Geod` WGS-84 geodesy, GeoPackage /
CSV export). No geodesy is re-implemented here — this just calls the
canonical Python package.

## Run

From the **project root**, with the virtualenv's Python:

```powershell
# Windows PowerShell
$env:PYTHONPATH = (Get-Location).Path
.venv\Scripts\python.exe -m uvicorn api.server:app --reload --port 8000
```

```bash
# bash
PYTHONPATH=. .venv/Scripts/python -m uvicorn api.server:app --reload --port 8000
```

Health check: <http://localhost:8000/api/health>

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/api/health` | liveness + data-file presence |
| POST | `/api/generate` | run pipeline → stats + route + points + download URLs |
| GET  | `/api/download/{flight_key}.{gpkg\|csv\|geojson}` | fetch a generated file |

`POST /api/generate` body:

```json
{
  "source": "csv",            // "csv" or "fpl"
  "vtsp_to_vtbs": true,        // CSV direction
  "route": "DCT MOTNA DCT ...",// FPL mode only
  "callsign": "SIM738",
  "eobt": "2026-01-03T08:15:00", // ISO, naive = UTC
  "gs_kt": 450
}
```

Generated files are written to `api/_outputs/` (git-ignored). The `.gpkg`
is the genuine Phase 1 deliverable artefact written by
`trajectory_sim.output.write_geopackage`.

## Notes

- CORS is open to `http://localhost:3000` (the Next.js dev server). If Next
  falls back to another port, add it in `api/server.py`.
- `source="fpl"` resolves idents against `airway_waypoint.geojson` (its own
  real coordinates) since the real `bearcat_navdata.gpkg` isn't delivered
  yet; swap to `NavData` when it arrives.
