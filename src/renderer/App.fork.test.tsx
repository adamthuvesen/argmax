import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import {
  dashboardDeltaListener,
  mockDashboardSnapshot,
  setupAppTestMocks,
  snapshot
} from "../test/appTestHarness.js";

describe("App fork navigation", () => {
  beforeEach(() => setupAppTestMocks());
  afterEach(() => cleanup());

  it("opens the fork the moment it is created, before the dashboard has a row for it", async () => {
    // The fork button is provider-gated to Claude and shows on a finished turn.
    mockDashboardSnapshot({
      ...snapshot,
      sessions: snapshot.sessions.map((session) =>
        session.workspaceId === "workspace-1"
          ? { ...session, provider: "claude" as const, state: "complete" as const }
          : session
      )
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    await screen.findByRole("region", { name: "Build dashboard" });

    // The fork exists in the backend, but no dashboard read or push has carried
    // its rows yet: only the fork response knows about it.
    const workspace = { ...snapshot.workspaces[0], id: "workspace-fork", taskLabel: "Build dashboard (fork)" };
    const session = { ...snapshot.sessions[0], id: "session-fork", workspaceId: workspace.id, provider: "claude" as const };
    const fork = vi.fn().mockResolvedValue({ workspace, session, fork: { id: "fork-1" } });
    window.argmax!.session.fork = fork;
    window.argmax!.session.forkLineage = vi.fn((input: { sessionId: string }) =>
      Promise.resolve(
        input.sessionId === session.id
          ? { forkId: "fork-1", sourceSessionId: "session-1", boundaryEventId: null, workspace: "shared", lastMergedThroughEventId: null }
          : null
      )
    );

    fireEvent.click(await screen.findByRole("button", { name: "Fork from this turn" }));
    await waitFor(() => expect(fork).toHaveBeenCalledOnce());

    // The new chat is on screen and focused; the source pane gave way to it.
    expect(await screen.findByRole("region", { name: "Build dashboard (fork)" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Forked chat" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Build dashboard" })).not.toBeInTheDocument();

    // The row that follows from the dashboard keeps it open and selected.
    act(() => dashboardDeltaListener?.({ workspaces: [workspace], sessions: [session] }));
    expect(screen.getByRole("region", { name: "Build dashboard (fork)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Build dashboard (fork)" })).toHaveAttribute("aria-current", "true");
  });
});
