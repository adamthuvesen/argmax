import { describe, expect, it } from "vitest";
import { agentModeForLaunch, cycleLauncherMode } from "./agentMode.js";

describe("cycleLauncherMode", () => {
  it("cycles Auto to Plan to Chat to Auto when chat is available", () => {
    expect(cycleLauncherMode("auto", true)).toBe("plan");
    expect(cycleLauncherMode("plan", true)).toBe("chat");
    expect(cycleLauncherMode("chat", true)).toBe("auto");
  });

  it("skips Chat when it is unavailable", () => {
    expect(cycleLauncherMode("auto", false)).toBe("plan");
    expect(cycleLauncherMode("plan", false)).toBe("auto");
    expect(cycleLauncherMode("chat", false)).toBe("auto");
  });
});

describe("agentModeForLaunch", () => {
  it("sends Auto for Chat and otherwise the selected mode", () => {
    expect(agentModeForLaunch("chat")).toBe("auto");
    expect(agentModeForLaunch("plan")).toBe("plan");
    expect(agentModeForLaunch("auto")).toBe("auto");
  });
});
