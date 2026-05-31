// next.mjs — cross-platform `next build` / `next start` for production.
//
// Replaces the Windows-only `set NEXT_DIST_DIR=.next-build&& next ...` scripts.
// Runs Next's bin with the current Node (so no .cmd/.exe path differences) and
// sets NEXT_DIST_DIR so the prod build/output stays separate from the dev
// server's .next. Usage: node ../scripts/next.mjs <build|start>  (cwd = web/).

import { spawnSync } from "node:child_process";
import { join } from "node:path";

const sub = process.argv[2];
if (sub !== "build" && sub !== "start") {
  console.error(`next.mjs: expected "build" or "start", got "${sub ?? ""}"`);
  process.exit(2);
}

const webDir = process.cwd(); // npm runs this with cwd = web/
const nextBin = join(webDir, "node_modules", "next", "dist", "bin", "next");

const r = spawnSync(process.execPath, [nextBin, sub], {
  cwd: webDir,
  stdio: "inherit",
  env: { ...process.env, NEXT_DIST_DIR: ".next-build" },
});
process.exit(r.status ?? 1);
