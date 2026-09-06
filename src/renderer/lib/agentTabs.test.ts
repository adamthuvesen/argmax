// @vitest-environment node
import { describe, expect, it } from "vitest";
import { agentTabId, multitaskTabId, readAgentTab } from "./agentTabs.js";

describe("agent dock tab ids", () => {
  it("reads a multitask tab back as the session it names", () => {
    expect(readAgentTab(multitaskTabId("session-9"))).toEqual({
      kind: "multitask",
      sessionId: "session-9"
    });
  });

  it("treats anything else as a subagent's tool-use id", () => {
    expect(readAgentTab("toolu_01ABC")).toEqual({
      kind: "subagent",
      toolUseId: "toolu_01ABC",
      providerParentConversationId: null,
      providerChildSessionId: null
    });
  });

  it("keeps a native continuation on the first launch tab", () => {
    expect(agentTabId({
      toolUseId: "send-message-2",
      agentRootToolUseId: "task-original",
      providerChildSessionId: "native-child",
      providerParentConversationId: "native-parent"
    })).toBe("native-agent:task-original:native-parent:native-child");
  });

  it("does not claim persistence for a legacy provider launch", () => {
    expect(agentTabId({ toolUseId: "spawn-2" })).toBe("spawn-2");
  });
});
