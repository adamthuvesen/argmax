import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../../shared/types.js";
import { chatSessionByWorkspace, chatSessionFor } from "./workspaceChat.js";

const session = (
  id: string,
  workspaceId: string,
  lastActivityAt: string
): SessionSummary => ({
  id,
  workspaceId,
  provider: "codex",
  modelLabel: "GPT-5.6 Sol",
  modelId: "gpt-5.6-sol",
  permissionMode: "auto-approve",
  agentMode: "auto",
  providerConversationId: null,
  prompt: "Do the thing",
  state: "complete",
  attention: "review-ready",
  attentionChangedAt: null,
  startedAt: "2026-09-11T16:00:00.000Z",
  completedAt: null,
  lastActivityAt,
  costUsd: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextTokens: 0,
  imported: false,
  launchKind: "agent"
});

// Two top-level sessions land in one checkout more often than the domain
// model admits (a repeated prompt, an import beside a live chat). Every
// reader has to name the same one, or a row describes one chat and opens
// another.
const older = session("s-old", "w-1", "2026-09-11T16:42:39.181Z");
const newer = session("s-new", "w-1", "2026-09-11T16:58:58.256Z");

describe("chatSessionByWorkspace", () => {
  it("picks the most recently active session, whatever order the rows arrive in", () => {
    expect(chatSessionByWorkspace([newer, older]).get("w-1")?.id).toBe("s-new");
    expect(chatSessionByWorkspace([older, newer]).get("w-1")?.id).toBe("s-new");
  });

  it("breaks a tie by id, the way the dashboard query does", () => {
    const a = session("s-a", "w-1", "2026-09-11T16:42:39.181Z");
    const b = session("s-b", "w-1", "2026-09-11T16:42:39.181Z");
    expect(chatSessionByWorkspace([a, b]).get("w-1")?.id).toBe("s-b");
    expect(chatSessionByWorkspace([b, a]).get("w-1")?.id).toBe("s-b");
  });

  it("keeps workspaces apart", () => {
    const other = session("s-other", "w-2", "2026-09-11T17:00:00.000Z");
    const byWorkspace = chatSessionByWorkspace([older, newer, other]);
    expect(byWorkspace.get("w-1")?.id).toBe("s-new");
    expect(byWorkspace.get("w-2")?.id).toBe("s-other");
  });
});

describe("chatSessionFor", () => {
  it("agrees with the map — the row and the chat it opens are the same session", () => {
    expect(chatSessionFor([older, newer], "w-1")?.id).toBe("s-new");
    expect(chatSessionFor([newer, older], "w-1")?.id).toBe("s-new");
  });

  it("is null for a workspace with no chat", () => {
    expect(chatSessionFor([older], "w-2")).toBeNull();
  });
});
