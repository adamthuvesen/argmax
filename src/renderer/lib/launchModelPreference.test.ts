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
});
