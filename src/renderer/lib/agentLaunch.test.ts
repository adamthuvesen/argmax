import { describe, expect, it } from "vitest";
import {
  agentLaunchAriaLabel,
  agentLaunchStatusHint,
  agentLaunchTitle,
  agentRoleLabel,
  agentStatusLabel
} from "./agentLaunch.js";
import type { ToolCall } from "./toolCalls.js";

function tool(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: "t1",
    toolUseId: "t1",
    name: "Task",
    inputPreview: "Map the renderer",
    inputFull: {},
    output: null,
    status: "done",
    createdAt: "2026-05-12T15:00:00.000Z",
    completedAt: "2026-05-12T15:00:01.000Z",
    error: null,
    ...overrides
  };
}

describe("agentRoleLabel", () => {
  it("title-cases a concrete subagent_type", () => {
    expect(agentRoleLabel(tool({ inputFull: { subagent_type: "reviewer" } }))).toBe("Reviewer");
    expect(agentRoleLabel(tool({ inputFull: { subagentType: "code-reviewer" } }))).toBe("Code Reviewer");
  });

  it("skips generic roles so the moon name can stand in", () => {
    expect(agentRoleLabel(tool({ inputFull: { subagent_type: "general-purpose" } }))).toBeNull();
    expect(agentRoleLabel(tool({ inputFull: { subagentType: { unspecified: {} } } }))).toBeNull();
  });
});

describe("agentLaunchTitle", () => {
  it("names the launched agent and never the prompt", () => {
    expect(agentLaunchTitle("Triton")).toBe("Launched Triton");
    expect(agentLaunchTitle()).toBe("Launched subagent");
    expect(agentLaunchTitle("  ")).toBe("Launched subagent");
  });
});

describe("agentLaunchStatusHint", () => {
  it("says nothing for a completed launch and keeps live or failed state", () => {
    expect(agentLaunchStatusHint("done")).toBeNull();
    expect(agentLaunchStatusHint("running")).toBe("Running");
    expect(agentLaunchStatusHint("error")).toBe("Failed");
  });
});

describe("agentStatusLabel", () => {
  it("uses Completed / Running / Failed", () => {
    expect(agentStatusLabel("done")).toBe("Completed");
    expect(agentStatusLabel("running")).toBe("Running");
    expect(agentStatusLabel("error")).toBe("Failed");
  });
});

describe("agentLaunchAriaLabel", () => {
  it("keeps the Started agent <codename> — <preview> contract", () => {
    expect(agentLaunchAriaLabel(tool(), "Triton")).toBe("Started agent Triton — Map the renderer");
  });
});
