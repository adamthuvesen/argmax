import { describe, expect, it } from "vitest";
import type { SessionSummary, WorkspaceSummary } from "../../shared/types.js";
import { computePriorityEntries } from "./priority.js";

const workspace = (id: string, overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary => ({
  id,
  projectId: "project-1",
  taskLabel: `Task ${id}`,
  branch: `argmax/${id}`,
  baseRef: "main",
  path: `/tmp/${id}`,
  state: "running",
  sharedWorkspace: false,
  dirty: false,
  changedFiles: 0,
  lastActivityAt: "2026-05-12T15:54:00.000Z",
  pinned: false,
  priorityDismissedAt: null,
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
  state: "running",
  attention,
  attentionChangedAt: "2026-05-12T15:00:00.000Z",
  startedAt: "2026-05-12T14:00:00.000Z",
  completedAt: null,
  lastActivityAt: "2026-05-12T15:54:00.000Z",
  ...overrides
});

describe("computePriorityEntries", () => {
  it("includes only attention-worthy workspaces and sorts by severity then age", () => {
    const entries = computePriorityEntries(
      [workspace("w-normal"), workspace("w-review"), workspace("w-approval"), workspace("w-blocked-old"), workspace("w-blocked-new")],
      [
        session("w-normal", "normal"),
        session("w-review", "review-ready"),
        session("w-approval", "approval-needed"),
        session("w-blocked-old", "blocked", { attentionChangedAt: "2026-05-12T10:00:00.000Z" }),
        session("w-blocked-new", "blocked", { attentionChangedAt: "2026-05-12T12:00:00.000Z" })
      ]
    );

    expect(entries.map((entry) => entry.workspace.id)).toEqual([
      "w-approval",
      "w-blocked-old",
      "w-blocked-new",
      "w-review"
    ]);
  });

  it("excludes archived and kept workspaces", () => {
    const entries = computePriorityEntries(
      [workspace("w-archived", { state: "archived" }), workspace("w-kept", { state: "kept" })],
      [session("w-archived", "failed"), session("w-kept", "review-ready")]
    );
    expect(entries).toEqual([]);
  });

  it("uses the highest-severity session when a workspace has several", () => {
    const entries = computePriorityEntries(
      [workspace("w-1")],
      [session("w-1", "review-ready"), session("w-1", "blocked")]
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.attention).toBe("blocked");
  });

  it("honors a dismissal until attention changes again", () => {
    const dismissed = workspace("w-1", {
      priorityDismissedAt: "2026-05-12T16:00:00.000Z"
    });

    // Dismissal newer than the attention change → hidden.
    expect(
      computePriorityEntries(
        [dismissed],
        [session("w-1", "review-ready", { attentionChangedAt: "2026-05-12T15:00:00.000Z" })]
      )
    ).toEqual([]);

    // Attention changed after the dismissal → re-promoted.
    expect(
      computePriorityEntries(
        [dismissed],
        [session("w-1", "approval-needed", { attentionChangedAt: "2026-05-12T17:00:00.000Z" })]
      )
    ).toHaveLength(1);
  });

  it("treats a missing attention stamp as older than any dismissal", () => {
    // Pre-migration session rows have no attentionChangedAt; a dismissal must
    // still stick, otherwise old review-ready workspaces are undismissable.
    const entries = computePriorityEntries(
      [workspace("w-1", { priorityDismissedAt: "2026-05-12T16:00:00.000Z" })],
      [session("w-1", "review-ready", { attentionChangedAt: undefined })]
    );
    expect(entries).toEqual([]);
  });
});
