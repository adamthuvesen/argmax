import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary, WorkspaceSummary } from "../../shared/types.js";
import { usePriorityDemotion } from "./usePriorityDemotion.js";

function workspace(id: string, overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return {
    id,
    projectId: "project-1",
    taskLabel: `Task ${id}`,
    branch: `argmax/${id}`,
    baseRef: "main",
    path: `/tmp/${id}`,
    state: "waiting",
    sharedWorkspace: false,
    kind: "git",
    dirty: false,
    changedFiles: 0,
    lastActivityAt: "2026-05-12T15:54:00.000Z",
    pinned: false,
    priorityDismissedAt: null,
    priorityAddedAt: null,
    ...overrides
  };
}

function session(
  workspaceId: string,
  attention: SessionSummary["attention"],
  overrides: Partial<SessionSummary> = {}
): SessionSummary {
  return {
    id: `session-${workspaceId}`,
    workspaceId,
    provider: "codex",
    modelLabel: "GPT-5.5",
    modelId: "gpt-5.5",
    permissionMode: "auto-approve",
    agentMode: "auto",
    providerConversationId: null,
    prompt: "Do the thing",
    state: attention === "blocked" || attention === "approval-needed" ? "waiting" : "complete",
    attention,
    attentionChangedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    startedAt: "2026-05-12T14:00:00.000Z",
    completedAt: null,
    lastActivityAt: "2026-05-12T15:54:00.000Z",
    ...overrides
  };
}

describe("usePriorityDemotion", () => {
  afterEach(() => {
    cleanup();
  });

  it("does not demote while the waiting session is still selected", () => {
    const onDemote = vi.fn();
    const waiting = workspace("w-wait");
    renderHook(() =>
      usePriorityDemotion({
        selectedWorkspaceId: "w-wait",
        isSettingsOpen: false,
        isFullLauncherOpen: false,
        workspaces: [waiting],
        sessions: [session("w-wait", "blocked")],
        onDemote
      })
    );
    expect(onDemote).not.toHaveBeenCalled();
  });

  it("demotes a waiting session after the user selects another session", () => {
    const onDemote = vi.fn();
    const waiting = workspace("w-wait");
    const other = workspace("w-other", { state: "complete" });
    const { rerender } = renderHook(
      (props: { selectedWorkspaceId: string | null }) =>
        usePriorityDemotion({
          selectedWorkspaceId: props.selectedWorkspaceId,
          isSettingsOpen: false,
          isFullLauncherOpen: false,
          workspaces: [waiting, other],
          sessions: [session("w-wait", "blocked"), session("w-other", "review-ready")],
          onDemote
        }),
      { initialProps: { selectedWorkspaceId: "w-wait" } }
    );

    rerender({ selectedWorkspaceId: "w-other" });
    expect(onDemote).toHaveBeenCalledTimes(1);
    expect(onDemote).toHaveBeenCalledWith("w-wait");
  });

  it("demotes a waiting session when the user opens Settings", () => {
    const onDemote = vi.fn();
    const waiting = workspace("w-wait");
    const { rerender } = renderHook(
      (props: { isSettingsOpen: boolean }) =>
        usePriorityDemotion({
          selectedWorkspaceId: "w-wait",
          isSettingsOpen: props.isSettingsOpen,
          isFullLauncherOpen: false,
          workspaces: [waiting],
          sessions: [session("w-wait", "approval-needed")],
          onDemote
        }),
      { initialProps: { isSettingsOpen: false } }
    );

    rerender({ isSettingsOpen: true });
    expect(onDemote).toHaveBeenCalledWith("w-wait");
  });

  it("demotes a waiting session when the user opens the launcher", () => {
    const onDemote = vi.fn();
    const waiting = workspace("w-wait");
    const { rerender } = renderHook(
      (props: { isFullLauncherOpen: boolean }) =>
        usePriorityDemotion({
          selectedWorkspaceId: "w-wait",
          isSettingsOpen: false,
          isFullLauncherOpen: props.isFullLauncherOpen,
          workspaces: [waiting],
          sessions: [session("w-wait", "blocked")],
          onDemote
        }),
      { initialProps: { isFullLauncherOpen: false } }
    );

    rerender({ isFullLauncherOpen: true });
    expect(onDemote).toHaveBeenCalledWith("w-wait");
  });

  it("demotes a waiting session when the user opens another project", () => {
    const onDemote = vi.fn();
    const waiting = workspace("w-wait");
    const initialProps: { selectedWorkspaceId: string | null } = { selectedWorkspaceId: "w-wait" };
    const { rerender } = renderHook(
      (props: { selectedWorkspaceId: string | null }) =>
        usePriorityDemotion({
          selectedWorkspaceId: props.selectedWorkspaceId,
          isSettingsOpen: false,
          isFullLauncherOpen: false,
          workspaces: [waiting],
          sessions: [session("w-wait", "blocked")],
          onDemote
        }),
      { initialProps }
    );

    rerender({ selectedWorkspaceId: null });
    expect(onDemote).toHaveBeenCalledWith("w-wait");
  });

  it("does not demote a working session after the user leaves", () => {
    const onDemote = vi.fn();
    const running = workspace("w-run", { state: "running" });
    const initialProps: { selectedWorkspaceId: string | null } = { selectedWorkspaceId: "w-run" };
    const { rerender } = renderHook(
      (props: { selectedWorkspaceId: string | null }) =>
        usePriorityDemotion({
          selectedWorkspaceId: props.selectedWorkspaceId,
          isSettingsOpen: false,
          isFullLauncherOpen: false,
          workspaces: [running],
          sessions: [session("w-run", "approval-needed", { state: "running" })],
          onDemote
        }),
      { initialProps }
    );

    rerender({ selectedWorkspaceId: null });
    expect(onDemote).not.toHaveBeenCalled();
  });

  it("demotes review-ready attention after the user leaves", () => {
    const onDemote = vi.fn();
    const ready = workspace("w-ready", { state: "complete" });
    const initialProps: { selectedWorkspaceId: string | null } = { selectedWorkspaceId: "w-ready" };
    const { rerender } = renderHook(
      (props: { selectedWorkspaceId: string | null }) =>
        usePriorityDemotion({
          selectedWorkspaceId: props.selectedWorkspaceId,
          isSettingsOpen: false,
          isFullLauncherOpen: false,
          workspaces: [ready],
          sessions: [session("w-ready", "review-ready")],
          onDemote
        }),
      { initialProps }
    );

    rerender({ selectedWorkspaceId: null });
    expect(onDemote).toHaveBeenCalledWith("w-ready");
  });
});
