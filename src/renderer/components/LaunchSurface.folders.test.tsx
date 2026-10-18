import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi, ProjectFolder } from "../../shared/types.js";
import { getProjectFolders, primaryProject, setupAppTestMocks } from "../../test/appTestHarness.js";
import { LaunchSurface } from "./LaunchSurface.js";
import { useLaunchFolder } from "../hooks/useLaunchFolder.js";

const project = primaryProject();
const folders: ProjectFolder[] = [
  { id: "primary", projectId: project.id, name: "primary", rootPath: project.repoPath, isPrimary: true, enabled: true, summary: null },
  { id: "secondary", projectId: project.id, name: "library", rootPath: "/repos/library", isPrimary: false, enabled: true, summary: null },
  { id: "notes", projectId: project.id, name: "notes", rootPath: "/docs/notes", isPrimary: false, enabled: true, summary: null }
];

function launcher() {
  const launch = vi.fn().mockResolvedValue(undefined);
  render(<LaunchSurface model={{ provider: "claude", modelId: "claude-fable-5-1", label: "Fable", reasoningEffort: "medium" }}
    project={project} projects={[project]} onAddProject={vi.fn()} onSelectProject={vi.fn()}
    onBranchSwitch={vi.fn()} onLaunchTask={launch} onModelChange={vi.fn()} />);
  return launch;
}

async function pickFolder(name: string) {
  await waitFor(() => expect(screen.getByRole("button", { name: "Switch project" })).toHaveAttribute("title", expect.stringContaining("Right-click")));
  fireEvent.contextMenu(screen.getByRole("button", { name: "Switch project" }));
  fireEvent.click(within(screen.getByRole("listbox", { name: "Work in" })).getByRole("button", { name }));
}

