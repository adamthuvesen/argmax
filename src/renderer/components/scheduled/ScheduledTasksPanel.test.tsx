import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi, ProjectSummary, Routine } from "../../../shared/types.js";
import { ScheduledTasksPanel } from "./ScheduledTasksPanel.js";

function routine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: "r1",
    name: "Morning triage",
    projectId: "p1",
    prompt: "Triage the board",
    provider: "claude",
    modelLabel: "Opus 5",
    modelId: "claude-opus-5",
    worktree: true,
    cronExpr: "0 0 9 * * *",
    runOnceAt: null,
    enabled: true,
    lastRunAt: null,
    nextRunAt: "2026-09-01T09:00:00.000Z",
    lastError: null,
    createdAt: "2026-08-30T08:00:00.000Z",
    updatedAt: "2026-08-30T08:00:00.000Z",
    ...overrides
  };
}

function project(): ProjectSummary {
  return {
    id: "p1",
    name: "Argmax",
    repoPath: "/tmp/argmax",
    currentBranch: "main",
    defaultBranch: "main",
    settings: {
      worktreeLocation: "/tmp/worktrees",
      setupCommand: "",
      checkCommands: []
    },
    counts: { active: 0, blocked: 0, failed: 0, reviewReady: 0 },
    latestActivityAt: null
  };
}

const routinesStub = {
  list: vi.fn<ArgmaxApi["routines"]["list"]>(),
  upsert: vi.fn<ArgmaxApi["routines"]["upsert"]>(),
  delete: vi.fn<ArgmaxApi["routines"]["delete"]>(),
  setEnabled: vi.fn<ArgmaxApi["routines"]["setEnabled"]>(),
  runNow: vi.fn<ArgmaxApi["routines"]["runNow"]>()
};

beforeEach(() => {
  vi.restoreAllMocks();
  routinesStub.list.mockReset();
  routinesStub.upsert.mockReset();
  routinesStub.delete.mockReset();
  routinesStub.setEnabled.mockReset();
  routinesStub.runNow.mockReset();
  routinesStub.list.mockResolvedValue([routine()]);
  routinesStub.delete.mockResolvedValue(null);
  routinesStub.upsert.mockImplementation((input) =>
    Promise.resolve(routine({ ...input, enabled: input.enabled ?? true }))
  );
  routinesStub.setEnabled.mockImplementation((id, enabled) => Promise.resolve(routine({ id, enabled })));
  routinesStub.runNow.mockImplementation((id) => Promise.resolve(routine({ id, enabled: false })));
  window.argmax = { routines: routinesStub } as unknown as ArgmaxApi;
});

afterEach(() => {
  cleanup();
  delete (window as { argmax?: ArgmaxApi }).argmax;
});

describe("ScheduledTasksPanel", () => {
  it("lists tasks with their friendly schedule and next run", async () => {
    render(<ScheduledTasksPanel projects={[project()]} />);

    const row = await screen.findByRole("listitem");
    expect(row).toHaveTextContent("Morning triage");
    expect(row).toHaveTextContent("Argmax");
    expect(row).toHaveTextContent("Claude Opus 5");
    expect(row).toHaveTextContent("Daily at 09:00");
  });

  it("counts the tasks and calls out the paused ones", async () => {
    routinesStub.list.mockResolvedValue([routine(), routine({ id: "r2", name: "Nightly", enabled: false })]);
    render(<ScheduledTasksPanel projects={[project()]} />);

    expect(await screen.findByText(/2 tasks/)).toBeInTheDocument();
    expect(screen.getByText(/1 paused/)).toBeInTheDocument();
  });

  it("pausing a task calls set-enabled with the flipped value", async () => {
    render(<ScheduledTasksPanel projects={[project()]} />);

    fireEvent.click(await screen.findByRole("checkbox", { name: "Pause Morning triage" }));

    await waitFor(() => expect(routinesStub.setEnabled).toHaveBeenCalledWith("r1", false));
  });

  it("run-now launches the task and reports it", async () => {
    render(<ScheduledTasksPanel projects={[project()]} />);

    fireEvent.click(await screen.findByRole("button", { name: "Run Morning triage now" }));

    await waitFor(() => expect(routinesStub.runNow).toHaveBeenCalledWith("r1"));
    expect(await screen.findByRole("status")).toHaveTextContent(/Started/);
  });

  it("titles the page Schedule and does not paint a New task breadcrumb", async () => {
    routinesStub.list.mockResolvedValue([]);
    render(<ScheduledTasksPanel projects={[project()]} />);

    expect(await screen.findByRole("heading", { name: "Schedule" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New task" }));

    expect(screen.getByRole("heading", { name: "Schedule" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.queryByText("New task")).not.toBeInTheDocument();
  });

  it("creates a task through the editor with the generated daily cron", async () => {
    routinesStub.list.mockResolvedValue([]);
    render(<ScheduledTasksPanel projects={[project()]} />);

    fireEvent.click(await screen.findByRole("button", { name: "New task" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Nightly triage" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Triage the board" } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));

    await waitFor(() =>
      expect(routinesStub.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Nightly triage",
          projectId: "p1",
          provider: "claude",
          cronExpr: "0 0 9 * * *",
          runOnceAt: null,
          worktree: true
        })
      )
    );
  });

  it("reports a failed action as an alert, not as a success status", async () => {
    routinesStub.delete.mockRejectedValue(new Error("routine not found: r1"));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ScheduledTasksPanel projects={[project()]} />);

    fireEvent.click(await screen.findByRole("button", { name: "Delete Morning triage" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("routine not found: r1");
    expect(screen.queryByRole("status")).toBeNull();
  });

  // With nowhere to run, the screen explains the next step instead of
  // offering a button that can only fail.
  it("withholds the create action until a repository exists", async () => {
    routinesStub.list.mockResolvedValue([]);
    render(<ScheduledTasksPanel projects={[]} />);

    expect(await screen.findByText(/No repositories yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New task/ })).toBeNull();
  });

  it("surfaces the backend validation error inline instead of saving", async () => {
    routinesStub.upsert.mockRejectedValue(new Error("provide a cron expression or a one-shot time"));
    render(<ScheduledTasksPanel projects={[project()]} />);

    fireEvent.click(await screen.findByRole("button", { name: "New task" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Broken" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Do things" } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "provide a cron expression or a one-shot time"
    );
    expect(routinesStub.list).toHaveBeenCalledTimes(1);
  });
});
