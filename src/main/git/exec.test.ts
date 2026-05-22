// @vitest-environment node
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runGit } from "../../test/gitTestUtils.js";
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
  runGit(repoPath, ["init", "--initial-branch=main"]);
  runGit(repoPath, ["config", "user.email", "argmax@example.test"]);
  runGit(repoPath, ["config", "user.name", "Argmax Test"]);
  writeFileSync(join(repoPath, "file.txt"), "needle\n");
  runGit(repoPath, ["add", "file.txt"]);
  runGit(repoPath, ["commit", "-m", "test: seed repo"]);
  return repoPath;
}