describe("launcher working folder", () => {
  beforeEach(() => {
    setupAppTestMocks();
    getProjectFolders.mockResolvedValue(folders);
    vi.spyOn(window.argmax!.projects, "refreshBranch").mockResolvedValue(project);
    vi.spyOn(window.argmax!.projects, "getFolderContext").mockImplementation(({ projectFolderId }) => Promise.resolve({
      folderId: projectFolderId ?? "primary",
      project: { ...project, repoPath: folders.find((folder) => folder.id === projectFolderId)!.rootPath, currentBranch: "library-main" },
      isGit: projectFolderId !== "notes"
    }));
  });
  afterEach(cleanup);

  it("defaults to primary and captures the selected folder and branch for launch", async () => {
    const launch = launcher();
    await waitFor(() => expect(screen.getByRole("button", { name: "Switch project" })).toHaveAttribute("title", expect.stringContaining(`Work in ${project.repoPath.split("/").at(-1)}`)));
    expect(screen.getByRole("button", { name: "Switch project" })).toHaveTextContent(project.name);
    fireEvent.click(screen.getByRole("button", { name: "Switch project" }));
    expect(screen.getByRole("listbox", { name: "Select project" })).toBeInTheDocument();
    expect(screen.queryByRole("listbox", { name: "Work in" })).not.toBeInTheDocument();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Switch project" }));
    expect(within(screen.getByRole("listbox", { name: "Work in" })).getByRole("button", { name: `${project.repoPath.split("/").at(-1)} Primary` })).toBeInTheDocument();
    await pickFolder("library");
    expect(screen.getByRole("button", { name: "Switch project" })).toHaveAttribute("title", expect.stringContaining("Work in library"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Switch branch" })).toHaveTextContent("library-main"));
    vi.mocked(window.argmax!.projects.listBranches).mockResolvedValue(["library-main", "feature"]);
    fireEvent.click(screen.getByRole("button", { name: "Switch branch" }));
    fireEvent.click(await screen.findByRole("button", { name: "feature" }));
    expect(window.argmax!.projects.listBranches).toHaveBeenCalledWith(project.id, "secondary");
    await pickFolder("library");
    expect(window.argmax!.projects.configure).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Task prompt"), { target: { value: "Fix the library" } });
    fireEvent.submit(screen.getByLabelText("Task prompt").closest("form")!);
    await waitFor(() => expect(launch).toHaveBeenCalledOnce());
    expect(launch.mock.calls[0]?.[8]).toMatchObject({ projectId: project.id, projectFolderId: "secondary", branch: "feature" });
    expect(launch.mock.calls[0]?.[9]).toBe("secondary");
  });

  it("uses current folder mode for a non-Git folder even when worktree was enabled", async () => {
    const launch = launcher();
    fireEvent.click(await screen.findByRole("button", { name: "Worktree" }));
    await pickFolder("notes");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Worktree" })).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Switch branch" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Task prompt"), { target: { value: "Edit notes" } });
    fireEvent.submit(screen.getByLabelText("Task prompt").closest("form")!);
    await waitFor(() => expect(launch).toHaveBeenCalledOnce());
    expect(launch.mock.calls[0]?.[3]).toBe("current");
    expect(launch.mock.calls[0]?.[9]).toBe("notes");
  });

  it("blocks launch on a folder read error", async () => {
    const launch = launcher();
    vi.mocked(window.argmax!.projects.getFolderContext).mockRejectedValue(new Error("Folder is missing"));
    await pickFolder("library");
    expect(await screen.findByRole("alert")).toHaveTextContent("Folder is missing");
    fireEvent.change(screen.getByLabelText("Task prompt"), { target: { value: "Do work" } });
    fireEvent.submit(screen.getByLabelText("Task prompt").closest("form")!);
    expect(launch).not.toHaveBeenCalled();
    vi.mocked(window.argmax!.projects.getFolderContext).mockResolvedValue({ folderId: "secondary", project: { ...project, repoPath: "/repos/library" }, isGit: true });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    fireEvent.submit(screen.getByLabelText("Task prompt").closest("form")!);
    await waitFor(() => expect(launch).toHaveBeenCalledOnce());
  });

  it("filters folders from the keyboard and shows paths only for duplicate names", async () => {
    getProjectFolders.mockResolvedValue([
      folders[0],
      { ...folders[1], name: "library" },
      { ...folders[2], name: "library", rootPath: "/docs/library" }
    ]);
    launcher();
    await waitFor(() => expect(screen.getByRole("button", { name: "Switch project" })).toHaveAttribute("title", expect.stringContaining("Right-click")));
  fireEvent.keyDown(screen.getByRole("button", { name: "Switch project" }), { key: "F10", shiftKey: true });
    const list = screen.getByRole("listbox", { name: "Work in" });
    expect(within(list).getByText("/repos/library")).toBeInTheDocument();
    expect(within(list).getByText("/docs/library")).toBeInTheDocument();
    expect(within(list).queryByText(project.repoPath)).not.toBeInTheDocument();
    fireEvent.keyDown(list, { key: "l" });
    fireEvent.keyDown(list, { key: "Enter" });
    await waitFor(() => expect(window.argmax!.projects.getFolderContext).toHaveBeenCalledWith({ projectId: project.id, projectFolderId: "secondary" }));
    expect(screen.queryByRole("listbox", { name: "Work in" })).not.toBeInTheDocument();
  });

  it("ignores a stale folder context after another folder was picked", async () => {
    let finish!: (value: Awaited<ReturnType<ArgmaxApi["projects"]["getFolderContext"]>>) => void;
    vi.mocked(window.argmax!.projects.getFolderContext).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const launch = launcher();
    await pickFolder("library");
    await pickFolder("notes");
    await waitFor(() => expect(window.argmax!.projects.getFolderContext).toHaveBeenCalledTimes(2));
    act(() => { finish({ folderId: "secondary", project, isGit: true }); });
    expect(screen.queryByRole("button", { name: "Switch branch" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Task prompt"), { target: { value: "Notes" } });
    fireEvent.submit(screen.getByLabelText("Task prompt").closest("form")!);
    await waitFor(() => expect(launch.mock.calls[0]?.[9]).toBe("notes"));
  });

  it("requires a new selection when the selected folder is removed", async () => {
    const { result, rerender } = renderHook(({ selectedProject }) => useLaunchFolder(selectedProject), {
      initialProps: { selectedProject: project }
    });
    await waitFor(() => expect(result.current.folders).toHaveLength(3));
    act(() => result.current.pickFolder(folders[1]));
    await waitFor(() => expect(result.current.ready).toBe(true));
    getProjectFolders.mockResolvedValue([folders[0]]);
    rerender({ selectedProject: { ...project, name: "Updated project" } });
    await waitFor(() => expect(result.current.error).toContain("working folder was removed"));
    expect(result.current.ready).toBe(false);
    expect(result.current.project).toBeNull();
    act(() => result.current.pickFolder(folders[0]));
    expect(result.current.ready).toBe(true);
  });
});
