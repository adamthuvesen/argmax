import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi, ProjectSummary } from "../../../shared/types.js";
import { BranchTemplatePanel } from "./BranchTemplatePanel.js";

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
    settings: { mergeCleanup: "off", worktreeLocation: "/w", setupCommand: "", checkCommands: [] },
    counts: { active: 0, blocked: 0, failed: 0, reviewReady: 0 },
    latestActivityAt: null,
    ...overrides
  };
}

function install(overrides: {
  setProject?: ReturnType<typeof vi.fn>;
  setApp?: ReturnType<typeof vi.fn>;
}): void {
  (window as unknown as { argmax: ArgmaxApi }).argmax = {
    settings: {
      branchTemplate: vi.fn().mockResolvedValue({ template: null, defaultTemplate: "argmax/{word}-{id}" }),
      setBranchTemplate: overrides.setApp ?? vi.fn()
    },
    projects: { setBranchTemplate: overrides.setProject ?? vi.fn() }
  } as unknown as ArgmaxApi;
}

describe("BranchTemplatePanel", () => {
  it("names the placeholders and shows the built-in template as the default", async () => {
    install({});
    render(<BranchTemplatePanel project={project()} onProjectUpdated={vi.fn()} />);

    expect(screen.getByText(/\{type\}, \{slug\}, \{word\}, \{id\}, \{date\}/)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText("Default for all projects")).toHaveAttribute(
        "placeholder",
        "argmax/{word}-{id}"
      )
    );
  });

  it("saves a project override and reports it to the parent", async () => {
    const saved = project({ branchTemplate: "adam/{type}-{slug}" });
    const setProject = vi.fn().mockResolvedValue(saved);
    const onProjectUpdated = vi.fn();
    install({ setProject });
    render(<BranchTemplatePanel project={project()} onProjectUpdated={onProjectUpdated} />);

    fireEvent.change(screen.getByLabelText("Argmax override"), { target: { value: " adam/{type}-{slug} " } });
    fireEvent.click(screen.getByRole("button", { name: "Save project template" }));

    await waitFor(() =>
      expect(setProject).toHaveBeenCalledWith({ projectId: "project-1", template: "adam/{type}-{slug}" })
    );
    expect(onProjectUpdated).toHaveBeenCalledWith(saved);
    expect(await screen.findByRole("status")).toHaveTextContent("Project branch template saved.");
  });

  it("clears an override by saving it blank", async () => {
    const setProject = vi.fn().mockResolvedValue(project());
    install({ setProject });
    render(
      <BranchTemplatePanel project={project({ branchTemplate: "adam/{slug}" })} onProjectUpdated={vi.fn()} />
    );

    fireEvent.change(screen.getByLabelText("Argmax override"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save project template" }));

    await waitFor(() => expect(setProject).toHaveBeenCalledWith({ projectId: "project-1", template: null }));
  });

  it("shows why a template was rejected beside its field", async () => {
    const setApp = vi.fn().mockRejectedValue({
      code: "INVALID_INPUT",
      issues: [{ path: ["branchTemplate"], code: "BRANCH_TEMPLATE_INVALID", message: "Unknown placeholder {nope}." }]
    });
    install({ setApp });
    render(<BranchTemplatePanel project={project()} onProjectUpdated={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Default for all projects"), { target: { value: "adam/{nope}" } });
    fireEvent.click(screen.getByRole("button", { name: "Save default" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Unknown placeholder {nope}.");
  });
});
