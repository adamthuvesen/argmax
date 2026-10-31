import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture({ cargo = true, typescript = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "argmax-changed-"));
  directories.push(root);
  for (const directory of [
    "scripts",
    "bin",
    "src-tauri/src",
    "src",
    "node_modules/typescript/bin",
    "node_modules/dependency-cruiser/bin"
  ]) {
    mkdirSync(path.join(root, directory), { recursive: true });
  }
  writeFileSync(
    path.join(root, "scripts/check-changed.mjs"),
    readFileSync(new URL("../../scripts/check-changed.mjs", import.meta.url))
  );
  writeFileSync(path.join(root, "scripts/generated-files.json"), "[]");
  writeFileSync(path.join(root, "scripts/check-rust-boundaries.mjs"), "");
  writeFileSync(path.join(root, "scripts/lint.mjs"), "");
  writeFileSync(path.join(root, "scripts/typescript-5-hook.mjs"), "");
  writeFileSync(path.join(root, "node_modules/dependency-cruiser/bin/dependency-cruiser.mjs"), "");
  writeFileSync(path.join(root, "src-tauri/src/owned.rs"), "");
  writeFileSync(path.join(root, "src/owned.ts"), "");
  const stub = (file: string, body: string) =>
    writeFileSync(path.join(root, file), `#!${process.execPath}\n${body}`, { mode: 0o755 });
  stub("bin/rustfmt", "");
  stub("bin/npx", "");
  stub("bin/git", "process.exit(1)");
  if (cargo) {
    stub(
      "bin/cargo",
      'if (process.env.CHECK_SIGNAL) process.kill(process.pid, "SIGTERM"); process.stderr.write(process.env.CHECK_OUTPUT ?? ""); process.exit(1);'
    );
  }
  if (typescript)
    stub("node_modules/typescript/bin/tsc", 'process.stderr.write(process.env.CHECK_OUTPUT ?? ""); process.exit(1);');
  return (file: string, output = "", signal = false) =>
    spawnSync(process.execPath, ["scripts/check-changed.mjs", file], {
      cwd: root,
      env: { ...process.env, PATH: path.join(root, "bin"), CHECK_OUTPUT: output, CHECK_SIGNAL: signal ? "1" : "" },
      encoding: "utf8"
    });
}

describe("changed checks", () => {
  it("fails with an actionable launch error when cargo is missing", () => {
    const result = fixture({ cargo: false })("src-tauri/src/owned.rs");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cargo check could not run:");
    expect(result.stderr).toContain("ENOENT");
    expect(result.stdout).not.toContain("pass");
  });

  it("reports a terminated compiler", () => {
    const result = fixture()("src-tauri/src/owned.rs", "", true);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cargo check stopped by SIGTERM");
  });

  it.each([
    "error: failed to run custom build command for `app`",
    "error: failed to get `tauri` as a dependency",
    "compiler failed without a source diagnostic"
  ])("preserves non-source Cargo failure: %s", (output) => {
    const result = fixture()("src-tauri/src/owned.rs", output);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(output);
  });

  it("reports owned source errors", () => {
    const output = "src/owned.rs:1:1: error[E0308]: mismatched types";
    const result = fixture()("src-tauri/src/owned.rs", output);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(output);
  });

  it("filters a peer's unfinished source errors and their compiler summary", () => {
    const output =
      "src/peer.rs:1:1: error[E0308]: mismatched types\nerror: could not compile `app` (lib) due to 1 previous error";
    expect(fixture()("src-tauri/src/owned.rs", output).status).toBe(0);
  });

  it("keeps global errors when a peer also has a source error", () => {
    const output = "src/peer.rs:1:1: error[E0308]: mismatched types\nerror: failed to run custom build command";
    const result = fixture()("src-tauri/src/owned.rs", output);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("error: failed to run custom build command");
  });

  it("fails when the TypeScript compiler cannot load", () => {
    const result = fixture({ typescript: false })("src/owned.ts");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Cannot find module");
  });

  it.each([
    "error TS5083: Cannot read file 'tsconfig.json'.",
    "Error: Cannot find module 'typescript'",
    "compiler crashed"
  ])("preserves non-source TypeScript failure: %s", (output) => {
    const result = fixture()("src/owned.ts", output);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(output);
  });

  it("keeps the TypeScript file filter", () => {
    const run = fixture();
    expect(run("src/owned.ts", "src/peer.ts(1,1): error TS2322: Type mismatch").status).toBe(0);
    const owned = "src/owned.ts(1,1): error TS2322: Type mismatch";
    expect(run("src/owned.ts", owned).stderr).toContain(owned);
  });
});
