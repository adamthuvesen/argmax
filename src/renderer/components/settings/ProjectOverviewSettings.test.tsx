import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi, ProjectFolder, ProjectOverview, ProjectOverviewDocument, ProjectSummary } from "../../../shared/types.js";
import { resetToastForTests, toastSnapshot } from "../../state/toast.js";
import { ProjectOverviewSettings } from "./ProjectOverviewSettings.js";

const folder: ProjectFolder = {
  id: "primary", projectId: "project-1", name: "app", rootPath: "/repos/app",
  isPrimary: true, enabled: true, summary: null
};

function document(text = "An app with shared contracts."): ProjectOverviewDocument {
  return { text, sources: [{ folderId: "primary", path: "README.md" }], generatedAt: "2026-10-18T10:00:00Z" };
}

function project(overview?: ProjectOverview): ProjectSummary {
  return {
    id: "project-1", name: "Product", repoPath: "/repos/app", currentBranch: "main", defaultBranch: "main",
    settings: { mergeCleanup: "off", worktreeLocation: "/repos/app/.worktrees", setupCommand: "", checkCommands: [] },
    counts: { active: 0, blocked: 0, failed: 0, reviewReady: 0 }, latestActivityAt: null,
    ...(overview ? { overview } : {})
  };
}

function overview(overrides: Partial<ProjectOverview> = {}): ProjectOverview {
  return { revision: 1, saved: document(), draft: null, status: "idle", error: null, ...overrides };
}

function install(projects: Partial<ArgmaxApi["projects"]>): void {
  window.argmax = { projects } as unknown as ArgmaxApi;
}

afterEach(() => {
  cleanup();
  resetToastForTests();
  delete (window as unknown as { argmax?: ArgmaxApi }).argmax;
});

