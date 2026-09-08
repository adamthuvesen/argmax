import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "argmax-precheck # "));
  temporaryDirectories.push(directory);
  const repository = path.join(directory, "repo");
  const bin = path.join(directory, "bin");
  const log = path.join(directory, "checks.log");
  for (const name of ["scripts", "src", ".github/workflows"]) mkdirSync(path.join(repository, name), { recursive: true });
  mkdirSync(bin);
  writeFileSync(log, "");
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    PRECHECK_TEST_LOG: log,
  };
  const stub = `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nappendFileSync(process.env.PRECHECK_TEST_LOG, process.argv.slice(1).join(" ") + "\\n");\n`;
  writeFileSync(path.join(bin, "package.json"), '{"type":"module"}');
  for (const command of ["npx", "cargo"]) writeFileSync(path.join(bin, command), stub, { mode: 0o755 });
  const files = ["src/café.ts", "vite.config.ts", ".github/workflows/ci.yml"];
  for (const name of files) writeFileSync(path.join(repository, name), "initial\n");
  for (const name of ["check-tauri-bridge.mjs", "check-main-thread-handlers.mjs", "check-bundle.mjs"]) {
    writeFileSync(path.join(repository, "scripts", name), stub);
  }
  writeFileSync(path.join(repository, "scripts/precheck.mjs"), readFileSync(new URL("../../scripts/precheck.mjs", import.meta.url)));
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["add", "scripts", ...files],
    ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--no-gpg-sign", "-qm", "fixture"],
  ]) {
    const result = spawnSync("git", args, { cwd: repository, env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  }
  return {
    change(name: string) { writeFileSync(path.join(repository, name), "changed\n"); },
    run(base = "HEAD") {
      const result = spawnSync(process.execPath, ["scripts/precheck.mjs", "--base", base], { cwd: repository, env, encoding: "utf8" });
      return { ...result, checks: readFileSync(log, "utf8") };
    },
  };
}

describe("precheck CLI", () => {
  it.each([
    ["src/café.ts", ["eslint", "vite build", "check-bundle.mjs"]],
    [".github/workflows/ci.yml", ["eslint", "cargo test", "check-bundle.mjs"]],
    ["vite.config.ts", ["vite build", "check-bundle.mjs"]],
  ])("selects checks for %s in a checkout with spaces and #", (name, checks) => {
    const repo = fixture();
    repo.change(name);
    const result = repo.run();
    expect(result.status, result.stderr).toBe(0);
    for (const check of checks) expect(result.checks).toContain(check);
  });

  it("rejects an invalid explicit base before running checks", () => {
    const repo = fixture();
    const result = repo.run("does-not-exist");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("cannot find a merge base");
    expect(result.checks).toBe("");
  });
});
