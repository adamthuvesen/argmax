import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../../shared/types.js";
import { modelPickerSelectionFromSession, modelSelectionFromSession } from "./models.js";

const BASE_SESSION: SessionSummary = {
  id: "session-1",
  workspaceId: "workspace-1",
  provider: "codex",
  modelLabel: "GPT-5.3 Codex Spark",
  modelId: "gpt-5.3-codex-spark",
  permissionMode: "auto-approve",
  providerConversationId: null,
  prompt: "Review this",
  state: "complete",
  attention: "normal",
  startedAt: "2026-07-04T10:00:00.000Z",
  completedAt: "2026-07-04T10:01:00.000Z",
  lastActivityAt: "2026-07-04T10:01:00.000Z"
};

describe("modelSelectionFromSession", () => {
  it("falls back to the provider default when a stored model was removed", () => {
    expect(modelSelectionFromSession(BASE_SESSION)).toEqual({
      label: "GPT-5.5",
      modelId: "gpt-5.5",
      reasoningEffort: "high"
    });
    expect(modelPickerSelectionFromSession(BASE_SESSION)).toEqual({
      provider: "codex",
      label: "GPT-5.5",
      modelId: "gpt-5.5",
      reasoningEffort: "high"
    });
  });
});
