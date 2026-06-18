import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["src/test/setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["**/node_modules/**", "**/dist/**", "src/test/perf.test.ts"],
    // Coverage is a report, not a gate — no thresholds. CI prints the
    // text-summary; the json-summary is there for tooling that wants numbers.
    // Scope to the logic worth tracking (shared types + renderer lib helpers),
    // not React components, which renderer tests cover by behavior.
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      include: ["src/shared/**", "src/renderer/lib/**"]
    }
  }
});
