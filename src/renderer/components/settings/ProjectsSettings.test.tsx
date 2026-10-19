import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type JSX } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi, ProjectSummary } from "../../../shared/types.js";
import { resetToastForTests, toastSnapshot } from "../../state/toast.js";
import { ProjectsSettings } from "./ProjectsSettings.js";

afterEach(() => {
  cleanup();
  resetToastForTests();
  delete (window as unknown as { argmax?: ArgmaxApi }).argmax;
});

function project(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: "project-1",
    name: "Argmax",
    repoPath: "/Users/dev/argmax",
    currentBranch: "main",
    defaultBranch: "main",
    settings: {
      mergeCleanup: "off",
      worktreeLocation: "/Users/dev/argmax/.argmax/worktrees",
      setupCommand: "npm install",
      checkCommands: ["npm run lint"]
    },
    counts: { active: 0, blocked: 0, failed: 0, reviewReady: 0 },
    latestActivityAt: null,
    ...overrides
  };
}

function installUpdateStub(updateSettings: ReturnType<typeof vi.fn>): void {
  (window as unknown as { argmax: ArgmaxApi }).argmax = {
    projects: { updateSettings, getFolders: vi.fn().mockResolvedValue([]) }
  } as unknown as ArgmaxApi;
}

describe("ProjectsSettings", () => {
  it("opens the requested project instead of the first project", () => {
    const second = project({ id: "project-2", name: "Research", repoPath: "/Users/dev/research" });
    render(
      <ProjectsSettings
        projects={[project(), second]}
        initialProjectId="project-2"
        onProjectUpdated={vi.fn()}
      />
    );

    expect(screen.getByText("/Users/dev/research")).toBeInTheDocument();
    expect(screen.queryByText("/Users/dev/argmax")).not.toBeInTheDocument();
  });

  it("renders current settings and keeps Save disabled until something changes", () => {
    render(<ProjectsSettings projects={[project()]} onProjectUpdated={vi.fn()} />);

    expect(screen.getByText("/Users/dev/argmax")).toBeInTheDocument();
    expect(screen.getByLabelText("Worktree location")).toHaveValue("/Users/dev/argmax/.argmax/worktrees");
    expect(screen.getByLabelText("Setup command")).toHaveValue("npm install");
    expect(screen.getByLabelText("Check commands")).toHaveValue("npm run lint");
    expect(screen.getByRole("button", { name: "Save project settings" })).toBeDisabled();
  });

  it("saves the project name, folder membership, and primary folder together", async () => {
    const folders = [
      { id: "primary", projectId: "project-1", name: "argmax", rootPath: "/Users/dev/argmax", isPrimary: true, enabled: true, summary: null },
      { id: "docs", projectId: "project-1", name: "docs", rootPath: "/Users/dev/docs", isPrimary: false, enabled: true, summary: "API notes." }
    ];
    const configure = vi.fn().mockResolvedValue(project({ name: "Agent tools", repoPath: "/Users/dev/docs" }));
    const getFolders = vi.fn().mockResolvedValue(folders);
    window.argmax = { projects: {
      configure, getFolders,
      pickDirectory: vi.fn().mockResolvedValue({ cancelled: false, path: "/Users/dev/research" })
    } } as unknown as ArgmaxApi;
    const onProjectUpdated = vi.fn();
    render(<ProjectsSettings projects={[project()]} onProjectUpdated={onProjectUpdated} />);
    fireEvent.change(await screen.findByLabelText("Project name"), { target: { value: "Agent tools" } });
    fireEvent.click(screen.getByRole("radio", { name: "Make docs primary" }));
    fireEvent.click(screen.getByRole("button", { name: "Add folder" }));
    await screen.findByText("research");
    fireEvent.click(screen.getByRole("button", { name: "Remove folder argmax" }));
    fireEvent.click(screen.getByRole("button", { name: "Save project" }));
    await waitFor(() => expect(configure).toHaveBeenCalledWith({
      projectId: "project-1", name: "Agent tools", folders: ["/Users/dev/docs", "/Users/dev/research"], primaryPath: "/Users/dev/docs"
    }));
    await waitFor(() => expect(onProjectUpdated).toHaveBeenCalledWith(expect.objectContaining({ name: "Agent tools", repoPath: "/Users/dev/docs" })));
  });

  it("keeps the saved confirmation after the saved project and folders reload", async () => {
    const folder = (rootPath: string, isPrimary: boolean) => ({
      id: rootPath, projectId: "project-1", name: rootPath.split("/").pop()!, rootPath, isPrimary, enabled: true, summary: null
    });
    const getFolders = vi.fn()
      .mockResolvedValueOnce([folder("/Users/dev/argmax", true)])
      .mockResolvedValue([folder("/Users/dev/argmax", true), folder("/Users/dev/research", false)]);
    const configure = vi.fn().mockResolvedValue(project({ name: "Agent tools" }));
    window.argmax = { projects: {
      configure, getFolders,
      pickDirectory: vi.fn().mockResolvedValue({ cancelled: false, path: "/Users/dev/research" })
    } } as unknown as ArgmaxApi;
    function Harness(): JSX.Element {
      const [current, setCurrent] = useState(project());
      return <ProjectsSettings projects={[current]} onProjectUpdated={setCurrent} />;
    }
    render(<Harness />);
    fireEvent.change(await screen.findByLabelText("Project name"), { target: { value: "Agent tools" } });
    fireEvent.click(screen.getByRole("button", { name: "Add folder" }));
    await screen.findByText("research");
    fireEvent.click(screen.getByRole("button", { name: "Save project" }));
    expect(await screen.findByText("Project saved.")).toBeInTheDocument();
    await waitFor(() => expect(getFolders).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Project saved.")).toBeInTheDocument();
    expect(screen.getByLabelText("Project name")).toHaveValue("Agent tools");
    expect(screen.getByRole("button", { name: "Save project" })).toBeDisabled();
  });

  it("keeps the selected project when settings navigation does not name a project", () => {
    const second = project({ id: "project-2", name: "Research", repoPath: "/Users/dev/research" });
    const { rerender } = render(
      <ProjectsSettings projects={[project(), second]} initialProjectId="project-2" navigationRequestId={1} onProjectUpdated={vi.fn()} />
    );
    rerender(<ProjectsSettings projects={[project(), second]} navigationRequestId={2} onProjectUpdated={vi.fn()} />);
    expect(screen.getByText("/Users/dev/research")).toBeInTheDocument();
    rerender(<ProjectsSettings projects={[project(), second]} initialProjectId="project-1" navigationRequestId={3} onProjectUpdated={vi.fn()} />);
    expect(screen.getByText("/Users/dev/argmax")).toBeInTheDocument();
  });

  it("loads the new primary repository defaults after the primary folder changes", () => {
    const { rerender } = render(<ProjectsSettings projects={[project()]} onProjectUpdated={vi.fn()} />);
    expect(screen.getByLabelText("Setup command")).toHaveValue("npm install");
    rerender(<ProjectsSettings projects={[project({ repoPath: "/Users/dev/dbt", settings: {
      mergeCleanup: "off", worktreeLocation: "/Users/dev/dbt/.argmax/worktrees", setupCommand: "uv sync", checkCommands: ["uv run pytest"]
    } })]} onProjectUpdated={vi.fn()} />);
    expect(screen.getByLabelText("Setup command")).toHaveValue("uv sync");
    expect(screen.getByLabelText("Check commands")).toHaveValue("uv run pytest");
    expect(screen.getByLabelText("Worktree location")).toHaveValue("/Users/dev/dbt/.argmax/worktrees");
  });

  it("saves edited settings", async () => {
    const saved = project();
    const updateSettings = vi.fn().mockResolvedValue(saved);
    installUpdateStub(updateSettings);
    const onProjectUpdated = vi.fn();

    render(<ProjectsSettings projects={[project()]} onProjectUpdated={onProjectUpdated} />);

    fireEvent.change(screen.getByLabelText("Setup command"), { target: { value: "  npm ci  " } });
    fireEvent.change(screen.getByLabelText("Check commands"), {
      target: { value: "npm run lint\nnpm test\n\n" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save project settings" }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings).toHaveBeenCalledWith({
      projectId: "project-1",
      settings: {
        setupCommand: "npm ci",
        mergeCleanup: "off",
        worktreeLocation: "/Users/dev/argmax/.argmax/worktrees",
        checkCommands: ["npm run lint", "npm test"]
      }
    });
    await waitFor(() => expect(onProjectUpdated).toHaveBeenCalledWith(saved));
    expect(screen.getByRole("status")).toHaveTextContent("Project settings saved.");
  });

  it("saves the merge cleanup choice", async () => {
    const updateSettings = vi.fn().mockResolvedValue(project());
    installUpdateStub(updateSettings);

    render(<ProjectsSettings projects={[project()]} onProjectUpdated={vi.fn()} />);

    const choices = screen.getByRole("radiogroup", { name: "When a PR merges" });
    expect(within(choices).getByRole("radio", { name: "Keep" })).toBeChecked();
    fireEvent.click(within(choices).getByRole("radio", { name: "Remove worktree" }));
    fireEvent.click(screen.getByRole("button", { name: "Save project settings" }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings).toHaveBeenCalledWith({
      projectId: "project-1",
      settings: {
        setupCommand: "npm install",
        worktreeLocation: "/Users/dev/argmax/.argmax/worktrees",
        checkCommands: ["npm run lint"],
        mergeCleanup: "remove-checkout"
      }
    });
  });

  it("rejects a relative worktree location without calling the backend", async () => {
    const updateSettings = vi.fn();
    installUpdateStub(updateSettings);

    render(<ProjectsSettings projects={[project()]} onProjectUpdated={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Worktree location"), {
      target: { value: "worktrees" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save project settings" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/absolute path/);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("surfaces a backend save failure", async () => {
    const updateSettings = vi.fn().mockRejectedValue(new Error("PROJECT_NOT_FOUND"));
    installUpdateStub(updateSettings);

    render(<ProjectsSettings projects={[project()]} onProjectUpdated={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Check commands"), { target: { value: "npm test" } });
    fireEvent.click(screen.getByRole("button", { name: "Save project settings" }));

    await waitFor(() => expect(toastSnapshot()?.message).toContain("PROJECT_NOT_FOUND"));
  });

  it("switches the form when another project is picked", () => {
    const other = project({
      id: "project-2",
      name: "Other",
      repoPath: "/Users/dev/other",
      settings: {
        mergeCleanup: "off",
        worktreeLocation: "/Users/dev/other/.argmax/worktrees",
        setupCommand: "",
        checkCommands: []
      }
    });
    render(<ProjectsSettings projects={[project(), other]} onProjectUpdated={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Project" }));
    fireEvent.click(screen.getByRole("button", { name: "Other" }));

    expect(screen.getByText("/Users/dev/other")).toBeInTheDocument();
    expect(screen.getByLabelText("Worktree location")).toHaveValue("/Users/dev/other/.argmax/worktrees");
  });
});
