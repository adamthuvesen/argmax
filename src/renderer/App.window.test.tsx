import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App.js";
import {
  mockDashboardSnapshot,
  openSessionWindow,
  sessionRow,
  setupAppTestMocks,
  snapshot,
  workspaceRow
} from "../test/appTestHarness.js";

// A chat torn off into a second desktop window: the row action that opens
// one, and the boot of the window it opens (`?session=<id>`).
describe("App windows", () => {
  beforeEach(() => {
    setupAppTestMocks();
  });

  afterEach(() => {
    cleanup();
    window.history.replaceState(null, "", "/");
  });

  it("tears a chat off from the sidebar row's context menu", async () => {
    render(<App />);

    fireEvent.contextMenu(await screen.findByRole("button", { name: "Build dashboard" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in new window" }));

    await waitFor(() => {
      expect(openSessionWindow).toHaveBeenCalledWith({ sessionId: "session-1" });
    });
    expect(screen.queryByRole("menuitem", { name: "Open in new window" })).toBeNull();
  });

  it("boots a torn-off window on the chat named in its URL", async () => {
    const secondWorkspace = workspaceRow({});
    const secondSession = sessionRow({});
    mockDashboardSnapshot({
      ...snapshot,
      workspaces: [...snapshot.workspaces, secondWorkspace],
      sessions: [...snapshot.sessions, secondSession]
    });
    window.history.replaceState(null, "", `/?session=${secondSession.id}`);

    render(<App />);

    expect(await screen.findByRole("region", { name: "Second chat" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Build dashboard" })).toBeNull();
  });

  it("shows the launcher when the chat in the URL is gone", async () => {
    window.history.replaceState(null, "", "/?session=session-archived");

    render(<App />);

    expect(await screen.findByLabelText("Task prompt")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Build dashboard" })).toBeNull();
  });
});
