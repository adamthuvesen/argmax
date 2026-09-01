import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewState } from "../hooks/useReviewState.js";
import {
  baseSession,
  project,
  reviewStub,
  workspace
} from "../../test/sessionConversationTestHarness.js";
import { SessionConversation } from "./SessionConversation.js";

function renderPane(
  options: {
    isLogOpen?: boolean;
    onToggleWorkspaceCard?: () => void;
    review?: ReviewState;
    workspace?: typeof workspace;
    workspaceCardEnabled?: boolean;
  } = {}
) {
  return render(
    <SessionConversation
      events={[]}
      isLogOpen={options.isLogOpen ?? false}
      onSendSessionInput={vi.fn().mockResolvedValue(undefined)}
      onTerminateSession={vi.fn().mockResolvedValue(undefined)}
      onClearSession={vi.fn().mockResolvedValue(undefined)}
      onCancelQueuedMessage={vi.fn().mockResolvedValue(undefined)}
      onSendQueuedMessageNow={vi.fn().mockResolvedValue(undefined)}
      onToggleLog={vi.fn()}
      onToggleWorkspaceCard={options.onToggleWorkspaceCard ?? vi.fn()}
      project={project}
      rawOutputs={[]}
      review={options.review ?? reviewStub()}
      session={baseSession()}
      workspaceCardEnabled={options.workspaceCardEnabled ?? true}
      workspace={options.workspace ?? workspace}
    />
  );
}

describe("SessionConversation workspace card", () => {
  afterEach(() => {
    cleanup();
  });

  it("floats the card beside the transcript when nothing is docked on the right", () => {
    renderPane();

    expect(screen.getByRole("complementary", { name: "Workspace" })).toBeInTheDocument();
  });

  it("steps aside for the review panel, which already shows what the card summarizes", () => {
    renderPane({ review: reviewStub({ isPanelOpen: true }) });

    expect(screen.queryByRole("complementary", { name: "Workspace" })).not.toBeInTheDocument();
  });

  it("steps aside for the debug log panel too", () => {
    renderPane({ isLogOpen: true });

    expect(screen.queryByRole("complementary", { name: "Workspace" })).not.toBeInTheDocument();
  });

  it("stays hidden while the preference is off", () => {
    renderPane({ workspaceCardEnabled: false });

    expect(screen.queryByRole("complementary", { name: "Workspace" })).not.toBeInTheDocument();
  });

  it("toggles from the session actions menu, which reports the preference rather than what is on screen", () => {
    const onToggleWorkspaceCard = vi.fn();
    renderPane({ review: reviewStub({ isPanelOpen: true }), onToggleWorkspaceCard });

    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    const item = screen.getByRole("menuitemcheckbox", { name: "Workspace card" });
    // The card is off-screen behind the review panel, but the preference is on.
    expect(item).toHaveAttribute("aria-checked", "true");

    fireEvent.click(item);
    expect(onToggleWorkspaceCard).toHaveBeenCalledTimes(1);
  });

  it("explains why enabling the card changes nothing on a side chat", async () => {
    const sideChat = { ...workspace, kind: "scratch" as const };
    renderPane({ workspace: sideChat, workspaceCardEnabled: false });

    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Workspace card" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Workspace card is on. It shows up on sessions that have a git worktree."
    );
  });
});
