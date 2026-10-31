// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

function commitMsg(message: string) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "argmax-commit-msg-")), "COMMIT_EDITMSG");
  writeFileSync(file, message);
  return spawnSync("sh", [".githooks/commit-msg", file], { encoding: "utf8" });
}

describe(".githooks/commit-msg", () => {
  it("refuses an AI attribution trailer", () => {
    const result = commitMsg("fix(chat): keep focus\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("remove the AI attribution line");
  });

  it("accepts a plain message", () => {
    expect(commitMsg("fix(chat): keep focus\n\nCo-Authored-By: Adam <a@example.com>\n").status).toBe(0);
  });
});
