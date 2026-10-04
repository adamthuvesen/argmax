import { afterEach, describe, expect, it, vi } from "vitest";
import { SCRATCH_PROJECT_ID, type DashboardSnapshot } from "../../shared/types.js";
import {
  chatDirectoryFromSnapshot,
  lookUpChat,
  openChat,
  publishChatDirectory,
  registerChatOpener,
  resetChatDirectoryForTests,
  searchChatTitles,
  type ChatDirectoryEntry
} from "./chatDirectory.js";

const entry = (
  sessionId: string,
  title: string,
  lastActivityAt = "2026-10-01T00:00:00Z"
): ChatDirectoryEntry => ({ sessionId, workspaceId: `w-${sessionId}`, title, projectName: "Argmax", lastActivityAt });

afterEach(resetChatDirectoryForTests);

describe("chatDirectoryFromSnapshot", () => {
  it("names each chat by its task label and project, newest first, with no project for a scratch chat", () => {
    const snapshot = {
      projects: [
        { id: "p1", name: "Argmax" },
        { id: SCRATCH_PROJECT_ID, name: "Chat" }
      ],
      workspaces: [
        { id: "w1", projectId: "p1", taskLabel: "Fix login" },
        { id: "w2", projectId: SCRATCH_PROJECT_ID, taskLabel: "" }
      ],
      sessions: [
        { id: "s1", workspaceId: "w1", prompt: "x", modelLabel: "M", lastActivityAt: "2026-10-01T00:00:00Z" },
        { id: "s2", workspaceId: "w2", prompt: "Explain rebases", modelLabel: "M", lastActivityAt: "2026-10-02T00:00:00Z" },
        { id: "orphan", workspaceId: "gone", prompt: "x", modelLabel: "M", lastActivityAt: "2026-10-03T00:00:00Z" }
      ]
    } as unknown as DashboardSnapshot;

    expect(chatDirectoryFromSnapshot(snapshot)).toEqual([
      { sessionId: "s2", workspaceId: "w2", title: "Explain rebases", projectName: "", lastActivityAt: "2026-10-02T00:00:00Z" },
      { sessionId: "s1", workspaceId: "w1", title: "Fix login", projectName: "Argmax", lastActivityAt: "2026-10-01T00:00:00Z" }
    ]);
  });
});

describe("searchChatTitles", () => {
  const directory = [
    entry("a", "Refactor billing", "2026-10-03T00:00:00Z"),
    entry("b", "Billing export bug", "2026-10-02T00:00:00Z"),
    entry("c", "Fix the invoice billing page", "2026-10-01T00:00:00Z"),
    entry("d", "Unrelated")
  ];

  it("keeps titles holding every word and ranks a leading match first, then a word start, then the rest", () => {
    expect(searchChatTitles(directory, "billing", 10).map((chat) => chat.sessionId)).toEqual(["b", "a", "c"]);
    expect(searchChatTitles(directory, "billing page", 10).map((chat) => chat.sessionId)).toEqual(["c"]);
  });

  it("is case-insensitive, limited, and empty for an empty query", () => {
    expect(searchChatTitles(directory, "BILLING", 1)).toHaveLength(1);
    expect(searchChatTitles(directory, "   ", 10)).toEqual([]);
    expect(searchChatTitles(directory, "zzz", 10)).toEqual([]);
  });
});

describe("opening a chat", () => {
  it("opens a chat the directory knows through the registered opener, and only that", () => {
    const open = vi.fn();
    const unregister = registerChatOpener(open);
    publishChatDirectory([entry("s1", "Known")]);

    expect(openChat("s1")).toBe(true);
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s1", workspaceId: "w-s1" }));
    expect(openChat("gone")).toBe(false);
    expect(lookUpChat("gone")).toBeNull();

    unregister();
    expect(openChat("s1")).toBe(false);
  });
});
