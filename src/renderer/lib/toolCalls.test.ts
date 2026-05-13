import { describe, expect, it } from "vitest";
import { extractCompletionCorrelationId, extractToolUseId } from "./toolCalls.js";

describe("extractCompletionCorrelationId", () => {
  it("prefers tool_use_id (Claude)", () => {
    expect(extractCompletionCorrelationId({ tool_use_id: "toolu_x", id: "should-not-win" })).toBe("toolu_x");
  });

  it("falls back to id (Codex)", () => {
    expect(extractCompletionCorrelationId({ id: "codex-1" })).toBe("codex-1");
  });

  it("falls back to call_id (Cursor)", () => {
    // Without this, cursor tool calls render forever as 'running' because
    // command.completed never pairs back to command.started.
    expect(extractCompletionCorrelationId({ call_id: "tool_abc" })).toBe("tool_abc");
  });

  it("returns null when no correlation field is present", () => {
    expect(extractCompletionCorrelationId({})).toBeNull();
  });

  it("ignores non-string values", () => {
    expect(extractCompletionCorrelationId({ id: 42, call_id: null })).toBeNull();
  });
});

describe("extractToolUseId", () => {
  it("returns id when present (Claude/Codex started)", () => {
    expect(extractToolUseId({ id: "toolu_x" })).toBe("toolu_x");
  });

  it("falls back to call_id (Cursor started)", () => {
    expect(extractToolUseId({ call_id: "tool_abc" })).toBe("tool_abc");
  });
});
