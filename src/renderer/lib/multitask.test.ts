// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { SessionSummary, TimelineEvent, WorkspaceSummary } from "../../shared/types.js";
import {
  hiddenMultitaskWorkspaceIds,
  mergeMultitaskNotice,
  multitaskCommandPrompt,
  multitaskNoticeFor,
  multitasksByParentSession,
  MULTITASK_FINISHED,
  MULTITASK_LAUNCHED
} from "./multitask.js";

function event(type: string, payload: Record<string, unknown>, message = "row"): TimelineEvent {
  return {
    id: `${type}-1`,
    sessionId: "session-parent",
    type: type as TimelineEvent["type"],
    message,
    payload,
    createdAt: "2026-09-02T10:00:00.000Z",
    rowCursor: 1
  };
}

describe("multitaskNoticeFor", () => {
  it("reads a dispatch row, with no state until it finishes", () => {
    const notice = multitaskNoticeFor(
      event(MULTITASK_LAUNCHED, {
        childSessionId: "child-1",
        taskLabel: "Fix the README typo",
        prompt: "Fix the README typo",
        worktree: false
      })
    );

    expect(notice).toEqual({
      childSessionId: "child-1",
      taskLabel: "Fix the README typo",
      prompt: "Fix the README typo",
      worktree: false,
      state: null,
      answer: null
    });
  });

  it("falls back to the row's own message when the label is missing", () => {
    const notice = multitaskNoticeFor(event(MULTITASK_FINISHED, {}, "Side fix finished alongside"));
    expect(notice.taskLabel).toBe("Side fix finished alongside");
  });
});

describe("mergeMultitaskNotice", () => {
  it("completes the card in place instead of erasing what the dispatch said", () => {
    const launched = multitaskNoticeFor(
      event(MULTITASK_LAUNCHED, {
        childSessionId: "child-1",
        taskLabel: "Fix the README typo",
        prompt: "Fix the README typo",
        worktree: true
      })
    );
    const finished = multitaskNoticeFor(
      event(MULTITASK_FINISHED, {
        childSessionId: "child-1",
        taskLabel: "Fix the README typo",
        state: "complete",
        answer: "Fixed it."
      })
    );

    expect(mergeMultitaskNotice(launched, finished)).toEqual({
      childSessionId: "child-1",
      taskLabel: "Fix the README typo",
      // The finish row says nothing about these, and must not blank them.
      prompt: "Fix the README typo",
      worktree: true,
      state: "complete",
      answer: "Fixed it."
    });
  });
});

describe("multitaskCommandPrompt", () => {
  it("takes the prompt after the command", () => {
    expect(multitaskCommandPrompt("/multitask fix the README typo")).toBe("fix the README typo");
    expect(multitaskCommandPrompt("  /MultiTask   bump the version  ")).toBe("bump the version");
  });

  it("is not a command until something is asked for", () => {
    // The bare command is a draft mid-typing, not a dispatch with no prompt.
    expect(multitaskCommandPrompt("/multitask")).toBeNull();
    expect(multitaskCommandPrompt("/multitask   ")).toBeNull();
    expect(multitaskCommandPrompt("tell me about /multitask")).toBeNull();
    expect(multitaskCommandPrompt("/multitasking is hard")).toBeNull();
  });
});

function session(
  id: string,
  workspaceId: string,
  overrides: Partial<SessionSummary> = {}
): SessionSummary {
  return {
    id,
    workspaceId,
    provider: "claude",
    modelLabel: "Opus 5",
    modelId: "claude-opus-5",
    permissionMode: "auto-approve",
    providerConversationId: null,
    prompt: "Go",
    state: "running",
    attention: "normal",
    startedAt: "2026-09-02T10:00:00.000Z",
    completedAt: null,
    lastActivityAt: "2026-09-02T10:00:00.000Z",
    ...overrides
  };
}

function workspace(id: string): WorkspaceSummary {
  return {
    id,
    projectId: "project-1",
    taskLabel: id,
    branch: "main",
    baseRef: "main",
    path: "/tmp/repo",
    state: "running",
    sharedWorkspace: true,
    kind: "git",
    dirty: false,
    changedFiles: 0,
    lastActivityAt: "2026-09-02T10:00:00.000Z",
    pinned: false,
    priorityDismissedAt: null,
    priorityAddedAt: null
  };
}

describe("hiddenMultitaskWorkspaceIds", () => {
  it("hides a multitask, because the chat that dispatched it shows it", () => {
    const sessions = [
      session("parent", "workspace-parent"),
      session("child", "workspace-child", {
        launchedBySessionId: "parent",
        launchKind: "multitask"
      }),
      // An agent-launched session is a chat of its own and keeps its row.
      session("launched", "workspace-launched", { launchedBySessionId: "parent" })
    ];

    expect([...hiddenMultitaskWorkspaceIds(sessions)]).toEqual(["workspace-child"]);
  });

  it("gives an orphan its row back", () => {
    // With the launching chat gone there is nowhere else to reach it from, and
    // its checkout may still hold uncommitted work.
    const sessions = [
      session("child", "workspace-child", {
        launchedBySessionId: "pruned-parent",
        launchKind: "multitask"
      })
    ];

    expect(hiddenMultitaskWorkspaceIds(sessions).size).toBe(0);
  });
});

describe("multitasksByParentSession", () => {
  it("groups each multitask under the chat that dispatched it, with its workspace", () => {
    const child = session("child", "workspace-child", {
      launchedBySessionId: "parent",
      launchKind: "multitask"
    });
    const grouped = multitasksByParentSession(
      [session("parent", "workspace-parent"), child],
      [workspace("workspace-parent"), workspace("workspace-child")]
    );

    expect(grouped.get("parent")).toEqual([
      { session: child, workspace: workspace("workspace-child") }
    ]);
    expect(grouped.has("child")).toBe(false);
  });
});
