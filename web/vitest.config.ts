import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Vitest config for the pure TypeScript units (currently the CD&R engine in
 * lib/cdr). Tests run in a Node environment — the engine is DOM-free — and the
 * "@/…" alias mirrors tsconfig.json so test imports match app imports.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
  },
});
