import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi, Checkpoint, RewindPreview, SessionSummary, WorkspaceSummary } from "../../shared/types.js";
import { defaultDashboardSnapshot } from "../../test/fixtures/dashboardSnapshot.js";
import { CheckpointControls } from "./CheckpointControls.js";

const workspace: WorkspaceSummary = { ...defaultDashboardSnapshot.workspaces[0], state: "complete" };
const session: SessionSummary = { ...defaultDashboardSnapshot.sessions[0], state: "complete", attention: "normal" };

function checkpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    id: "checkpoint-1", workspaceId: workspace.id, sessionId: session.id, label: "Before refactor",
    branch: "argmax/dashboard", headSha: "abc123", worktreeTree: "tree-1", indexTree: "index-1",
    untrackedPaths: ["new.txt"], turnBoundary: "event-1", providerConversationId: "provider-1",
    recoveryOf: null, createdAt: "2026-09-08T08:00:00.000Z", ...overrides
  };
}

function preview(value = checkpoint()): RewindPreview {
  return {
    checkpoint: value,
    currentFingerprint: { headSha: "abc123", branch: "argmax/dashboard", worktreeTree: "tree-2", indexTree: "index-2" },
    changedPaths: ["tracked.txt"],
    deletedPaths: ["later.txt"]
  };
}

const checkpoints = {
  create: vi.fn<ArgmaxApi["checkpoints"]["create"]>(),
  list: vi.fn<ArgmaxApi["checkpoints"]["list"]>(),
  previewRewind: vi.fn<ArgmaxApi["checkpoints"]["previewRewind"]>(),
  rewindFiles: vi.fn<ArgmaxApi["checkpoints"]["rewindFiles"]>()
};

beforeEach(() => {
  vi.restoreAllMocks();
  Object.values(checkpoints).forEach((method) => method.mockReset());
  checkpoints.list.mockResolvedValue([]);
  checkpoints.create.mockResolvedValue(checkpoint());
  checkpoints.previewRewind.mockResolvedValue(preview());
  checkpoints.rewindFiles.mockResolvedValue({ checkpoint: checkpoint(), recoveryCheckpoint: checkpoint({ id: "recovery", label: "Recovery" }), restoredPaths: ["tracked.txt"] });
  window.argmax = { checkpoints } as unknown as ArgmaxApi;
});

afterEach(() => {
  delete (window as { argmax?: ArgmaxApi }).argmax;
});

describe("CheckpointControls", () => {
  it("creates a labelled checkpoint and refreshes the list", async () => {
    checkpoints.list.mockResolvedValueOnce([]).mockResolvedValueOnce([checkpoint()]);
    render(<CheckpointControls session={session} workspace={workspace} onRestored={vi.fn()} />);

    const toggle = screen.getByRole("button", { name: "Checkpoints" });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.change(await screen.findByRole("textbox", { name: "Checkpoint label" }), { target: { value: "Before review" } });
    fireEvent.click(screen.getByRole("button", { name: "Save checkpoint" }));

    await waitFor(() => expect(checkpoints.create).toHaveBeenCalledWith(expect.objectContaining({ label: "Before review", workspaceId: workspace.id, sessionId: session.id })));
    await waitFor(() => expect(checkpoints.list).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("status")).toHaveTextContent("Checkpoint saved.");
  });

  it("restores a preview, reports recovery, opens files, and refreshes checkpoints", async () => {
    const onRestored = vi.fn();
    checkpoints.list.mockResolvedValueOnce([checkpoint()]).mockResolvedValueOnce([checkpoint(), checkpoint({ id: "recovery", label: "Recovery" })]);
    render(<CheckpointControls session={session} workspace={workspace} onRestored={onRestored} />);

    fireEvent.click(screen.getByRole("button", { name: "Checkpoints" }));
    fireEvent.click(await screen.findByRole("button", { name: "Preview rewind to Before refactor" }));
    expect(await screen.findByRole("region", { name: "Rewind preview" })).toHaveTextContent("later.txt (remove)");
    fireEvent.click(screen.getByRole("button", { name: "Restore files" }));

    await waitFor(() => expect(checkpoints.rewindFiles).toHaveBeenCalledWith({ workspaceId: workspace.id, checkpointId: "checkpoint-1", expectedFingerprint: preview().currentFingerprint }));
    expect(onRestored).toHaveBeenCalledOnce();
    expect(await screen.findByRole("status")).toHaveTextContent("Recovery checkpoint: Recovery");
    await waitFor(() => expect(checkpoints.list).toHaveBeenCalledTimes(2));
  });

  it("drops a preview response that returns after the control closes", async () => {
    let resolvePreview: ((value: RewindPreview) => void) | undefined;
    checkpoints.list.mockResolvedValue([checkpoint()]);
    checkpoints.previewRewind.mockImplementation(() => new Promise((resolve) => { resolvePreview = resolve; }));
    render(<CheckpointControls session={session} workspace={workspace} onRestored={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Checkpoints" }));
    fireEvent.click(await screen.findByRole("button", { name: "Preview rewind to Before refactor" }));
    fireEvent.click(screen.getByRole("button", { name: "Checkpoints" }));
    resolvePreview?.(preview());

    await waitFor(() => expect(screen.queryByRole("region", { name: "Rewind preview" })).not.toBeInTheDocument());
  });

  it("surfaces a failed checkpoint request as an alert", async () => {
    checkpoints.create.mockRejectedValue(new Error("Git index is unmerged"));
    render(<CheckpointControls session={session} workspace={workspace} onRestored={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Checkpoints" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save checkpoint" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Git index is unmerged");
  });
});
