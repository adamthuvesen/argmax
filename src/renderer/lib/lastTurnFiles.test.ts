import { describe, expect, it } from "vitest";
import type { ChangedFileSummary, EventType, TimelineEvent } from "../../shared/types.js";
import { filterToLastTurn, lastTurnEditedPaths } from "./lastTurnFiles.js";

function event(id: string, type: EventType, payload: Record<string, unknown> = {}): TimelineEvent {
  return { id, sessionId: "s1", type, message: id, payload, createdAt: "2026-05-12T15:00:00.000Z" };
}

function toolStart(id: string, name: string, input: Record<string, unknown>): TimelineEvent {
  return event(id, "command.started", { type: "tool_use", id, name, input });
}

function changed(path: string): ChangedFileSummary {
  return { path, status: "M", additions: 1, deletions: 0 };
}

// Events arrive newest-first, so the newest `user.message` ends the scan.
describe("lastTurnEditedPaths", () => {
  it("collects writes since the newest user message across providers", () => {
    expect(
      lastTurnEditedPaths([
        toolStart("t4", "file_change", {
          changes: [{ path: "src/codex.ts", kind: "update", unified_diff: "@@\n+x\n" }]
        }),
        toolStart("t3", "writeToolCall", { path: "src/cursor.ts", content: "x" }),
        toolStart("t2", "Bash", { command: "npm test" }),
        toolStart("t1", "Edit", { file_path: "/abs/repo/src/claude.ts", old_string: "a", new_string: "b" }),
        event("u2", "user.message"),
        toolStart("t0", "Write", { file_path: "/abs/repo/src/previous.ts", content: "old" })
      ])
    ).toEqual(["src/codex.ts", "src/cursor.ts", "/abs/repo/src/claude.ts"]);
  });

  it("keeps an edit whose content never arrived because the file was still written", () => {
    // A streamed `Edit` can land with its path but no old/new strings, which
    // `interpretFileChange` drops because it has nothing to render.
    expect(lastTurnEditedPaths([toolStart("t1", "Edit", { file_path: "src/a.ts" })])).toEqual(["src/a.ts"]);
  });
});

describe("filterToLastTurn", () => {
  it("matches repo-relative changed files against absolute tool paths", () => {
    expect(
      filterToLastTurn([changed("src/a.ts"), changed("src/b.ts")], [
        "/Users/dev/repo/src/b.ts"
      ]).map((file) => file.path)
    ).toEqual(["src/b.ts"]);
  });

  it("is empty when the turn wrote nothing", () => {
    expect(filterToLastTurn([changed("src/a.ts")], [])).toEqual([]);
  });
});
