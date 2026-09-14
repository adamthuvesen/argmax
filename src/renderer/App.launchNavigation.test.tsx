import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App.js";
import {
  createCurrentWorkspace,
  createIsolatedWorkspace,
  dashboardDeltaListener,
  dashboardList,
  dashboardListSnapshot,
  launchProvider,
  setupAppTestMocks,
  snapshot
} from "../test/appTestHarness.js";

describe("App launch navigation", () => {
  beforeEach(() => setupAppTestMocks());
  afterEach(() => cleanup());

  describe.each([false, true])("dashboard push during launch: %s", (pushDuringLaunch) => {
    it.each([false, true])("keeps the launched chat open after a stale read, hidden grid: %s", async (withHiddenGrid) => {
      const workspace = { ...snapshot.workspaces[0], id: "workspace-new", taskLabel: "Newly launched chat" };
      const session = { ...snapshot.sessions[0], id: "session-new", workspaceId: workspace.id };
      createCurrentWorkspace.mockResolvedValue(workspace);
      createIsolatedWorkspace.mockResolvedValue(workspace);
      launchProvider.mockImplementation(() => new Promise((resolve) => setTimeout(() => {
        if (pushDuringLaunch) dashboardDeltaListener?.({ sessions: [session] });
        resolve(session);
      }, 0)));
      render(<App />);
      await screen.findByLabelText("Task prompt");
      if (withHiddenGrid) {
        fireEvent.click(screen.getByRole("button", { name: "Build dashboard" }));
        await screen.findByRole("group", { name: "Chat panes" });
        fireEvent.click(screen.getByRole("button", { name: "New chat" }));
      }

      // Hold a dashboard read taken before the new chat exists until after
      // launch has selected it. The real runtime refreshes on metadata hints.
      let resolveRead!: (value: ReturnType<typeof dashboardListSnapshot>) => void;
      const oldRead = new Promise<ReturnType<typeof dashboardListSnapshot>>((resolve) => { resolveRead = resolve; });
      dashboardList.mockClear();
      dashboardList.mockReturnValueOnce(oldRead);
      act(() => dashboardDeltaListener?.({ dashboardChanged: true }));
      await waitFor(() => expect(dashboardList).toHaveBeenCalledOnce());

      fireEvent.change(await screen.findByLabelText("Task prompt"), { target: { value: "Newly launched chat" } });
      fireEvent.click(screen.getByRole("button", { name: "Start agent" }));
      await screen.findByRole("region", { name: "Newly launched chat" });
      await act(async () => {
        resolveRead(dashboardListSnapshot(snapshot));
        await oldRead;
      });
      expect(screen.getByRole("region", { name: "Newly launched chat" })).toBeInTheDocument();

      // A subsequent update used to restore just the sidebar row, leaving
      // the empty composer behind because reconciliation had closed the pane.
      act(() => { dashboardDeltaListener?.({ workspaces: [workspace], sessions: [session] }); });
      expect(screen.getByRole("button", { name: "Newly launched chat" })).toHaveAttribute("aria-current", "true");
      expect(screen.getByRole("region", { name: "Newly launched chat" })).toBeInTheDocument();
      expect(screen.queryByLabelText("Task prompt")).not.toBeInTheDocument();
    });
  });
});
