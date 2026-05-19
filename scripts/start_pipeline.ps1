# start_pipeline.ps1 — ONE command to run the whole app on any machine.
#
# Prerequisites on the new machine (cannot be auto-installed by a script):
#   - Python 3.11+   (https://python.org)  — "Add to PATH" checked
#   - Node.js 18+    (https://nodejs.org)
#
# Everything else is bootstrapped automatically the first time:
#   - <repo>\.venv  + Python deps (pyproj, fastapi, uvicorn, ...)
#   - web\node_modules  (npm install)
#   - then starts the FastAPI API (:8000) AND the Next.js web (:3000)
#     together, with auto-restart, via `npm run dev`.
#
# Usage:  right-click -> "Run with PowerShell"
#     or:  powershell -ExecutionPolicy Bypass -File scripts\start_pipeline.ps1

$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$web  = Join-Path $repo "web"

Write-Host "=== Flight Trajectory Generator — pipeline launcher ===" -ForegroundColor Cyan

# 0. Sanity-check the two runtimes that must already exist.
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js not found. Install Node 18+ from https://nodejs.org then re-run."
    exit 1
}
if (-not ((Get-Command py -ErrorAction SilentlyContinue) -or
          (Get-Command python -ErrorAction SilentlyContinue))) {
    Write-Error "Python not found. Install Python 3.11+ from https://python.org (tick 'Add to PATH') then re-run."
    exit 1
}

# 1. Python venv + deps (no-op if already there).
& (Join-Path $PSScriptRoot "ensure-venv.ps1")
if ($LASTEXITCODE -ne 0) { exit 1 }

# 2. Web deps (no-op if node_modules already there).
if (-not (Test-Path (Join-Path $web "node_modules"))) {
    Write-Host "[setup] Installing web dependencies (one-time) ..." -ForegroundColor Cyan
    Push-Location $web
    npm install
    Pop-Location
}

# 3. Start API + web together (auto-restart). Ctrl+C stops both.
Write-Host "[run] Starting API (:8000) + web (:3000). Open http://localhost:3000" -ForegroundColor Green
Push-Location $web
npm run dev
Pop-Location
