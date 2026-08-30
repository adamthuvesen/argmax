// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { LAUNCH_MODEL_KEY, persistLaunchModel, readStoredLaunchModel } from "./launchModelPreference.js";
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
    window.localStorage.setItem(
      LAUNCH_MODEL_KEY,
      JSON.stringify({ provider: "codex", modelId: "gpt-2", reasoningEffort: "high" })
    );
    expect(readStoredLaunchModel()).toBeNull();
  });

  it("returns null for corrupt JSON", () => {
    window.localStorage.setItem(LAUNCH_MODEL_KEY, "{not json");
    expect(readStoredLaunchModel()).toBeNull();
  });

  it("replaces an invalid stored effort with the model default", () => {
    const option = allModelOptions.find((candidate) => candidate.supportsReasoningEffort);
    if (!option) throw new Error("catalog has no effort-capable model");
    window.localStorage.setItem(
      LAUNCH_MODEL_KEY,
      JSON.stringify({ provider: option.provider, modelId: option.modelId, reasoningEffort: "turbo" })
    );

    expect(readStoredLaunchModel()?.reasoningEffort).toBe(option.reasoningEffort);
  });

  it("clamps a stored effort onto the levels the model actually offers", () => {
    // OpenCode Go variant lists are discrete: GLM-5.3-Flash has no medium, and
    // Kimi K3 has only max. A stored "medium" must land on a real variant, not
    // ride through to the adapter as-is.
    const stored = (modelId: string): string | undefined => {
      window.localStorage.setItem(
        LAUNCH_MODEL_KEY,
        JSON.stringify({ provider: "opencode", modelId, reasoningEffort: "medium" })
      );
      return readStoredLaunchModel()?.reasoningEffort;
    };

    expect(stored("opencode-go/glm-5.3-flash")).toBe("low");
    expect(stored("opencode-go/kimi-k3")).toBe("max");
  });
});
