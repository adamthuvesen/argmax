// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The test lives in src/test; the script under test lives in scripts/.
const SCRIPT = resolve(process.cwd(), "scripts/check-bundle-size.mjs");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "argmax-bundle-check-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runWith(envOverrides = {}) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, BUNDLE_ASSETS_DIR: dir, ...envOverrides },
    encoding: "utf8"
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

describe("check-bundle-size", () => {
  it("passes when the main chunk is under budget", () => {
    writeFileSync(join(dir, "index-abc123.js"), "x".repeat(1024 * 1024)); // 1 MB
    writeFileSync(join(dir, "CommandPalette-xyz.js"), "x".repeat(4_000));

    const result = runWith({ BUNDLE_BUDGET_MB: "2.0" });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("main (index-abc123.js)");
    expect(result.stdout).toContain("OK");
  });

  it("fails when the main chunk exceeds the budget", () => {
    // 3.0 MB main against a 2.0 MB budget.
    writeFileSync(join(dir, "index-too-big.js"), "x".repeat(3 * 1024 * 1024));

    const result = runWith({ BUNDLE_BUDGET_MB: "2.0" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("exceeds 2.00 MB budget");
  });

  it("respects a higher budget set via BUNDLE_BUDGET_MB", () => {
    writeFileSync(join(dir, "index-big.js"), "x".repeat(2.5 * 1024 * 1024));

    const tight = runWith({ BUNDLE_BUDGET_MB: "2.0" });
    expect(tight.code).toBe(1);

    const loose = runWith({ BUNDLE_BUDGET_MB: "3.0" });
    expect(loose.code).toBe(0);
  });

  it("fails when no main chunk exists", () => {
    writeFileSync(join(dir, "OtherChunk-abc.js"), "x");

    const result = runWith({ BUNDLE_BUDGET_MB: "2.0" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no main chunk");
  });

  it("fails with a helpful message when the dist directory is empty", () => {
    const result = runWith({ BUNDLE_BUDGET_MB: "2.0" });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/no .js files|could not read/);
  });
});
