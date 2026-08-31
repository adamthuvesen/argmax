import { describe, expect, it } from "vitest";
import { DIFF_CONTEXT_STEPS, nextDiffContext, parseUnifiedDiff } from "./diff.js";

function hunk(oldStart: number, newStart: number, body: string[]): string[] {
  return [`@@ -${oldStart},${body.length} +${newStart},${body.length} @@`, ...body];
}

describe("parseUnifiedDiff", () => {
  it("counts the unmodified lines git left out between two hunks", () => {
    const content = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      ...hunk(1, 1, [" one", "-two", "+TWO"]),
      ...hunk(20, 20, ["-twenty", "+TWENTY"])
    ].join("\n");

    const blocks = parseUnifiedDiff(content);

    // First hunk covers old lines 1–2 (context + deletion), so the gap to the
    // second hunk's line 20 is 17 lines.
    expect(blocks.map((block) => block.kind)).toEqual(["hunk", "omitted", "hunk"]);
    expect(blocks[1]).toEqual({ kind: "omitted", id: "omitted-1", count: 17 });
  });

  it("does not invent a gap across a file boundary", () => {
    // Second file's hunk starts at a lower line number than the first file's
    // last line. Carrying the previous file's end across would either fabricate
    // a gap or (with a higher start) report one that does not exist.
    const content = [
      "diff --git a/a.ts b/a.ts",
      ...hunk(100, 100, ["-a", "+A"]),
      "diff --git a/b.ts b/b.ts",
      ...hunk(200, 200, ["-b", "+B"])
    ].join("\n");

    const blocks = parseUnifiedDiff(content);

    expect(blocks.map((block) => block.kind)).toEqual(["hunk", "hunk"]);
  });

  it("reports the bytes a capped diff dropped", () => {
    const content = [
      ...hunk(1, 1, ["-a", "+A"]),
      "[diff truncated at 1048576 bytes; dropped 4096 bytes]",
      ""
    ].join("\n");

    const blocks = parseUnifiedDiff(content);

    expect(blocks.at(-1)).toEqual({ kind: "truncated", id: "truncated", droppedBytes: 4096 });
  });

  it("leaves an untruncated diff without a truncation block", () => {
    const blocks = parseUnifiedDiff(hunk(1, 1, ["-a", "+A"]).join("\n"));

    expect(blocks.some((block) => block.kind === "truncated")).toBe(false);
  });

  it("assigns both line numbers to context lines and one side to changes", () => {
    const blocks = parseUnifiedDiff(hunk(5, 9, [" keep", "-drop", "+add"]).join("\n"));

    expect(blocks[0]).toMatchObject({
      kind: "hunk",
      lines: [
        { kind: "context", oldLineNumber: 5, newLineNumber: 9, content: "keep" },
        { kind: "deletion", oldLineNumber: 6, newLineNumber: null, content: "drop" },
        { kind: "addition", oldLineNumber: null, newLineNumber: 10, content: "add" }
      ]
    });
  });
});

describe("nextDiffContext", () => {
  it("climbs the ladder from git's default and stops at the top", () => {
    const first = DIFF_CONTEXT_STEPS[0];
    const last = DIFF_CONTEXT_STEPS[DIFF_CONTEXT_STEPS.length - 1];

    expect(nextDiffContext(null)).toBe(first);
    expect(nextDiffContext(first)).toBe(last);
    expect(nextDiffContext(last)).toBeNull();
  });

  it("stays within the bound the Rust validator enforces", () => {
    // MAX_DIFF_CONTEXT_LINES in src-tauri/src/ipc/validation.rs rejects more.
    for (const step of DIFF_CONTEXT_STEPS) {
      expect(step).toBeLessThanOrEqual(100_000);
    }
  });
});
