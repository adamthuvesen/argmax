import { describe, expect, it } from "vitest";
import { canSteerQueuedMessage } from "./queuedSteer.js";
import type { PendingMessage, SessionSummary } from "../../shared/types.js";

const session = {
  state: "running",
  provider: "claude",
  modelId: "claude-opus-5",
  reasoningEffort: "medium",
  agentMode: "auto"
} as Pick<SessionSummary, "state" | "provider" | "modelId" | "reasoningEffort" | "agentMode">;

const entry = {
  modelId: "claude-opus-5",
  reasoningEffort: "medium",
  agentMode: "auto"
} as Pick<PendingMessage, "modelId" | "reasoningEffort" | "agentMode">;

describe("canSteerQueuedMessage", () => {
  it("steers a matching row into a running Claude or Codex turn", () => {
    expect(canSteerQueuedMessage(session, entry)).toBe(true);
    expect(canSteerQueuedMessage({ ...session, provider: "codex" }, entry)).toBe(true);
    // A row queued before the model was picked takes the turn's own settings.
    expect(canSteerQueuedMessage(session, { agentMode: "auto" })).toBe(true);
  });

  it.each([
    ["the turn has ended", { ...session, state: "complete" as const }, entry],
    ["the CLI takes no text mid-turn", { ...session, provider: "cursor" as const }, entry],
    ["the row names another model", session, { ...entry, modelId: "claude-sonnet-5" }],
    ["the row names another effort", session, { ...entry, reasoningEffort: "high" as const }],
    ["the row names another agent mode", session, { ...entry, agentMode: "plan" as const }]
  ])("refuses when %s", (_case, openSession, queued) => {
    expect(canSteerQueuedMessage(openSession, queued)).toBe(false);
  });
});
