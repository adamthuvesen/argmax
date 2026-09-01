import { describe, expect, it } from "vitest";
import type { SessionSummary, WorkspaceSummary } from "../../shared/types.js";
import { computePriorityEntries, nextPriorityIdleAt, PRIORITY_IDLE_MS } from "./priority.js";

const workspace = (id: string, overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary => ({
  id,
  projectId: "project-1",
  taskLabel: `Task ${id}`,
  branch: `argmax/${id}`,
  baseRef: "main",
  path: `/tmp/${id}`,
  state: "running",
  sharedWorkspace: false,
  kind: "git",
  dirty: false,
  changedFiles: 0,
  lastActivityAt: "2026-05-12T15:54:00.000Z",
  pinned: false,
  priorityDismissedAt: null,
  priorityAddedAt: null,
  ...overrides
});

const session = (
  workspaceId: string,
  attention: SessionSummary["attention"],
  overrides: Partial<SessionSummary> = {}
): SessionSummary => ({
  id: `session-${workspaceId}-${attention}`,
  workspaceId,
  provider: "codex",
  modelLabel: "GPT-5.5",
  modelId: "gpt-5.5",
  permissionMode: "auto-approve",
  agentMode: "auto",
  providerConversationId: null,
  prompt: "Do the thing",
  // Settled by default: a live turn is its own reason to be listed, so tests
  // about attention opt into `state: "running"` explicitly.
  state: "complete",
  attention,
  attentionChangedAt: "2026-05-12T15:00:00.000Z",
  startedAt: "2026-05-12T14:00:00.000Z",
  completedAt: null,
  // Inside the idle window, so a settled row is listed on its attention alone.
  lastActivityAt: "2026-05-12T17:45:00.000Z",
  ...overrides
});

const NOW = Date.parse("2026-05-12T18:00:00.000Z");

describe("computePriorityEntries", () => {
  it("includes only attention-worthy workspaces and sorts by lastActivityAt descending", () => {
    const entries = computePriorityEntries(
      [
        workspace("w-normal"),
        workspace("w-review", { lastActivityAt: "2026-05-12T17:35:00.000Z" }),
        workspace("w-approval", { lastActivityAt: "2026-05-12T17:55:00.000Z" }),
        workspace("w-blocked-old", { lastActivityAt: "2026-05-12T17:40:00.000Z" }),
        workspace("w-blocked-new", { lastActivityAt: "2026-05-12T17:50:00.000Z" })
      ],
      [
        session("w-normal", "normal"),
        session("w-review", "review-ready", { lastActivityAt: "2026-05-12T17:35:00.000Z" }),
        session("w-approval", "approval-needed", { lastActivityAt: "2026-05-12T17:55:00.000Z" }),
        session("w-blocked-old", "blocked", { attentionChangedAt: "2026-05-12T10:00:00.000Z", lastActivityAt: "2026-05-12T17:40:00.000Z" }),
        session("w-blocked-new", "blocked", { attentionChangedAt: "2026-05-12T12:00:00.000Z", lastActivityAt: "2026-05-12T17:50:00.000Z" })
      ],
      NOW
    );

    expect(entries.map((entry) => entry.workspace.id)).toEqual([
      "w-approval",
      "w-blocked-new",
      "w-blocked-old",
      "w-review"
    ]);
  });

  it("excludes pinned workspaces even with attention or a manual add", () => {
    const entries = computePriorityEntries(
      [
        workspace("w-pinned-attention", { pinned: true }),
        workspace("w-pinned-manual", { pinned: true, priorityAddedAt: "2026-05-12T17:30:00.000Z" }),
        workspace("w-blocked")
      ],
      [
        session("w-pinned-attention", "blocked"),
        session("w-pinned-manual", "approval-needed"),
        session("w-blocked", "blocked")
      ],
      NOW
    );
    expect(entries.map((entry) => entry.workspace.id)).toEqual(["w-blocked"]);
  });

  it("excludes archived and kept workspaces", () => {
    const entries = computePriorityEntries(
      [workspace("w-archived", { state: "archived" }), workspace("w-kept", { state: "kept" })],
      [session("w-archived", "failed"), session("w-kept", "review-ready")],
      NOW
    );
    expect(entries).toEqual([]);
  });

  it("uses the highest-severity session when a workspace has several", () => {
    const entries = computePriorityEntries(
      [workspace("w-1")],
      [session("w-1", "review-ready"), session("w-1", "blocked")],
      NOW
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.attention).toBe("blocked");
  });

  it("honors a dismissal until attention changes again", () => {
    const dismissed = workspace("w-1", {
      priorityDismissedAt: "2026-05-12T16:00:00.000Z",
      priorityAddedAt: null
    });

    // Dismissal newer than the attention change → hidden.
    expect(
      computePriorityEntries(
        [dismissed],
        [session("w-1", "review-ready", { attentionChangedAt: "2026-05-12T15:00:00.000Z" })],
        NOW
      )
    ).toEqual([]);

    // Attention changed after the dismissal → re-promoted.
    expect(
      computePriorityEntries(
        [dismissed],
        [session("w-1", "approval-needed", { attentionChangedAt: "2026-05-12T17:00:00.000Z" })],
        NOW
      )
    ).toHaveLength(1);
  });

  it("drops a quiet row 30 minutes after its last message", () => {
    // Both stopped talking; only the one inside the window is still triage.
    const entries = computePriorityEntries(
      [workspace("w-recent"), workspace("w-quiet")],
      [
        session("w-recent", "failed", {
          state: "failed",
          lastActivityAt: "2026-05-12T17:45:00.000Z"
        }),
        session("w-quiet", "failed", {
          state: "failed",
          lastActivityAt: "2026-05-12T17:15:00.000Z"
        })
      ],
      NOW
    );
    expect(entries.map((entry) => entry.workspace.id)).toEqual(["w-recent"]);
  });

  it("keeps a working row however long the turn has run", () => {
    // Reading a row no longer demotes it, and a live turn never goes idle.
    const entries = computePriorityEntries(
      [workspace("w-1")],
      [
        session("w-1", "approval-needed", {
          state: "running",
          lastActivityAt: "2026-05-11T09:00:00.000Z"
        })
      ],
      NOW
    );
    expect(entries.map((entry) => entry.workspace.id)).toEqual(["w-1"]);
    // A working row has no deadline, so the section has nothing to wait for.
    expect(entries[0]?.idleAt).toBeNull();
    expect(nextPriorityIdleAt(entries)).toBeNull();
  });

  it("reports the earliest idle deadline so the sidebar can arm one timer", () => {
    const entries = computePriorityEntries(
      [workspace("w-soon"), workspace("w-later")],
      [
        session("w-soon", "failed", { state: "failed", lastActivityAt: "2026-05-12T17:40:00.000Z" }),
        session("w-later", "failed", { state: "failed", lastActivityAt: "2026-05-12T17:50:00.000Z" })
      ],
      NOW
    );
    expect(nextPriorityIdleAt(entries)).toBe(
      Date.parse("2026-05-12T17:40:00.000Z") + PRIORITY_IDLE_MS
    );
  });

  it("floats manual adds without attention, sorted by lastActivityAt descending", () => {
    const entries = computePriorityEntries(
      [
        workspace("w-manual", { priorityAddedAt: "2026-05-12T17:30:00.000Z", lastActivityAt: "2026-05-12T17:40:00.000Z" }),
        workspace("w-blocked", { lastActivityAt: "2026-05-12T17:50:00.000Z" })
      ],
      [
        // Manual entries ignore the idle gate (no attention stamp at all).
        session("w-manual", "normal", { attentionChangedAt: undefined, lastActivityAt: "2026-05-12T17:40:00.000Z" }),
        session("w-blocked", "blocked", { attentionChangedAt: "2026-05-12T17:00:00.000Z", lastActivityAt: "2026-05-12T17:50:00.000Z" })
      ],
      NOW
    );
    expect(entries.map((entry) => [entry.workspace.id, entry.attention])).toEqual([
      ["w-blocked", "blocked"],
      ["w-manual", null]
    ]);
  });

  it("floats a working workspace with no attention to the top, above non-working rows", () => {
    const entries = computePriorityEntries(
      [workspace("w-live"), workspace("w-blocked")],
      [
        session("w-live", "normal", { state: "running" }),
        session("w-blocked", "blocked", { attentionChangedAt: "2026-05-12T17:00:00.000Z" })
      ],
      NOW
    );
    expect(entries.map((entry) => [entry.workspace.id, entry.attention, entry.working])).toEqual([
      ["w-live", null, true],
      ["w-blocked", "blocked", false]
    ]);
  });

  it("sorts working rows newest-first, above non-working entries", () => {
    const entries = computePriorityEntries(
      [
        workspace("w-manual", { priorityAddedAt: "2026-05-12T17:30:00.000Z", lastActivityAt: "2026-05-12T17:55:00.000Z" }),
        workspace("w-older", { lastActivityAt: "2026-05-12T17:00:00.000Z" }),
        workspace("w-newer", { lastActivityAt: "2026-05-12T17:50:00.000Z" })
      ],
      [
        session("w-manual", "normal", { attentionChangedAt: undefined, lastActivityAt: "2026-05-12T17:55:00.000Z" }),
        session("w-older", "normal", { state: "running", lastActivityAt: "2026-05-12T17:00:00.000Z" }),
        session("w-newer", "normal", { state: "running", lastActivityAt: "2026-05-12T17:50:00.000Z" })
      ],
      NOW
    );
    expect(entries.map((entry) => entry.workspace.id)).toEqual(["w-newer", "w-older", "w-manual"]);
  });

  it("drops a working row the moment its turn ends", () => {
    const entries = computePriorityEntries(
      [workspace("w-live")],
      [session("w-live", "normal", { state: "complete" })],
      NOW
    );
    expect(entries).toEqual([]);
  });

  it("treats a missing attention stamp as stale", () => {
    // Pre-migration session rows have no attentionChangedAt — unknown age
    // counts as old, which keeps the first post-migration launch from
    // flooding Priority with historical sessions.
    const entries = computePriorityEntries(
      [workspace("w-1")],
      [session("w-1", "review-ready", { attentionChangedAt: undefined })],
      NOW
    );
    expect(entries).toEqual([]);
  });
});
