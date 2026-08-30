import { describe, expect, it } from "vitest";
import type { SessionSummary, WorkspaceSummary } from "../../shared/types.js";
import { computePriorityEntries, shouldDemoteOnLeave } from "./priority.js";

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
  state: "running",
  attention,
  attentionChangedAt: "2026-05-12T15:00:00.000Z",
  startedAt: "2026-05-12T14:00:00.000Z",
  completedAt: null,
  lastActivityAt: "2026-05-12T15:54:00.000Z",
  ...overrides
});

const NOW = Date.parse("2026-05-12T18:00:00.000Z");

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
      ],
      NOW
    );

    expect(entries.map((entry) => entry.workspace.id)).toEqual([
      "w-approval",
      "w-blocked-old",
      "w-blocked-new",
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

  it("excludes attention older than 24 hours", () => {
    const entries = computePriorityEntries(
      [workspace("w-fresh"), workspace("w-stale")],
      [
        session("w-fresh", "failed", { attentionChangedAt: "2026-05-12T17:00:00.000Z" }),
        session("w-stale", "failed", { attentionChangedAt: "2026-05-11T17:00:00.000Z" })
      ],
      NOW
    );
    expect(entries.map((entry) => entry.workspace.id)).toEqual(["w-fresh"]);
  });

  it("floats manual adds without attention, after attention-driven entries", () => {
    const entries = computePriorityEntries(
      [
        workspace("w-manual", { priorityAddedAt: "2026-05-12T17:30:00.000Z" }),
        workspace("w-blocked")
      ],
      [
        // Manual entries ignore the staleness gate (no stamp here at all).
        session("w-manual", "normal", { attentionChangedAt: undefined }),
        session("w-blocked", "blocked", { attentionChangedAt: "2026-05-12T17:00:00.000Z" })
      ],
      NOW
    );
    expect(entries.map((entry) => [entry.workspace.id, entry.attention])).toEqual([
      ["w-blocked", "blocked"],
      ["w-manual", null]
    ]);
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

describe("shouldDemoteOnLeave", () => {
  it("demotes any attention-driven Priority session after it has been read", () => {
    expect(
      shouldDemoteOnLeave(
        workspace("w-1"),
        [session("w-1", "blocked", { state: "waiting" })],
        NOW
      )
    ).toBe(true);
    expect(
      shouldDemoteOnLeave(
        workspace("w-1"),
        [session("w-1", "approval-needed", { state: "waiting" })],
        NOW
      )
    ).toBe(true);
    expect(
      shouldDemoteOnLeave(workspace("w-1"), [session("w-1", "failed", { state: "failed" })], NOW)
    ).toBe(true);
    expect(
      shouldDemoteOnLeave(
        workspace("w-1"),
        [session("w-1", "review-ready", { state: "complete" })],
        NOW
      )
    ).toBe(true);
  });

  it("keeps a working session in Priority even when it also waits", () => {
    expect(
      shouldDemoteOnLeave(
        workspace("w-1"),
        [session("w-1", "approval-needed", { state: "running" })],
        NOW
      )
    ).toBe(false);
  });

  it("demotes a pinned workspace — a pin hides the Priority row, not the chip", () => {
    expect(
      shouldDemoteOnLeave(
        workspace("w-1", { pinned: true }),
        [session("w-1", "review-ready", { state: "complete" })],
        NOW
      )
    ).toBe(true);
  });

  it("does not demote a workspace mid-teardown", () => {
    // Stamping a dismissal here races the archive; a write that lands after the
    // row is gone raises a spurious error toast on the desktop path.
    for (const state of ["archiving", "archive-failed"] as const) {
      expect(
        shouldDemoteOnLeave(
          workspace("w-1", { state }),
          [session("w-1", "review-ready", { state: "complete" })],
          NOW
        )
      ).toBe(false);
    }
  });

  it("does not demote a purely manual entry", () => {
    expect(
      shouldDemoteOnLeave(
        workspace("w-1", { priorityAddedAt: "2026-05-12T16:00:00.000Z" }),
        [session("w-1", "normal", { state: "complete" })],
        NOW
      )
    ).toBe(false);
  });

  it("does not demote a wait that is already dismissed", () => {
    expect(
      shouldDemoteOnLeave(
        workspace("w-1", { priorityDismissedAt: "2026-05-12T16:00:00.000Z" }),
        [session("w-1", "blocked", { state: "waiting", attentionChangedAt: "2026-05-12T15:00:00.000Z" })],
        NOW
      )
    ).toBe(false);
  });

  it("demotes again after a later wait (fresh attention after more work)", () => {
    expect(
      shouldDemoteOnLeave(
        workspace("w-1", { priorityDismissedAt: "2026-05-12T16:00:00.000Z" }),
        [session("w-1", "blocked", { state: "waiting", attentionChangedAt: "2026-05-12T17:00:00.000Z" })],
        NOW
      )
    ).toBe(true);
  });
});
