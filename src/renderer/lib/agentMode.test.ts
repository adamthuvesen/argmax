import { describe, expect, it } from "vitest";
import { cycleLauncherMode } from "./agentMode.js";

describe("cycleLauncherMode", () => {
  it("cycles Auto to Chat to Auto when chat is available", () => {
    expect(cycleLauncherMode("auto", true)).toBe("chat");
    expect(cycleLauncherMode("chat", true)).toBe("auto");
  });

  it("stays on Auto when Chat is unavailable", () => {
    expect(cycleLauncherMode("auto", false)).toBe("auto");
    expect(cycleLauncherMode("chat", false)).toBe("auto");
  });
});
