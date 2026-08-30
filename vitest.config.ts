import { defineConfig } from "vitest/config";

const shared = {
  globals: true,
  setupFiles: ["src/test/setup.ts"],
  exclude: ["**/node_modules/**", "**/dist/**", "src/test/perf.test.ts"]
};

export default defineConfig({
  test: {
    // Two projects, split by what a file needs rather than by subject: jsdom's
    // per-file environment startup is the second-largest cost in the suite, so
    // pure-logic tests run in node. A `.test.ts` file that does need a DOM
    // (localStorage, window, document) carries an explicit
    // `// @vitest-environment jsdom` docblock, which still wins per file.
    projects: [
      { test: { ...shared, name: "logic", environment: "node", include: ["src/**/*.test.ts"] } },
      { test: { ...shared, name: "dom", environment: "jsdom", include: ["src/**/*.test.tsx"] } }
    ],
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
