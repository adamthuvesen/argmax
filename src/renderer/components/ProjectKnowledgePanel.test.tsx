import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi, Learning, ProjectSummary } from "../../shared/types.js";
import { ProjectKnowledgePanel } from "./ProjectKnowledgePanel.js";

const PROJECT: ProjectSummary = {
  id: "project-1",
  name: "Argmax",
  repoPath: "/repo/argmax",
  currentBranch: "main",
  defaultBranch: "main",
  settings: {
    archiveOnMerge: false,
    worktreeLocation: "/repo/argmax/.worktrees",
    setupCommand: "",
    checkCommands: []
  },
  counts: { active: 0, blocked: 0, failed: 0, reviewReady: 0 },
  latestActivityAt: null
};

function makeLearning(overrides: Partial<Learning> & { id: string }): Learning {
  return {
    projectId: "project-1",
    kind: "pitfall",
    summary: "Original summary",
    evidenceSessionId: null,
    evidenceEventId: null,
    verified: false,
    hits: 1,
    createdAt: "2026-05-12T00:00:00.000Z",
    lastSeenAt: "2026-05-12T00:00:00.000Z",
    ...overrides
  };
}

describe("ProjectKnowledgePanel", () => {
  let listSpy: ReturnType<typeof vi.fn<ArgmaxApi["learnings"]["list"]>>;
  let updateSpy: ReturnType<typeof vi.fn<ArgmaxApi["learnings"]["update"]>>;
  let deleteSpy: ReturnType<typeof vi.fn<ArgmaxApi["learnings"]["delete"]>>;
  let originalArgmax: typeof window.argmax;

  beforeEach(() => {
    originalArgmax = window.argmax;
    listSpy = vi
      .fn<ArgmaxApi["learnings"]["list"]>()
      .mockResolvedValue([makeLearning({ id: "L1", summary: "Always run prettier before commit" })]);
    updateSpy = vi
      .fn<ArgmaxApi["learnings"]["update"]>()
      .mockImplementation((input) =>
        Promise.resolve(
          makeLearning({
            id: input.id,
            summary: input.summary ?? "Always run prettier before commit",
            verified: input.verified ?? false
          })
        )
      );
    deleteSpy = vi.fn<ArgmaxApi["learnings"]["delete"]>().mockResolvedValue({ ok: true });
    window.argmax = {
      ...originalArgmax,
      learnings: {
        list: listSpy,
        update: updateSpy,
        delete: deleteSpy
      }
    } as typeof window.argmax;
  });

  afterEach(() => {
    cleanup();
    window.argmax = originalArgmax;
  });

  it("edits a summary on blur and updates the row via the new IPC", async () => {
    render(<ProjectKnowledgePanel projects={[PROJECT]} />);
    const input = await screen.findByLabelText("Edit summary for learning L1");
    expect((input as HTMLInputElement).value).toBe("Always run prettier before commit");

    fireEvent.change(input, { target: { value: "Run prettier + eslint pre-commit" } });
    fireEvent.blur(input);

    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
    expect(updateSpy).toHaveBeenCalledWith({ id: "L1", summary: "Run prettier + eslint pre-commit" });
  });

  it("deletes a learning via the new IPC", async () => {
    render(<ProjectKnowledgePanel projects={[PROJECT]} />);
    await screen.findByLabelText("Edit summary for learning L1");

    fireEvent.click(screen.getByRole("button", { name: "Delete learning L1" }));

    await waitFor(() => expect(deleteSpy).toHaveBeenCalledTimes(1));
    expect(deleteSpy).toHaveBeenCalledWith("L1");
    expect(screen.queryByLabelText("Edit summary for learning L1")).not.toBeInTheDocument();
  });

  it("toggles verified state via the new IPC", async () => {
    render(<ProjectKnowledgePanel projects={[PROJECT]} />);
    await screen.findByLabelText("Edit summary for learning L1");

    fireEvent.click(screen.getByRole("button", { name: "Mark learning as verified" }));

    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
    expect(updateSpy).toHaveBeenCalledWith({ id: "L1", verified: true });
  });
  it("ignores a stale project-1 list response after switching to project-2", async () => {
    const L2 = makeLearning({ id: "L2", projectId: "project-2", summary: "Other project learning" });
    let resolveA!: (value: Learning[]) => void;
    const promiseA = new Promise<Learning[]>((resolve) => {
      resolveA = resolve;
    });
    listSpy.mockImplementation(({ projectId }) => {
      if (projectId === "project-1") return promiseA;
      if (projectId === "project-2") return Promise.resolve([L2]);
      return Promise.resolve([]);
    });

    render(
      <ProjectKnowledgePanel projects={[PROJECT, { ...PROJECT, id: "project-2", name: "Other" }]} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Project knowledge — project picker" }));
    fireEvent.click(screen.getByRole("button", { name: "Other" }));
    await screen.findByLabelText("Edit summary for learning L2");

    await act(async () => {
      resolveA([makeLearning({ id: "L1", summary: "Stale from A" })]);
      await promiseA;
    });

    expect(screen.queryByLabelText("Edit summary for learning L1")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Edit summary for learning L2")).toBeInTheDocument();
  });

  it("does not show L1 or alert when delete rejects after switching to project-2", async () => {
    const L2 = makeLearning({ id: "L2", projectId: "project-2", summary: "Other project learning" });
    let rejectDelete!: (reason?: unknown) => void;
    deleteSpy.mockImplementation(
      () =>
        new Promise<Awaited<ReturnType<ArgmaxApi["learnings"]["delete"]>>>((_, reject) => {
          rejectDelete = reject;
        })
    );
    listSpy.mockImplementation(({ projectId }) => {
      if (projectId === "project-1") {
        return Promise.resolve([makeLearning({ id: "L1", summary: "Delete me" })]);
      }
      if (projectId === "project-2") return Promise.resolve([L2]);
      return Promise.resolve([]);
    });

    render(
      <ProjectKnowledgePanel projects={[PROJECT, { ...PROJECT, id: "project-2", name: "Other" }]} />
    );
    await screen.findByLabelText("Edit summary for learning L1");
    fireEvent.click(screen.getByRole("button", { name: "Delete learning L1" }));
    fireEvent.click(screen.getByRole("button", { name: "Project knowledge — project picker" }));
    fireEvent.click(screen.getByRole("button", { name: "Other" }));
    await screen.findByLabelText("Edit summary for learning L2");

    await act(async () => {
      rejectDelete(new Error("delete failed"));
      await Promise.resolve();
    });

    expect(screen.queryByLabelText("Edit summary for learning L1")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Edit summary for learning L2")).toBeInTheDocument();
  });
});
