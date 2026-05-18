import { describe, expect, it } from "vitest";
import { interpretFileChange, synthesizeHunk } from "./fileChange.js";

function firstChange(name: string, input: Record<string, unknown>) {
  const result = interpretFileChange(name, input);
  if (!result || result.length === 0) {
    throw new Error(`interpretFileChange(${name}) returned no changes`);
  }
  const change = result[0];
  if (!change) throw new Error("missing change[0]");
  return { result, change };
}

describe("synthesizeHunk", () => {
  it("creates an all-additions hunk when old is empty", () => {
    const { diff, adds, dels } = synthesizeHunk("", "a\nb\nc");
    expect(diff.startsWith("@@ -0,0 +1,3 @@")).toBe(true);
    expect(diff).toContain("+a");
    expect(diff).toContain("+c");
    expect(adds).toBe(3);
    expect(dels).toBe(0);
  });

  it("creates an all-deletions hunk when new is empty", () => {
    const { diff, adds, dels } = synthesizeHunk("x\ny", "");
    expect(diff.startsWith("@@ -1,2 +0,0 @@")).toBe(true);
    expect(diff).toContain("-x");
    expect(diff).toContain("-y");
    expect(adds).toBe(0);
    expect(dels).toBe(2);
  });

  it("pairs deletions before additions for a replace", () => {
    const { diff, adds, dels } = synthesizeHunk("old1\nold2", "new1\nnew2\nnew3");
    expect(diff).toMatch(/@@ -1,2 \+1,3 @@/);
    expect(diff.indexOf("-old1")).toBeLessThan(diff.indexOf("+new1"));
    expect(adds).toBe(3);
    expect(dels).toBe(2);
  });
});

describe("interpretFileChange — Claude Write", () => {
  it("returns a single create change with parsed hunks", () => {
    const { result, change } = firstChange("Write", {
      file_path: "/tmp/poem.md",
      content: "line1\nline2\nline3"
    });
    expect(result).toHaveLength(1);
    expect(change.kind).toBe("create");
    if (change.kind !== "create") return;
    expect(change.path).toBe("/tmp/poem.md");
    expect(change.addCount).toBe(3);
    expect(change.hunks.length).toBeGreaterThan(0);
  });

  it("flags binary content via a NUL byte", () => {
    const { change } = firstChange("Write", {
      file_path: "/tmp/img.bin",
      content: "abc\x00def"
    });
    if (change.kind !== "create") throw new Error("bad kind");
    expect(change.hunks).toHaveLength(0);
    expect(change.note).toMatch(/binary/i);
  });

  it("flags very large content", () => {
    const big = "x".repeat(300_000);
    const { change } = firstChange("Write", { file_path: "/tmp/big.txt", content: big });
    if (change.kind !== "create") throw new Error("bad kind");
    expect(change.hunks).toHaveLength(0);
    expect(change.note).toMatch(/too large/i);
  });
});

describe("interpretFileChange — Claude Edit", () => {
  it("returns one edit hunk with correct counts", () => {
    const { change } = firstChange("Edit", {
      file_path: "/tmp/a.ts",
      old_string: "foo\nbar",
      new_string: "FOO\nBAR\nBAZ"
    });
    expect(change.kind).toBe("edit");
    if (change.kind !== "edit") return;
    expect(change.addCount).toBe(3);
    expect(change.delCount).toBe(2);
  });

  it("marks replace_all with a note", () => {
    const { change } = firstChange("Edit", {
      file_path: "/tmp/a.ts",
      old_string: "x",
      new_string: "y",
      replace_all: true
    });
    if (change.kind !== "edit") throw new Error("bad kind");
    expect(change.note).toMatch(/all matches/i);
  });

  it("returns null when both old and new strings are empty", () => {
    expect(
      interpretFileChange("Edit", { file_path: "/tmp/a.ts", old_string: "", new_string: "" })
    ).toBeNull();
  });
});

describe("interpretFileChange — MultiEdit", () => {
  it("collects one hunk per edit and drops line numbers", () => {
    const { change } = firstChange("MultiEdit", {
      file_path: "/tmp/a.ts",
      edits: [
        { old_string: "a", new_string: "A" },
        { old_string: "b\nb2", new_string: "B" },
        { old_string: "", new_string: "appended" }
      ]
    });
    if (change.kind !== "edit") throw new Error("bad kind");
    expect(change.hunks.length).toBe(3);
    expect(change.noLineNumbers).toBe(true);
    expect(change.addCount).toBe(3); // 1 + 1 + 1
    expect(change.delCount).toBe(3); // 1 + 2 + 0
  });
});

describe("interpretFileChange — Codex file_change", () => {
  it("expands a multi-file changes array", () => {
    const result = interpretFileChange("file_change", {
      changes: [
        { path: "a.ts", kind: "add", add: { content: "hi\nthere" } },
        {
          path: "b.ts",
          kind: "update",
          update: { unified_diff: "@@ -1,1 +1,1 @@\n-old\n+new" }
        },
        { path: "c.ts", kind: "delete" }
      ]
    });
    if (!result) throw new Error("no result");
    expect(result).toHaveLength(3);
    expect(result[0]?.kind).toBe("create");
    expect(result[1]?.kind).toBe("edit");
    expect(result[2]?.kind).toBe("delete");
  });

  it("falls back to before/after when no unified_diff is present", () => {
    const { change } = firstChange("file_change", {
      changes: [{ path: "x.ts", kind: "update", before: "a", after: "b" }]
    });
    if (change.kind !== "edit") throw new Error("bad kind");
    expect(change.addCount).toBe(1);
    expect(change.delCount).toBe(1);
  });

  it("returns null when changes is empty or missing", () => {
    expect(interpretFileChange("file_change", {})).toBeNull();
    expect(interpretFileChange("file_change", { changes: [] })).toBeNull();
  });
});

describe("interpretFileChange — Cursor", () => {
  it("recognises writeToolCall", () => {
    const { change } = firstChange("writeToolCall", { path: "x.ts", content: "hello" });
    expect(change.kind).toBe("create");
  });

  it("recognises editToolCall", () => {
    const { change } = firstChange("editToolCall", {
      path: "x.ts",
      old_string: "a",
      new_string: "b"
    });
    expect(change.kind).toBe("edit");
  });

  it("recognises deleteToolCall", () => {
    const { change } = firstChange("deleteToolCall", { path: "x.ts" });
    expect(change.kind).toBe("delete");
  });
});

describe("interpretFileChange — fallback", () => {
  it("returns null for unrecognised tools", () => {
    expect(interpretFileChange("Read", { file_path: "x.ts" })).toBeNull();
    expect(interpretFileChange("Bash", { command: "ls" })).toBeNull();
    expect(interpretFileChange("Grep", { pattern: "foo" })).toBeNull();
    expect(interpretFileChange("NotebookEdit", { notebook_path: "x.ipynb" })).toBeNull();
  });

  it("returns null when path is missing", () => {
    expect(interpretFileChange("Write", { content: "hi" })).toBeNull();
  });
});

