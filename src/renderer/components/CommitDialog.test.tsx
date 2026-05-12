import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangedFileSummary, CommitPreparation, PrepareCommitInput } from "../../shared/types.js";
import { CommitDialog } from "./CommitDialog.js";

const FILES: ChangedFileSummary[] = [
  { path: "src/a.ts", status: "modified", additions: 4, deletions: 1 },
  { path: "src/b.ts", status: "added", additions: 12, deletions: 0 }
];

describe("CommitDialog", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders nothing when closed", () => {
    const onPrepareCommit = vi.fn<(input: PrepareCommitInput) => Promise<CommitPreparation>>();
    render(
      <CommitDialog
        open={false}
        onClose={() => {}}
        workspaceId="workspace-1"
        files={FILES}
        defaultMessage="feat: review wiring"
        onPrepareCommit={onPrepareCommit}
      />
    );
    expect(screen.queryByRole("dialog", { name: "Commit selected changes" })).not.toBeInTheDocument();
  });

  it("pre-selects every changed file and pre-fills the message", () => {
    const onPrepareCommit = vi.fn<(input: PrepareCommitInput) => Promise<CommitPreparation>>();
    render(
      <CommitDialog
        open
        onClose={() => {}}
        workspaceId="workspace-1"
        files={FILES}
        defaultMessage="feat: review wiring"
        onPrepareCommit={onPrepareCommit}
      />
    );
    expect(screen.getByRole("dialog", { name: "Commit selected changes" })).toBeInTheDocument();
    const messageBox = screen.getByLabelText<HTMLTextAreaElement>("Commit message");
    expect(messageBox.value).toBe("feat: review wiring");
    expect(screen.getByLabelText<HTMLInputElement>("Stage src/a.ts").checked).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>("Stage src/b.ts").checked).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>("Stage all files").checked).toBe(true);
  });

  it("submits the selected files + message and renders the prepared plan", async () => {
    const preparation: CommitPreparation = {
      workspaceId: "workspace-1",
      branch: "argmax/review",
      selectedFiles: ["src/a.ts"],
      message: "fix: tighten review",
      commands: ["git add -- src/a.ts", "git commit -m 'fix: tighten review'"]
    };
    const onPrepareCommit = vi
      .fn<(input: PrepareCommitInput) => Promise<CommitPreparation>>()
      .mockResolvedValue(preparation);
    render(
      <CommitDialog
        open
        onClose={() => {}}
        workspaceId="workspace-1"
        files={FILES}
        defaultMessage="feat: review wiring"
        onPrepareCommit={onPrepareCommit}
      />
    );

    fireEvent.click(screen.getByLabelText("Stage src/b.ts"));

    const messageBox = screen.getByLabelText<HTMLTextAreaElement>("Commit message");
    fireEvent.change(messageBox, { target: { value: "fix: tighten review" } });

    fireEvent.click(screen.getByRole("button", { name: "Commit" }));

    await waitFor(() => expect(onPrepareCommit).toHaveBeenCalledTimes(1));
    expect(onPrepareCommit).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      selectedFiles: ["src/a.ts"],
      message: "fix: tighten review"
    });

    expect(await screen.findByLabelText("Prepared commit plan")).toBeInTheDocument();
    expect(screen.getByText("git add -- src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("git commit -m 'fix: tighten review'")).toBeInTheDocument();
  });

  it("keeps the dialog open and bubbles the rejection to the caller on IPC error", async () => {
    const failure = new Error("git refused");
    const onPrepareCommit = vi
      .fn<(input: PrepareCommitInput) => Promise<CommitPreparation>>()
      .mockRejectedValue(failure);
    const onClose = vi.fn();
    render(
      <CommitDialog
        open
        onClose={onClose}
        workspaceId="workspace-1"
        files={FILES}
        defaultMessage="feat: review wiring"
        onPrepareCommit={onPrepareCommit}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Commit" }));

    await waitFor(() => expect(onPrepareCommit).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText("Prepared commit plan")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Commit selected changes" })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("disables the Commit button when no files are staged", () => {
    const onPrepareCommit = vi.fn<(input: PrepareCommitInput) => Promise<CommitPreparation>>();
    render(
      <CommitDialog
        open
        onClose={() => {}}
        workspaceId="workspace-1"
        files={FILES}
        defaultMessage="feat: review wiring"
        onPrepareCommit={onPrepareCommit}
      />
    );

    fireEvent.click(screen.getByLabelText("Stage all files"));
    expect(screen.getByRole("button", { name: "Commit" })).toBeDisabled();
  });
});
