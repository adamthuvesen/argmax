import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App.js";
import type { WorkspaceSummary } from "../shared/types.js";
import { RANDOM_SESSION_ICON_KEY } from "./lib/uiPreferences.js";
import {
  dashboardDeltaListener,
  setWorkspaceIcon,
  setupAppTestMocks,
  snapshot
} from "../test/appTestHarness.js";

function externalWorkspace(overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return {
    ...snapshot.workspaces[0],
    id: "workspace-external",
    taskLabel: "Explore this repository",
    icon: null,
    iconColor: null,
    ...overrides
  };
}

describe("App random icons for externally launched sessions", () => {
  beforeEach(() => {
    setupAppTestMocks();
    window.localStorage.setItem(RANDOM_SESSION_ICON_KEY, "true");
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("assigns a random icon to a workspace another surface launched", async () => {
    // Agent-driven session control and the mobile companion create their
    // workspaces backend-side, so this renderer's launch-time setIcon never
    // ran for them — the delta arrival is the only hook left.
    render(<App />);
    await screen.findByLabelText("Task prompt");

    act(() => {
      dashboardDeltaListener?.({ workspaces: [externalWorkspace()] });
    });

    await waitFor(() => expect(setWorkspaceIcon).toHaveBeenCalledTimes(1));
    const input = setWorkspaceIcon.mock.calls[0]?.[0];
    expect(input?.workspaceId).toBe("workspace-external");
    expect(typeof input?.icon).toBe("string");
    expect(typeof input?.iconColor).toBe("string");
  });

  it("leaves pre-existing, already-iconed, and popup workspaces alone", async () => {
    render(<App />);
    await screen.findByLabelText("Task prompt");

    act(() => {
      dashboardDeltaListener?.({
        workspaces: [
          // Already in the boot snapshot: not newly launched.
          { ...snapshot.workspaces[0], taskLabel: "Renamed" },
          externalWorkspace({ id: "workspace-picked", icon: "Bird", iconColor: "blue" }),
          externalWorkspace({ id: "workspace-popup", kind: "popup", sharedWorkspace: true })
        ]
      });
    });

    await waitFor(() => expect(setWorkspaceIcon).not.toHaveBeenCalled());
  });

  it("does nothing when random session icons are disabled", async () => {
    window.localStorage.setItem(RANDOM_SESSION_ICON_KEY, "false");
    render(<App />);
    await screen.findByLabelText("Task prompt");

    act(() => {
      dashboardDeltaListener?.({ workspaces: [externalWorkspace()] });
    });

    await waitFor(() => expect(setWorkspaceIcon).not.toHaveBeenCalled());
  });
});
