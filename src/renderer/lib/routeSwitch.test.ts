import { describe, expect, it } from "vitest";
import { routeSwitchDirection, splitAtChange, type RoutedModel } from "./routeSwitch.js";

const opus = (reasoningEffort: RoutedModel["reasoningEffort"]): RoutedModel => ({
  provider: "claude",
  modelId: "claude-opus-5-5",
  modelLabel: "Opus 5.5",
  reasoningEffort
});
const fable = (reasoningEffort: RoutedModel["reasoningEffort"]): RoutedModel => ({
  provider: "claude",
  modelId: "claude-fable-5-1",
  modelLabel: "Fable 5.1",
  reasoningEffort
});

describe("routeSwitchDirection", () => {
  it("judges a model change by price, whatever the effort does", () => {
    expect(routeSwitchDirection(opus("high"), fable("medium"))).toBe("up");
    expect(routeSwitchDirection(fable("xhigh"), opus("max"))).toBe("down");
  });

  it("judges an effort-only change by effort", () => {
    expect(routeSwitchDirection(opus("medium"), opus("high"))).toBe("up");
    expect(routeSwitchDirection(opus("high"), opus("medium"))).toBe("down");
  });

  it("falls back to effort between Cursor's models, which bill at no per-token price", () => {
    const composer: RoutedModel = { provider: "cursor", modelId: "composer-2.5", modelLabel: "Composer 2.5 (Cursor)", reasoningEffort: null };
    const cursorOpus: RoutedModel = { provider: "cursor", modelId: "claude-opus-5-5-medium", modelLabel: "Claude Opus 5.5 (Cursor)", reasoningEffort: "medium" };
    expect(routeSwitchDirection(composer, cursorOpus)).toBe("up");
  });
});

describe("splitAtChange", () => {
  it("rolls only the words that changed", () => {
    expect(splitAtChange("Balance → Opus 5.5", "Balance → Fable 5.1")).toEqual(["Balance → ", "Opus 5.5", "Fable 5.1"]);
    expect(splitAtChange("Opus 5.5", "Opus 5.1")).toEqual(["Opus ", "5.5", "5.1"]);
    expect(splitAtChange("High", "Extra High")).toEqual(["", "High", "Extra High"]);
    expect(splitAtChange("Balance", "Balance → Opus 5.5")).toEqual(["Balance", "", " → Opus 5.5"]);
  });
});
