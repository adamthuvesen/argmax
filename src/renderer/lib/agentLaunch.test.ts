import { describe, expect, it } from "vitest";
import {
  agentLaunchAriaLabel,
  agentLaunchLabel,
  agentStatusLabel,
  isInternalAgentLaunchMetadata
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


describe("agentLaunchLabel", () => {
  it("leads with the agent's own description and follows it with the codename", () => {
    const out = agentLaunchLabel(tool({ inputFull: { description: "Map the renderer" } }), "Triton");
    expect(out).toEqual({ title: "Map the renderer", identity: "Triton" });
  });

  it("names the codename outright when the provider gave no description", () => {
    expect(agentLaunchLabel(tool(), "Triton")).toEqual({ title: "Launched Triton", identity: null });
    expect(agentLaunchLabel(tool())).toEqual({ title: "Launched subagent", identity: null });
    expect(agentLaunchLabel(tool(), "  ")).toEqual({ title: "Launched subagent", identity: null });
  });

  it("never promotes the prompt into the title", () => {
    const prompt = "Inspect the repository at /Users/adamthuvesen/dev/menti/revops-backoffice.";
    const out = agentLaunchLabel(tool({ inputPreview: prompt.slice(0, 72), inputFull: { prompt } }), "Triton");
    expect(out.title).toBe("Launched Triton");
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

describe("isInternalAgentLaunchMetadata", () => {
  it("detects async launch confirmation phrases", () => {
    expect(isInternalAgentLaunchMetadata("Async agent launched successfully. output_file: /tmp/out")).toBe(true);
    expect(isInternalAgentLaunchMetadata("This tool result is internal metadata. Use SendMessage with to: ...")).toBe(true);
    expect(isInternalAgentLaunchMetadata("Background task launched.")).toBe(true);
    expect(isInternalAgentLaunchMetadata("Subagent launched successfully.")).toBe(true);
  });

  it("returns false for real subagent completion text", () => {
    expect(isInternalAgentLaunchMetadata("Checked the repository layout. Found 12 components.")).toBe(false);
    expect(isInternalAgentLaunchMetadata("README is updated.")).toBe(false);
  });
});
