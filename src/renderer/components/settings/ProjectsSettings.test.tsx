import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi, ProjectSummary } from "../../../shared/types.js";
import { ProjectsSettings } from "./ProjectsSettings.js";

afterEach(() => {
  cleanup();
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
    projects: { updateSettings }
  } as unknown as ArgmaxApi;
}

describe("ProjectsSettings", () => {
  it("shows a hint when no projects are registered", () => {
    render(<ProjectsSettings projects={[]} onProjectUpdated={vi.fn()} />);
    expect(screen.getByText(/No projects registered yet/)).toBeInTheDocument();
  });

  it("renders current settings and keeps Save disabled until something changes", () => {
    render(<ProjectsSettings projects={[project()]} onProjectUpdated={vi.fn()} />);

    expect(screen.getByText("/Users/dev/argmax")).toBeInTheDocument();
    expect(screen.getByLabelText("Worktree location")).toHaveValue("/Users/dev/argmax/.argmax/worktrees");
    expect(screen.getByLabelText("Setup command")).toHaveValue("npm install");
    expect(screen.getByLabelText("Check commands")).toHaveValue("npm run lint");
    expect(screen.getByRole("button", { name: "Save project settings" })).toBeDisabled();
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
        worktreeLocation: "/Users/dev/argmax/.argmax/worktrees",
        checkCommands: ["npm run lint", "npm test"]
      }
    });
    await waitFor(() => expect(onProjectUpdated).toHaveBeenCalledWith(saved));
    expect(screen.getByRole("status")).toHaveTextContent("Project settings saved.");
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

    expect(await screen.findByRole("alert")).toHaveTextContent("PROJECT_NOT_FOUND");
  });

  it("switches the form when another project is picked", () => {
    const other = project({
      id: "project-2",
      name: "Other",
      repoPath: "/Users/dev/other",
      settings: {
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
