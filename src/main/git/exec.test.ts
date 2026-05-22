// @vitest-environment node
import { describe, expect, it } from "vitest";
import { seedGitRepo } from "../../test/gitTestUtils.js";
import { runGitTextAllowExitCodes } from "./exec.js";

describe("runGitTextAllowExitCodes", () => {
  it("returns stdout for allowed non-zero git exits", async () => {
    const repoPath = seedGitRepo({
      prefix: "argmax-git-exec-",
      files: [{ path: "file.txt", contents: "needle\n" }]
    });

    const result = await runGitTextAllowExitCodes(repoPath, ["grep", "-n", "missing"], [1]);

    expect(result).toEqual({ stdout: "", exitCode: 1 });
  });

  it("throws for max-buffer failures instead of treating them as allowed exits", async () => {
    const repoPath = seedGitRepo({
      prefix: "argmax-git-exec-",
      files: [{ path: "file.txt", contents: "needle\n" }]
    });

    await expect(
      runGitTextAllowExitCodes(repoPath, ["grep", "-n", "needle"], [1], { maxBufferBytes: 1 })
    ).rejects.toThrow(/stdout maxBuffer length exceeded/);
  });
});
