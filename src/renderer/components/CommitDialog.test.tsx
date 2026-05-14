import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangedFileSummary, GitCommitInput, GitCommitResult } from "../../shared/types.js";
import { CommitDialog } from "./CommitDialog.js";

const FILES: ChangedFileSummary[] = [
  { path: "src/a.ts", status: "modified", additions: 4, deletions: 1 },
  { path: "src/b.ts", status: "added", additions: 12, deletions: 0 }
];

function installArgmax(commitMock: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(window, "argmax", {
    configurable: true,
    writable: true,
    value: {
      git: {
        commit: commitMock,
        push: vi.fn(),
        createBranch: vi.fn(),
        viewOrCreatePr: vi.fn()
      }
    }
  });
}

describe("CommitDialog", () => {
  let commitMock: ReturnType<typeof vi.fn<(input: GitCommitInput) => Promise<GitCommitResult>>>;

  beforeEach(() => {
    commitMock = vi.fn<(input: GitCommitInput) => Promise<GitCommitResult>>();
    installArgmax(commitMock);
  });

  afterEach(() => {
    cleanup();
    delete (window as { argmax?: unknown }).argmax;
  });

  it("renders nothing when closed", () => {
    render(
      <CommitDialog
        open={false}
        onClose={() => {}}
        workspaceId="workspace-1"
        files={FILES}
        defaultMessage="feat: review wiring"
      />
    );
    expect(screen.queryByRole("dialog", { name: "Commit selected changes" })).not.toBeInTheDocument();
  });

  it("pre-selects every changed file and pre-fills the message", () => {
    render(
      <CommitDialog
        open
        onClose={() => {}}
        workspaceId="workspace-1"
        files={FILES}
        defaultMessage="feat: review wiring"
      />
    );
    expect(screen.getByRole("dialog", { name: "Commit selected changes" })).toBeInTheDocument();
    const messageBox = screen.getByLabelText<HTMLTextAreaElement>("Commit message");
    expect(messageBox.value).toBe("feat: review wiring");
    expect(screen.getByLabelText<HTMLInputElement>("Stage src/a.ts").checked).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>("Stage src/b.ts").checked).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>("Stage all files").checked).toBe(true);
  });

  it("calls git.commit with the selected files + message, then closes", async () => {
    commitMock.mockResolvedValue({ commitSha: "abcdef1234567890", branch: "argmax/review" });
    const onClose = vi.fn();
    const onCommitted = vi.fn();
    render(
      <CommitDialog
        open
        onClose={onClose}
        workspaceId="workspace-1"
        files={FILES}
        defaultMessage="feat: review wiring"
        onCommitted={onCommitted}
      />
    );

    fireEvent.click(screen.getByLabelText("Stage src/b.ts"));

    const messageBox = screen.getByLabelText<HTMLTextAreaElement>("Commit message");
    fireEvent.change(messageBox, { target: { value: "fix: tighten review" } });

    fireEvent.click(screen.getByRole("button", { name: "Commit" }));

    await waitFor(() => expect(commitMock).toHaveBeenCalledTimes(1));
    expect(commitMock).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      message: "fix: tighten review",
      selectedFiles: ["src/a.ts"]
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onCommitted).toHaveBeenCalledWith({ commitSha: "abcdef1234567890", branch: "argmax/review" });
  });

  it("keeps the dialog open and surfaces an inline error on IPC failure", async () => {
    commitMock.mockRejectedValue(new Error("git refused"));
    const onClose = vi.fn();
    render(
      <CommitDialog
        open
        onClose={onClose}
        workspaceId="workspace-1"
        files={FILES}
        defaultMessage="feat: review wiring"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Commit" }));

    await waitFor(() => expect(commitMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("alert")).toHaveTextContent("git refused");
    expect(screen.getByRole("dialog", { name: "Commit selected changes" })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("disables the Commit button when no files are staged", () => {
    render(
      <CommitDialog
        open
        onClose={() => {}}
        workspaceId="workspace-1"
        files={FILES}
        defaultMessage="feat: review wiring"
      />
    );

    fireEvent.click(screen.getByLabelText("Stage all files"));
    expect(screen.getByRole("button", { name: "Commit" })).toBeDisabled();
  });

  it("shows an empty state and keeps Commit disabled when there are no changed files", () => {
    render(
      <CommitDialog
        open
        onClose={() => {}}
        workspaceId="workspace-1"
        files={[]}
        defaultMessage="feat: review wiring"
      />
    );
    expect(screen.getByText("No changes to commit.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Commit" })).toBeDisabled();
  });
});
