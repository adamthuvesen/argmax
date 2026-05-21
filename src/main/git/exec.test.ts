// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runGitTextAllowExitCodes } from "./exec.js";

describe("runGitTextAllowExitCodes", () => {
  it("returns stdout for allowed non-zero git exits", async () => {
    const repoPath = createCommittedGitRepo();

    const result = await runGitTextAllowExitCodes(repoPath, ["grep", "-n", "missing"], [1]);

    expect(result).toEqual({ stdout: "", exitCode: 1 });
  });

  it("throws for max-buffer failures instead of treating them as allowed exits", async () => {
    const repoPath = createCommittedGitRepo();

    await expect(
      runGitTextAllowExitCodes(repoPath, ["grep", "-n", "needle"], [1], { maxBufferBytes: 1 })
    ).rejects.toThrow(/stdout maxBuffer length exceeded/);
  });
});

function createCommittedGitRepo(): string {
  const repoPath = realpathSync(mkdtempSync(join(tmpdir(), "argmax-git-exec-")));
  git(repoPath, ["init", "--initial-branch=main"]);
  git(repoPath, ["config", "user.email", "argmax@example.test"]);
  git(repoPath, ["config", "user.name", "Argmax Test"]);
  writeFileSync(join(repoPath, "file.txt"), "needle\n");
  git(repoPath, ["add", "file.txt"]);
  git(repoPath, ["commit", "-m", "test: seed repo"]);
  return repoPath;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}
