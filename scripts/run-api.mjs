// run-api.mjs — launch the FastAPI server from the venv, cross-platform.
//
// Replaces the Windows-only npm script `.venv\Scripts\uvicorn.exe ...` so the
// same `npm run dev:api` works on macOS/Linux (.venv/bin) and Windows
// (.venv\Scripts). Spawned with shell:false so paths with spaces are safe.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const isWin = process.platform === "win32";
const uvicorn = join(repo, ".venv", isWin ? "Scripts" : "bin", isWin ? "uvicorn.exe" : "uvicorn");

const r = spawnSync(uvicorn, ["api.server:app", "--reload", "--port", "8000"], {
  cwd: repo,
  stdio: "inherit",
});
process.exit(r.status ?? 1);
