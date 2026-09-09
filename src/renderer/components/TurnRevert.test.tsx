import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi, Checkpoint, RewindPreview } from "../../shared/types.js";
import { TurnRevert } from "./TurnRevert.js";

function checkpoint(): Checkpoint {
  return {
    id: "checkpoint-1", workspaceId: "w1", sessionId: "s1", label: "Before turn",
    branch: "main", headSha: "abc", worktreeTree: "tree-1", indexTree: "index-1",
    untrackedPaths: [], turnBoundary: "event-1", providerConversationId: null,
    recoveryOf: null, createdAt: "2026-09-08T08:00:00.000Z"
  };
}

function preview(overrides: Partial<RewindPreview> = {}): RewindPreview {
  return {
    checkpoint: checkpoint(),
    currentFingerprint: { headSha: "abc", branch: "main", worktreeTree: "tree-2", indexTree: "index-2" },
    changedPaths: ["src/auth/token.ts"],
    deletedPaths: ["src/auth/old.ts"],
    ...overrides
  };
}

const checkpoints = {
  list: vi.fn<ArgmaxApi["checkpoints"]["list"]>(),
  previewRewind: vi.fn<ArgmaxApi["checkpoints"]["previewRewind"]>(),
  rewindFiles: vi.fn<ArgmaxApi["checkpoints"]["rewindFiles"]>()
};

beforeEach(() => {
  Object.values(checkpoints).forEach((method) => method.mockReset());
  checkpoints.previewRewind.mockResolvedValue(preview());
  checkpoints.rewindFiles.mockResolvedValue({
    checkpoint: checkpoint(),
    recoveryCheckpoint: { ...checkpoint(), id: "recovery", label: "Recovery" },
    restoredPaths: ["src/auth/token.ts"]
  });
  window.argmax = { checkpoints } as unknown as ArgmaxApi;
});

afterEach(() => { delete (window as { argmax?: ArgmaxApi }).argmax; });

function renderRevert(onReverted = vi.fn()) {
  render(<TurnRevert workspaceId="w1" checkpointId="checkpoint-1" onReverted={onReverted} />);
  return onReverted;
}

describe("TurnRevert", () => {
  it("prices the change before committing it", async () => {
    renderRevert();
    fireEvent.click(screen.getByRole("button", { name: "Revert to here" }));

    // Two changed paths, one of them a deletion: the count is what the user
    // weighs before confirming.
    expect(await screen.findByText(/Restores 2 files to before this turn/)).toBeInTheDocument();
    expect(checkpoints.rewindFiles).not.toHaveBeenCalled();
  });

  it("says why it cannot revert when no checkpoint was saved", async () => {
    // The turn keeps its Revert control rather than losing it, so a missing
    // checkpoint reads as a thing that happened and not as a broken button.
    render(
      <TurnRevert
        workspaceId="w1"
        unavailableReason="No checkpoint was saved before this turn. Disk was full."
        onReverted={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Revert to here" }));

    expect(await screen.findByText(/No checkpoint was saved before this turn/)).toBeInTheDocument();
    expect(checkpoints.previewRewind).not.toHaveBeenCalled();
  });

  it("restores the files on confirm and reports back", async () => {
    const onReverted = renderRevert();
    fireEvent.click(screen.getByRole("button", { name: "Revert to here" }));
    fireEvent.click(await screen.findByRole("button", { name: "Revert files" }));

    await waitFor(() => expect(checkpoints.rewindFiles).toHaveBeenCalledWith({
      workspaceId: "w1",
      checkpointId: "checkpoint-1",
      expectedFingerprint: preview().currentFingerprint
    }));
    expect(onReverted).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Revert to here" })).not.toBeInTheDocument()
    );
  });

  it("commits nothing when the confirm is dismissed", async () => {
    renderRevert();
    fireEvent.click(screen.getByRole("button", { name: "Revert to here" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Revert to here" })).not.toBeInTheDocument()
    );
    expect(checkpoints.rewindFiles).not.toHaveBeenCalled();
  });

  it("says so when a turn changed nothing on disk", async () => {
    checkpoints.previewRewind.mockResolvedValue(preview({ changedPaths: [], deletedPaths: [] }));
    renderRevert();
    fireEvent.click(screen.getByRole("button", { name: "Revert to here" }));
    expect(await screen.findByText(/No working files change/)).toBeInTheDocument();
  });

  /// A rewind refused by the backend (the checkout moved to another commit)
  /// has to say why rather than looking like a click that never landed.
  it("surfaces a refused rewind as an alert", async () => {
    checkpoints.rewindFiles.mockRejectedValue(new Error("The checkout moved to another revision"));
    renderRevert();
    fireEvent.click(screen.getByRole("button", { name: "Revert to here" }));
    fireEvent.click(await screen.findByRole("button", { name: "Revert files" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The checkout moved to another revision");
  });

  it("cannot revert while the turn's checkout is still moving", () => {
    render(
      <TurnRevert workspaceId="w1" checkpointId="checkpoint-1" disabled onReverted={vi.fn()} />
    );
    expect(screen.getByRole("button", { name: "Revert to here" })).toBeDisabled();
  });
});