describe("ProjectOverviewSettings", () => {
  it("shows background generation then adopts its saved overview and sources", () => {
    install({});
    const onProjectUpdated = vi.fn();
    const { rerender } = render(<ProjectOverviewSettings project={project(overview({ status: "generating", saved: null }))}
      folders={[folder]} onProjectUpdated={onProjectUpdated} />);
    expect(screen.getByRole("status")).toHaveTextContent("in the background");
    expect(screen.getByRole("button", { name: "Generating…" })).toBeDisabled();
    rerender(<ProjectOverviewSettings project={project(overview({ revision: 2 }))}
      folders={[folder]} onProjectUpdated={onProjectUpdated} />);
    expect(screen.getByRole("textbox", { name: "Project overview" })).toHaveValue("An app with shared contracts.");
    expect(screen.getByRole("list", { name: "Overview sources" })).toHaveTextContent("app/README.md");
    expect(screen.getByText(/Generated/).querySelector("time")).toHaveAttribute("datetime", "2026-10-18T10:00:00Z");
    expect(screen.getByRole("button", { name: "Refresh overview" })).toBeEnabled();
  });

  it("preserves unsaved edits when initial generation completes", async () => {
    const updateOverview = vi.fn().mockResolvedValue(project(overview({ revision: 3, saved: document("My project description") })));
    install({ updateOverview });
    const onProjectUpdated = vi.fn();
    const { rerender } = render(<ProjectOverviewSettings project={project(overview({ saved: null, status: "generating" }))}
      folders={[folder]} onProjectUpdated={onProjectUpdated} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "My project description" } });
    rerender(<ProjectOverviewSettings project={project(overview({ revision: 2 }))}
      folders={[folder]} onProjectUpdated={onProjectUpdated} />);
    expect(screen.getByRole("textbox")).toHaveValue("My project description");
    expect(screen.getByText("The saved overview changed. Your edits are preserved.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save overview" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Keep my edits" }));
    fireEvent.click(screen.getByRole("button", { name: "Save overview" }));
    await waitFor(() => expect(updateOverview).toHaveBeenCalledWith({
      projectId: "project-1", text: "My project description", expectedRevision: 2
    }));
  });

  it("reviews a refresh draft without overwriting the editor and applies it explicitly", async () => {
    const refreshed = project(overview({ revision: 3, draft: document("A refreshed description.") }));
    const generateOverview = vi.fn().mockResolvedValue(project(overview({ revision: 2, status: "generating" })));
    const applyOverviewDraft = vi.fn().mockResolvedValue(project(overview({ revision: 4, saved: document("A refreshed description.") })));
    install({ generateOverview, applyOverviewDraft });
    const onProjectUpdated = vi.fn();
    const { rerender } = render(<ProjectOverviewSettings project={project(overview())} folders={[folder]} onProjectUpdated={onProjectUpdated} />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh overview" }));
    await waitFor(() => expect(generateOverview).toHaveBeenCalledWith({ projectId: "project-1" }));
    rerender(<ProjectOverviewSettings project={refreshed} folders={[folder]} onProjectUpdated={onProjectUpdated} />);
    expect(screen.getByRole("textbox")).toHaveValue("An app with shared contracts.");
    expect(screen.getByLabelText("Refreshed overview draft")).toHaveTextContent("A refreshed description.");
    fireEvent.click(screen.getByRole("button", { name: "Apply draft" }));
    await waitFor(() => expect(applyOverviewDraft).toHaveBeenCalledWith({ projectId: "project-1", expectedRevision: 3 }));
  });

  it("requires saving or discarding local edits before applying a refreshed draft", async () => {
    const discardOverviewDraft = vi.fn().mockResolvedValue(project(overview({ revision: 3 })));
    install({ discardOverviewDraft });
    const { rerender } = render(<ProjectOverviewSettings project={project(overview())} folders={[folder]} onProjectUpdated={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "My edits" } });
    rerender(<ProjectOverviewSettings project={project(overview({ revision: 2, draft: document("A new draft") }))}
      folders={[folder]} onProjectUpdated={vi.fn()} />);
    expect(screen.getByRole("textbox")).toHaveValue("My edits");
    expect(screen.getByRole("button", { name: "Apply draft" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    await waitFor(() => expect(discardOverviewDraft).toHaveBeenCalledWith({ projectId: "project-1", expectedRevision: 2 }));
    expect(screen.getByRole("textbox")).toHaveValue("My edits");
  });

  it("uses the newest revision for edits when generation only changes draft state", async () => {
    const updateOverview = vi.fn().mockResolvedValue(project(overview({ revision: 4, saved: document("My edits") })));
    install({ updateOverview });
    const { rerender } = render(<ProjectOverviewSettings project={project(overview())} folders={[folder]} onProjectUpdated={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "My edits" } });
    rerender(<ProjectOverviewSettings project={project(overview({ revision: 3, draft: document("A draft") }))}
      folders={[folder]} onProjectUpdated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Save overview" }));
    await waitFor(() => expect(updateOverview).toHaveBeenCalledWith({ projectId: "project-1", text: "My edits", expectedRevision: 3 }));
  });

  it("preserves typing entered while a save is in flight", async () => {
    let resolve!: (updated: ProjectSummary) => void;
    const pending = new Promise<ProjectSummary>((settle) => { resolve = settle; });
    install({ updateOverview: vi.fn().mockReturnValue(pending) });
    const onProjectUpdated = vi.fn();
    render(<ProjectOverviewSettings project={project(overview())} folders={[folder]} onProjectUpdated={onProjectUpdated} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "First edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save overview" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Further edit" } });
    await act(async () => { resolve(project(overview({ revision: 2, saved: document("First edit") }))); await pending; });
    expect(screen.getByRole("textbox")).toHaveValue("Further edit");
    expect(screen.queryByText("Overview saved.")).not.toBeInTheDocument();
    expect(onProjectUpdated).toHaveBeenCalled();
  });

  it("retains generation failures with retry and reports action failures in the shared toast", async () => {
    const generateOverview = vi.fn().mockRejectedValue(new Error("Provider is unavailable"));
    install({ generateOverview });
    render(<ProjectOverviewSettings project={project(overview({ status: "failed", error: "Generation was interrupted." }))}
      folders={[folder]} onProjectUpdated={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Generation was interrupted.");
    fireEvent.click(screen.getByRole("button", { name: "Retry overview" }));
    await waitFor(() => expect(toastSnapshot()?.message).toBe("Provider is unavailable"));
    expect(screen.getByRole("button", { name: "Retry overview" })).toBeEnabled();
  });
});
