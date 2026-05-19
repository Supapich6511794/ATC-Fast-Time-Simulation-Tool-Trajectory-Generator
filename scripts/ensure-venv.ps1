# ensure-venv.ps1 — make sure the Python side is ready before the API starts.
#
# Runs automatically via the "predev" npm hook (and from start_pipeline.ps1).
# Fast no-op when the venv already exists, so it is safe to run every time.
#
#   - Creates  <repo>\.venv  if missing  (python -m venv)
#   - pip installs requirements.txt into it the first time
#
# The web's "dev:api" script launches  .venv\Scripts\uvicorn.exe , so this is
# the one thing a fresh machine needs set up before `npm run dev` works.

$ErrorActionPreference = "Stop"

# Repo root = parent of this scripts/ folder.
$repo  = Split-Path -Parent $PSScriptRoot
$venv  = Join-Path $repo ".venv"
$reqs  = Join-Path $repo "requirements.txt"
$uvic  = Join-Path $venv "Scripts\uvicorn.exe"

if (Test-Path $uvic) {
    # Already provisioned — nothing to do.
    exit 0
}

# Find a Python interpreter (prefer the launcher, then python on PATH).
$py = $null
foreach ($cand in @("py", "python", "python3")) {
    if (Get-Command $cand -ErrorAction SilentlyContinue) { $py = $cand; break }
}
if (-not $py) {
    Write-Error "Python not found on this machine. Install Python 3.11+ and reopen the terminal."
    exit 1
}

Write-Host "[setup] Creating Python venv at $venv ..." -ForegroundColor Cyan
& $py -m venv $venv
if ($LASTEXITCODE -ne 0) { Write-Error "Failed to create venv."; exit 1 }

$venvPy = Join-Path $venv "Scripts\python.exe"
Write-Host "[setup] Installing Python dependencies (one-time) ..." -ForegroundColor Cyan
& $venvPy -m pip install --upgrade pip
& $venvPy -m pip install -r $reqs
if ($LASTEXITCODE -ne 0) { Write-Error "pip install failed."; exit 1 }

Write-Host "[setup] Python environment ready." -ForegroundColor Green
exit 0
