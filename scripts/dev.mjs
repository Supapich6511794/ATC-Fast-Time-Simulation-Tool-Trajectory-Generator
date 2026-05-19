// dev.mjs — zero-dependency bootstrap launcher for `npm run dev`.
//
// Why this exists: on a fresh machine `npm run dev` would normally fail
// because the `dev` command itself uses `concurrently` (a devDependency)
// which isn't there until `npm install` has run. This script needs nothing
// but Node + Python already on PATH, so `npm run dev` works on the very
// first run with no extra commands:
//
//   1. web/node_modules missing  -> `npm install`
//   2. <repo>/.venv missing      -> create venv + pip install (ensure-venv.ps1)
//   3. start API + web together with auto-restart (npm run dev:serve)
//
// Each step is a fast no-op once provisioned, so it is safe every run.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repo = dirname(scriptsDir);
const web = join(repo, "web");

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: true });
  if (r.status !== 0) {
    console.error(`\n[dev] step failed: ${cmd} ${args.join(" ")}`);
    process.exit(r.status ?? 1);
  }
}

// 1. Web dependencies.
if (!existsSync(join(web, "node_modules"))) {
  console.log("[setup] Installing web dependencies (one-time) ...");
  run("npm", ["install"], web);
}

// 2. Python venv + deps (ensure-venv.ps1 self-skips if already present).
run(
  "powershell",
  [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(scriptsDir, "ensure-venv.ps1"),
  ],
  repo,
);

// 3. Start API + web together (auto-restart). Ctrl+C stops both.
console.log("[run] Starting API (:8000) + web (:3000). Open http://localhost:3000");
run("npm", ["run", "dev:serve"], web);
