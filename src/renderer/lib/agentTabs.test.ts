// @vitest-environment node
import { describe, expect, it } from "vitest";
import { multitaskTabId, readAgentTab } from "./agentTabs.js";

describe("agent dock tab ids", () => {
  it("reads a multitask tab back as the session it names", () => {
    expect(readAgentTab(multitaskTabId("session-9"))).toEqual({
      kind: "multitask",
      sessionId: "session-9"
    });
  });

  it("treats anything else as a subagent's tool-use id", () => {
    expect(readAgentTab("toolu_01ABC")).toEqual({ kind: "subagent", toolUseId: "toolu_01ABC" });
  });
});
