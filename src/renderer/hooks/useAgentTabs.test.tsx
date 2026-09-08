import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useAgentTabs } from "./useAgentTabs.js";

describe("useAgentTabs", () => {
  it("closes multiple stale tabs atomically from one render", () => {
    const { result } = renderHook(() => useAgentTabs());

    act(() => {
      result.current.openTab("agent-a");
      result.current.openTab("agent-b");
      result.current.openTab("agent-c");
    });
    expect(result.current.activeTabId).toBe("agent-c");

    act(() => {
      result.current.closeTab("agent-a");
      result.current.closeTab("agent-c");
    });

    expect(result.current.tabIds).toEqual(["agent-b"]);
    expect(result.current.activeTabId).toBe("agent-b");
  });
});
