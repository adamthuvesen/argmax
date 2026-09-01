import { describe, expect, it } from "vitest";
import { PROVIDER_MODEL_DEFAULTS } from "../shared/providerModels.js";
import { LAUNCH_MODEL_DEFAULTS } from "../../scripts/bridge.mjs";

// scripts/bridge.mjs cannot import providerModels.ts at runtime (plain node
// cannot execute that module's import graph), so it carries a copy of the
// launch defaults. This is the drift alarm: a catalog change that forgets the
// bridge copy fails here instead of silently launching retired models.
describe("bridge launch defaults", () => {
  it("mirror PROVIDER_MODEL_DEFAULTS exactly", () => {
    const mirrored = Object.fromEntries(
      Object.entries(PROVIDER_MODEL_DEFAULTS).map(([provider, model]) => [
        provider,
        {
          modelLabel: model.label,
          modelId: model.modelId,
          reasoningEffort: model.reasoningEffort ?? null
        }
      ])
    );
    expect(LAUNCH_MODEL_DEFAULTS).toEqual(mirrored);
  });
});
