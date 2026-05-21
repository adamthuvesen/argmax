import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CheckRun } from "../../shared/types.js";
import type { ReviewState } from "../hooks/useReviewState.js";
import { ChangedFilesCard } from "./ChangedFilesCard.js";

function reviewStub(overrides: Partial<ReviewState> = {}): ReviewState {
  return {
    files: [],
    filesState: "ready",
    filesError: null,
    selectedFilePath: null,
    diff: null,
    diffState: "idle",
    diffError: null,
    isPanelOpen: false,
    mode: "changes",
    setMode: () => {},
    workspaceFiles: {
      entries: [],
      listState: "idle",
      listError: null,
      tabs: [],
      activeTabPath: null,
      selectedPath: null,
      rootPath: null,
      preview: null,
      previewState: "idle",
      previewError: null,
      openFile: () => {},
      selectTab: () => {},
      closeTab: () => {},
      dirtyClosePrompt: null,
      saveDirtyTabAndClose: () => Promise.resolve(),
      discardDirtyTabAndClose: () => {},
      cancelDirtyTabClose: () => {},
      buffer: null,
      isDirty: false,
      diskMtimeMs: null,
      externalChange: false,
      saveState: "idle",
      saveError: null,
      canEdit: true,
      editFile: () => {},
      saveFile: () => Promise.resolve(),
      reloadFile: () => {},
      dismissExternalChange: () => {}
    },
    openFile: () => {},
    openPanelInFilesMode: () => {},
    openInFilesView: () => {},
    closePanel: () => {},
    togglePanel: () => {},
    toggleChangesPanel: () => {},
    ...overrides
  };
}

const PASSED_RUN: CheckRun = {
  id: "check-1",
  workspaceId: "workspace-1",
  command: "npm test",
  status: "passed",
  exitCode: 0,
  summary: "ok\n2 tests passed",
  startedAt: "2026-05-12T10:00:00.000Z",
  completedAt: "2026-05-12T10:00:12.500Z"
};

const FAILED_RUN: CheckRun = {
  id: "check-2",
  workspaceId: "workspace-1",
  command: "npm run lint",
  status: "failed",
  exitCode: 1,
  summary: "lint error: missing semicolon",
  startedAt: "2026-05-12T10:00:30.000Z",
  completedAt: "2026-05-12T10:00:34.000Z"
};

describe("ChangedFilesCard summary header", () => {
  afterEach(() => {
    cleanup();
  });

  it("opens the review panel in Changes mode when clicked", () => {
    const toggleChangesPanel = vi.fn();
    render(
      <ChangedFilesCard
        review={reviewStub({
          files: [
            { path: "src/a.ts", status: "modified", additions: 3, deletions: 1 },
            { path: "src/b.ts", status: "added", additions: 7, deletions: 0 }
          ],
          toggleChangesPanel
        })}
      />
    );

    const header = screen.getByRole("button", { name: "Open changed files in review panel" });
    expect(header).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(header);
    expect(toggleChangesPanel).toHaveBeenCalledTimes(1);
  });

  it("marks itself pressed when the panel is open in Changes mode and renders no inline file list", () => {
    render(
      <ChangedFilesCard
        review={reviewStub({
          files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 1 }],
          isPanelOpen: true,
          mode: "changes"
        })}
      />
    );

    expect(
      screen.getByRole("button", { name: "Open changed files in review panel" })
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("src/a.ts")).toBeNull();
  });
});

describe("ChangedFilesCard checks list", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders one row per registered check and surfaces last status + duration", () => {
    render(
      <ChangedFilesCard
        review={reviewStub()}
        workspaceId="workspace-1"
        checkCommands={["npm test", "npm run lint"]}
        checks={[PASSED_RUN, FAILED_RUN]}
        onRunCheck={vi.fn<(workspaceId: string, command: string) => Promise<void>>()}
      />
    );

    const passedRow = screen.getByLabelText("Check npm test");
    expect(passedRow).toHaveAttribute("data-status", "passed");
    expect(passedRow.textContent).toContain("12.5s");

    const failedRow = screen.getByLabelText("Check npm run lint");
    expect(failedRow).toHaveAttribute("data-status", "failed");
    expect(failedRow.textContent).toContain("4.0s");
  });

  it("invokes onRunCheck with the workspace and command and disables the button while in flight", async () => {
    const resolvers: Array<() => void> = [];
    const onRunCheck = vi
      .fn<(workspaceId: string, command: string) => Promise<void>>()
      .mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolvers.push(resolve);
          })
      );

    render(
      <ChangedFilesCard
        review={reviewStub()}
        workspaceId="workspace-1"
        checkCommands={["npm test"]}
        checks={[]}
        onRunCheck={onRunCheck}
      />
    );

    const runButton = screen.getByRole("button", { name: "Run check npm test" });
    fireEvent.click(runButton);

    expect(onRunCheck).toHaveBeenCalledTimes(1);
    expect(onRunCheck).toHaveBeenCalledWith("workspace-1", "npm test");
    expect(runButton).toBeDisabled();

    resolvers.forEach((resolve) => resolve());
    await waitFor(() => expect(runButton).not.toBeDisabled());
  });

  it("renders the summary log only when expanded", () => {
    render(
      <ChangedFilesCard
        review={reviewStub()}
        workspaceId="workspace-1"
        checkCommands={["npm test"]}
        checks={[PASSED_RUN]}
        onRunCheck={vi.fn<(workspaceId: string, command: string) => Promise<void>>()}
      />
    );

    expect(screen.queryByLabelText("Log for npm test")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Toggle log for npm test" }));
    expect(screen.getByLabelText("Log for npm test").textContent).toContain("2 tests passed");
  });

  it("renders nothing when there are no registered checks and no changed files", () => {
    const { container } = render(
      <ChangedFilesCard
        review={reviewStub({ filesState: "idle" })}
        workspaceId="workspace-1"
        checkCommands={[]}
        checks={[]}
      />
    );
    expect(container.firstChild).toBeNull();
  });
});
