import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CheckRun } from "../../shared/types.js";
import { ChangedFilesCard } from "./ChangedFilesCard.js";

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

describe("ChangedFilesCard checks list", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders one row per registered check and surfaces last status + duration", () => {
    render(
      <ChangedFilesCard
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

  it("renders nothing when there are no registered checks", () => {
    const { container } = render(
      <ChangedFilesCard
        workspaceId="workspace-1"
        checkCommands={[]}
        checks={[]}
      />
    );
    expect(container.firstChild).toBeNull();
  });
});
