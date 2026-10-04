import { describe, expect, it } from "vitest";
import { selectionOfQueuedMessage } from "./queuedSelection.js";

describe("selectionOfQueuedMessage", () => {
  it("brings back the provider, model and effort a row was queued under", () => {
    expect(
      selectionOfQueuedMessage(
        { provider: "claude", modelLabel: "Sonnet 5.5", modelId: "claude-sonnet-5-5", reasoningEffort: "high" },
        { provider: "codex" }
      )
    ).toEqual({
      provider: "claude",
      label: "Sonnet 5.5",
      modelId: "claude-sonnet-5-5",
      reasoningEffort: "high"
    });
  });

  it("gives a legacy row, with no provider, the chat's own", () => {
    expect(
      selectionOfQueuedMessage(
        { modelLabel: "GPT-6 Luna", modelId: "gpt-6-luna" },
        { provider: "codex" }
      )
    ).toEqual({ provider: "codex", label: "GPT-6 Luna", modelId: "gpt-6-luna" });
  });

  it("leaves the picker alone for a row that never picked a model", () => {
    expect(selectionOfQueuedMessage({}, { provider: "codex" })).toBeNull();
    expect(selectionOfQueuedMessage({ provider: "claude" }, { provider: "codex" })).toBeNull();
    expect(selectionOfQueuedMessage({ modelId: "m", modelLabel: "M" }, null)).toBeNull();
  });
});
