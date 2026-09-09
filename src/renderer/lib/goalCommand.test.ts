import { describe, expect, it } from "vitest";
import { MAX_GOAL_CONDITION_CHARS, parseGoalCommand } from "./goalCommand.js";

describe("parseGoalCommand", () => {
  it("reads the condition after the command", () => {
    expect(parseGoalCommand("/goal all tests in test/auth pass")).toEqual({
      kind: "set",
      condition: "all tests in test/auth pass"
    });
  });

  it("keeps a multiline condition intact", () => {
    expect(parseGoalCommand("/goal npm test exits 0\nand lint is clean")).toEqual({
      kind: "set",
      condition: "npm test exits 0\nand lint is clean"
    });
  });

  it("treats the bare command as a draft still being typed", () => {
    expect(parseGoalCommand("/goal")).toBeNull();
    expect(parseGoalCommand("/goal   ")).toBeNull();
  });

  it("accepts the clear aliases Claude Code accepts", () => {
    for (const word of ["clear", "stop", "off", "reset", "none", "cancel", "CLEAR"]) {
      expect(parseGoalCommand(`/goal ${word}`)).toEqual({ kind: "clear" });
    }
  });

  it("ignores a message that only mentions the command", () => {
    expect(parseGoalCommand("what does /goal do?")).toBeNull();
  });

  it("caps a condition at the length the evaluator reads", () => {
    const parsed = parseGoalCommand(`/goal ${"x".repeat(MAX_GOAL_CONDITION_CHARS + 500)}`);
    expect(parsed).toEqual({ kind: "set", condition: "x".repeat(MAX_GOAL_CONDITION_CHARS) });
  });
});
