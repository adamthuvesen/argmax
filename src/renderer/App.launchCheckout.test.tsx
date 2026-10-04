import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App.js";
import {
  createAlongsideWorkspace,
  createCurrentWorkspace,
  createIsolatedWorkspace,
  launchProvider,
  listBranches,
  listCheckouts,
  mockDashboardSnapshot,
  primaryProject,
  secondProject,
  setupAppTestMocks,
  snapshot,
  switchBranch
} from "../test/appTestHarness.js";
import { resetToastForTests, toastSnapshot } from "./state/toast.js";

const ROOT = "/tmp/argmax";
const LINKED = "/tmp/worktrees/feature";
const workspace = { ...snapshot.workspaces[0], id: "workspace-new", taskLabel: "New chat" };
const session = { ...snapshot.sessions[0], id: "session-new", workspaceId: workspace.id };

async function pickBranch(name: string): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Switch branch" }));
  const listbox = await screen.findByRole("listbox", { name: "Select branch" });
  fireEvent.click(within(listbox).getByRole("button", { name }));
}

async function start(prompt = "Refactor the auth guard"): Promise<void> {
  fireEvent.change(await screen.findByLabelText("Task prompt"), { target: { value: prompt } });
  fireEvent.click(screen.getByRole("button", { name: "Start agent" }));
}

describe("launching into the branch picked in the launcher", () => {
  beforeEach(() => {
    setupAppTestMocks();
    listBranches.mockResolvedValue(["main", "feature", "free"]);
    listCheckouts.mockResolvedValue([
      { branch: "main", path: ROOT, isMain: true },
      { branch: "feature", path: LINKED, isMain: false }
    ]);
    createAlongsideWorkspace.mockResolvedValue(workspace);
    createCurrentWorkspace.mockResolvedValue(workspace);
    createIsolatedWorkspace.mockResolvedValue(workspace);
    launchProvider.mockResolvedValue(session);
  });

  afterEach(() => {
    cleanup();
    resetToastForTests();
  });

  it("runs in the worktree that already has the branch, without asking git to check it out", async () => {
    render(<App />);

    await pickBranch("feature");
    expect(switchBranch).not.toHaveBeenCalled();
    // The chip says where the chat will run, next to the exact branch name.
    expect(screen.getByRole("button", { name: "Switch branch" })).toHaveTextContent("feature");
    expect(
      screen.getByRole("button", { name: "Switch branch" }).querySelector(".composer-context-chip-label")
    ).toHaveAttribute("data-in", "feature");

    await start();

    await waitFor(() => expect(launchProvider).toHaveBeenCalledOnce());
    expect(createAlongsideWorkspace).toHaveBeenCalledWith({
      projectId: "project-1",
      taskLabel: expect.any(String) as string,
      path: LINKED,
      branch: "feature"
    });
    expect(createCurrentWorkspace).not.toHaveBeenCalled();
    expect(createIsolatedWorkspace).not.toHaveBeenCalled();
    expect(switchBranch).not.toHaveBeenCalled();
  });

  it("starts a worktree from the picked branch and never moves the project root", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Worktree" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Worktree" })).toHaveAttribute("aria-pressed", "true")
    );

    await pickBranch("feature");
    await start();

    await waitFor(() => expect(createIsolatedWorkspace).toHaveBeenCalledOnce());
    expect(createIsolatedWorkspace.mock.calls[0]?.[0]).toMatchObject({
      projectId: "project-1",
      baseRef: "feature"
    });
    expect(switchBranch).not.toHaveBeenCalled();
    expect(createAlongsideWorkspace).not.toHaveBeenCalled();
  });

  it("checks a branch no checkout has out in the project root at launch, not at the pick", async () => {
    render(<App />);

    await pickBranch("free");
    expect(switchBranch).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Switch branch" })).toHaveTextContent("free");

    await start();

    await waitFor(() => expect(launchProvider).toHaveBeenCalledOnce());
    expect(switchBranch).toHaveBeenCalledWith("project-1", "free");
    expect(switchBranch.mock.invocationCallOrder[0]).toBeLessThan(
      createCurrentWorkspace.mock.invocationCallOrder[0] ?? Infinity
    );
    expect(createAlongsideWorkspace).not.toHaveBeenCalled();
  });

  it("hands a pick the checkout list does not show to git, whatever branch the project last saw", async () => {
    // The cached current branch can lag the disk (a terminal `git checkout`), so a
    // pick of what the project believes is current is still sent to git.
    listCheckouts.mockResolvedValue([]);
    render(<App />);

    await pickBranch("main");
    await start();

    await waitFor(() => expect(launchProvider).toHaveBeenCalledOnce());
    expect(switchBranch).toHaveBeenCalledWith("project-1", "main");
    expect(createAlongsideWorkspace).not.toHaveBeenCalled();
  });

  it("refuses a checkout that moved to another branch instead of retargeting it", async () => {
    createAlongsideWorkspace.mockRejectedValue(
      new Error("/tmp/worktrees/feature is on 'other', not 'feature'. Pick the branch again.")
    );
    render(<App />);
    await pickBranch("feature");

    await start();

    await waitFor(() => expect(toastSnapshot()?.message).toContain("is on 'other', not 'feature'"));
    expect(launchProvider).not.toHaveBeenCalled();
    expect(createCurrentWorkspace).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Task prompt")).toHaveValue("Refactor the auth guard");
    // The pick is still there for another try.
    expect(screen.getByRole("button", { name: "Switch branch" })).toHaveTextContent("feature");
  });

  it("sends the pick that was made at send time with a background start, whatever happens after", async () => {
    let finishLaunch!: () => void;
    createAlongsideWorkspace.mockImplementation(
      () => new Promise((resolve) => { finishLaunch = () => resolve(workspace); })
    );
    mockDashboardSnapshot({ ...snapshot, projects: [primaryProject(), secondProject()] });
    render(<App />);
    await pickBranch("feature");
    const field = await screen.findByLabelText("Task prompt");
    fireEvent.change(field, { target: { value: "Background task" } });

    fireEvent.keyDown(field, { key: "Enter", altKey: true });
    await waitFor(() => expect(createAlongsideWorkspace).toHaveBeenCalledOnce());

    // The person moves on to another project while the first launch resolves.
    fireEvent.click(screen.getByRole("button", { name: "Switch project" }));
    fireEvent.click(
      within(screen.getByRole("listbox", { name: "Select project" })).getByRole("button", {
        name: secondProject().name
      })
    );
    await act(async () => {});
    expect(createAlongsideWorkspace.mock.calls[0]?.[0]).toMatchObject({ path: LINKED, branch: "feature" });
    // The other project starts with its own current branch, not the pick.
    expect(
      screen.getByRole("button", { name: "Switch branch" }).querySelector(".composer-context-chip-label")
    ).not.toHaveAttribute("data-in");

    await act(() => {
      finishLaunch();
      return Promise.resolve();
    });
    await waitFor(() => expect(launchProvider).toHaveBeenCalledOnce());
  });
});
