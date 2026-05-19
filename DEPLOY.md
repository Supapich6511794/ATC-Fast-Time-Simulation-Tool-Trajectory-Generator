# Deploying (Front-end on Vercel + API on Render)

This app is **two parts**: a Next.js front-end (`web/`) and a Python
FastAPI engine (`api/` + `trajectory_sim/`). Vercel can only host the
front-end, so the Python API is hosted on Render. Do the API first — you
need its URL for the Vercel step.

## 1. Python API → Render (do this first)

1. Push the repo to GitHub.
2. https://render.com → **New → Blueprint** → pick this repo.
   Render reads [`render.yaml`](render.yaml), installs deps, runs uvicorn.
3. Wait for the deploy to go green. Copy the service URL, e.g.
   `https://trajectory-api.onrender.com`.
4. Sanity check: open `https://trajectory-api.onrender.com/api/health` —
   it should return `{"ok":true,...}`.

> Render free tier sleeps after ~15 min idle; the first request after
> sleep takes ~30 s to wake. Fine for a demo.

## 2. Front-end → Vercel

1. https://vercel.com → **Add New → Project** → import this repo.
2. **Root Directory: `web`** ← important. The repo root is not the
   Next.js app; the app lives in `web/`. Vercel auto-detects Next.js
   from there.
3. **Environment Variables** → add:

   | Name | Value |
   |------|-------|
   | `NEXT_PUBLIC_API_BASE` | `https://trajectory-api.onrender.com` (your Render URL, no trailing slash) |

   This must be set **before** the build — `NEXT_PUBLIC_*` is inlined at
   build time.
4. Deploy. Vercel runs the `vercel-build` script (`next build`).

## 3. Wire CORS back (if you use a custom domain)

`*.vercel.app` is already allowed by the API. Only if you attach a
custom domain to the front-end: set `WEB_ORIGIN` on the Render service
to that origin (e.g. `https://flights.example.com`) and redeploy.

## Why it can't all go on Vercel

The engine uses `geopandas` / `pyproj` / `pyogrio` (GDAL-class native
libs) and runs a long-lived uvicorn server. Vercel serverless functions
can't host that within their size/runtime limits — hence the split.

## Local dev is unchanged

`npm run dev` still runs everything locally (API defaults to
`http://localhost:8000` when `NEXT_PUBLIC_API_BASE` is unset).
