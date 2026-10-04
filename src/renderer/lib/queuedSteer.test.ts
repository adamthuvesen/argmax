import { describe, expect, it } from "vitest";
import { canSteerQueuedMessage } from "./queuedSteer.js";
import type { PendingMessage, SessionSummary } from "../../shared/types.js";

const session = {
  state: "running",
  provider: "claude",
  modelId: "claude-opus-5",
  reasoningEffort: "medium",
  agentMode: "auto",
  contextTokens: 0,
  contextWindow: 258_400
} as Pick<
  SessionSummary,
  | "state"
  | "provider"
  | "modelId"
  | "reasoningEffort"
  | "agentMode"
  | "contextTokens"
  | "contextWindow"
>;

const entry = {
  modelId: "claude-opus-5",
  reasoningEffort: "medium"
} as Pick<PendingMessage, "modelId" | "reasoningEffort" | "provider">;

describe("canSteerQueuedMessage", () => {
  it("steers a matching row into a running Claude, Codex or OpenCode turn", () => {
    expect(canSteerQueuedMessage(session, entry)).toBe(true);
    expect(canSteerQueuedMessage({ ...session, provider: "codex" }, entry)).toBe(true);
    expect(canSteerQueuedMessage({ ...session, provider: "opencode" }, entry)).toBe(true);
    // A row queued before the model was picked takes the turn's own settings.
    expect(canSteerQueuedMessage(session, {})).toBe(true);
    // A row that names the chat's own provider, or none (every legacy row).
    expect(canSteerQueuedMessage(session, { ...entry, provider: "claude" })).toBe(true);
    expect(canSteerQueuedMessage(session, { ...entry, provider: null })).toBe(true);
  });

  it.each([
    ["the turn has ended", { ...session, state: "complete" as const }, entry],
    ["the CLI takes no text mid-turn", { ...session, provider: "cursor" as const }, entry],
    [
      "Codex is close enough to compaction to lose the steering boundary",
      {
        ...session,
        provider: "codex" as const,
        contextTokens: 226_235,
        contextWindow: 258_400
      },
      entry
    ],
    ["the row is bound for another provider", session, { ...entry, provider: "codex" as const }],
    ["the row names another model", session, { ...entry, modelId: "claude-sonnet-5-5" }],
    ["the row names another effort", session, { ...entry, reasoningEffort: "high" as const }]
  ])("refuses when %s", (_case, openSession, queued) => {
    expect(canSteerQueuedMessage(openSession, queued)).toBe(false);
  });
});
