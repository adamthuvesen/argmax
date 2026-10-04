import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App.js";
import { createCurrentWorkspace, createIsolatedWorkspace, launchProvider, mockDashboardSnapshot, setupAppTestMocks, snapshot } from "../test/appTestHarness.js";
import { NEW_SESSION_MODE_KEY } from "./lib/newSessionMode.js";

async function openSessionPane(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
  expect(await screen.findByRole("region", { name: "Conversation" })).toBeInTheDocument();
}

// The seeded session runs on Codex, so "Sonnet 5.5" crosses providers and raises
// the confirmation. The path under test is the recommended one: the launcher
// has to come up already aimed at the picked model, holding the follow-up the
// user had started for the old agent.
describe("provider switch — new session instead", () => {
  beforeEach(() => {
    setupAppTestMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it.each(["full", "embedded"])("replaces the current view with the picked model and carried draft in %s mode", async (mode) => {
    window.localStorage.setItem(NEW_SESSION_MODE_KEY, mode);
    const workspace = { ...snapshot.workspaces[0], id: "workspace-new", taskLabel: "Second opinion" };
    const session = { ...snapshot.sessions[0], id: "session-new", workspaceId: workspace.id, provider: "claude" as const };
    createCurrentWorkspace.mockResolvedValue(workspace);
    createIsolatedWorkspace.mockResolvedValue(workspace);
    launchProvider.mockResolvedValue(session);
    // Provider switching is gated to idle sessions: the seeded session is
    // running, which locks the picker to its own provider.
    mockDashboardSnapshot({
      ...snapshot,
      workspaces: snapshot.workspaces.map((workspace) => ({ ...workspace, state: "complete" })),
      sessions: snapshot.sessions.map((session) => ({
        ...session,
        state: "complete",
        providerConversationId: "conv-1"
      }))
    });
    render(<App />);
    await openSessionPane();

    fireEvent.change(screen.getByRole("textbox", { name: "Chat prompt" }), {
      target: { value: "Second opinion on the auth guard" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Chat model" }));
    fireEvent.click(
      within(screen.getByRole("listbox", { name: "Chat model" })).getByRole("button", {
        name: "Sonnet 5.5"
      })
    );
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "New chat" })
    );

    expect(await screen.findByLabelText("Task prompt")).toHaveValue("Second opinion on the auth guard");
    expect(screen.getByRole("button", { name: "Switch model" })).toHaveTextContent("Sonnet 5.5");
    expect(screen.queryByRole("textbox", { name: "Chat prompt" })).not.toBeInTheDocument();
    expect(screen.queryByText("The grid is full. Close a pane to start a new chat here.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Start agent" }));
    expect(await screen.findByRole("region", { name: "Second opinion" })).toBeInTheDocument();
    expect(launchProvider).toHaveBeenCalledWith(expect.objectContaining({
      provider: "claude",
      prompt: "Second opinion on the auth guard"
    }));
    expect(screen.queryByRole("region", { name: "Build dashboard" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("textbox", { name: "Chat prompt" })).toHaveLength(1);
  });
});
