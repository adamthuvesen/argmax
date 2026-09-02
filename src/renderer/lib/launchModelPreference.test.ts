// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_EFFORT_KEY,
  LAUNCH_MODEL_KEY,
  persistDefaultEffort,
  persistLaunchModel,
  readStoredDefaultEffort,
  readStoredLaunchModel
} from "./launchModelPreference.js";
import { allModelOptions } from "./models.js";

afterEach(() => {
  window.localStorage.clear();
});

describe("launch model preference", () => {
  it("round-trips a persisted selection and rebuilds the label from the catalog", () => {
    const option = allModelOptions.find((candidate) => candidate.supportsReasoningEffort);
    if (!option) throw new Error("catalog has no effort-capable model");

    persistLaunchModel({ ...option, reasoningEffort: "high" });

    expect(readStoredLaunchModel()).toEqual({
      provider: option.provider,
      label: option.label,
      modelId: option.modelId,
      reasoningEffort: "high"
    });
  });

  it("returns null for a model that left the catalog", () => {
    window.localStorage.setItem(LAUNCH_MODEL_KEY, JSON.stringify({ provider: "codex", modelId: "gpt-2" }));
    expect(readStoredLaunchModel()).toBeNull();
  });

  it("returns null for corrupt JSON", () => {
    window.localStorage.setItem(LAUNCH_MODEL_KEY, "{not json");
    expect(readStoredLaunchModel()).toBeNull();
  });

  it("falls back to Medium when no default effort was ever chosen", () => {
    expect(readStoredDefaultEffort()).toBe("medium");
    window.localStorage.setItem(DEFAULT_EFFORT_KEY, "turbo");
    expect(readStoredDefaultEffort()).toBe("medium");
  });

  it("applies the app-wide default effort to whatever model is stored", () => {
    persistDefaultEffort("xhigh");
    window.localStorage.setItem(
      LAUNCH_MODEL_KEY,
      JSON.stringify({ provider: "claude", modelId: "claude-opus-5" })
    );

    expect(readStoredLaunchModel()?.reasoningEffort).toBe("xhigh");
  });

  it("falls back for a model whose ladder stops below the default effort", () => {
    // Grok Build's CLI rejects anything above Extra High, so an Ultra default
    // lands on Medium rather than being sent through and refused.
    persistDefaultEffort("ultra");
    window.localStorage.setItem(
      LAUNCH_MODEL_KEY,
      JSON.stringify({ provider: "grok", modelId: "grok-4.6" })
    );

    expect(readStoredLaunchModel()?.reasoningEffort).toBe("medium");
  });

  it("clamps onto the discrete variant lists when Medium is missing too", () => {
    // OpenCode Go variant lists are discrete: GLM-5.3-Flash has no medium, and
    // Kimi K3 has only max. A default effort must land on a real variant, not
    // ride through to the adapter as-is.
    const stored = (modelId: string): string | undefined => {
      window.localStorage.setItem(LAUNCH_MODEL_KEY, JSON.stringify({ provider: "opencode", modelId }));
      return readStoredLaunchModel()?.reasoningEffort;
    };

    expect(stored("opencode-go/glm-5.3-flash")).toBe("low");
    expect(stored("opencode-go/kimi-k3")).toBe("max");
  });

  it("keeps the stored default when a model can only offer a fallback", () => {
    persistDefaultEffort("ultra");
    // Grok resolves to Medium — a fallback, not a choice, so Ultra survives.
    persistLaunchModel({ provider: "grok", label: "Grok 4.6", modelId: "grok-4.6", reasoningEffort: "medium" });
    expect(readStoredDefaultEffort()).toBe("ultra");

    // Picking High on that same model is an explicit choice and moves the default.
    persistLaunchModel({ provider: "grok", label: "Grok 4.6", modelId: "grok-4.6", reasoningEffort: "high" });
    expect(readStoredDefaultEffort()).toBe("high");
  });
});
