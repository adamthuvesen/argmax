import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { optionName } from "../../test/optionName.js";
import { App } from "../App.js";
import { persistLaunchProjectId } from "../lib/launchProjectPreference.js";
import {
  dashboardDeltaListener,
  mockDashboardSnapshot,
  primaryProject,
  secondProject,
  setupAppTestMocks,
  snapshot
} from "../../test/appTestHarness.js";

function renderWithTwoProjects(): void {
  mockDashboardSnapshot({ ...snapshot, projects: [primaryProject(), secondProject()] });
  render(<App />);
}

async function pickProject(name: string): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Switch project" }));
  fireEvent.click(
    within(screen.getByRole("listbox", { name: "Select project" })).getByRole("button", { name })
  );
  // Selecting a repo kicks off a branch refresh; settle it so its state update
  // lands inside the test rather than after the assertions.
  await act(async () => {});
}

describe("launcher prompt across context changes", () => {
  beforeEach(() => {
    setupAppTestMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it.each([
    "Your local changes would be overwritten by checkout.",
    { message: "Your local changes would be overwritten by checkout." }
  ])("keeps the composer usable after a branch-switch rejection: %j", async (error) => {
    vi.spyOn(window.argmax!.projects, "listBranches").mockResolvedValue(["main", "feature"]);
    vi.spyOn(window.argmax!.projects, "switchBranch").mockRejectedValue(error);
    render(<App />);
    const prompt = await screen.findByLabelText("Task prompt");
    fireEvent.change(prompt, { target: { value: "Refactor the auth guard" } });

    fireEvent.click(screen.getByRole("button", { name: "Switch branch" }));
    const listbox = await screen.findByRole("listbox", { name: "Select branch" });
    fireEvent.click(within(listbox).getByRole("button", { name: "feature" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your local changes would be overwritten by checkout."
    );
    expect(prompt).toHaveValue("Refactor the auth guard");
    expect(prompt).toBeEnabled();
    expect(prompt).toHaveFocus();
    expect(screen.getByRole("button", { name: "Switch branch" })).toHaveTextContent("main");
    expect(screen.getByRole("button", { name: "Start agent" })).toBeEnabled();

    fireEvent.change(prompt, { target: { value: "Refactor the auth guard safely" } });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(prompt).toHaveValue("Refactor the auth guard safely");
    expect(prompt).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Switch branch" }));
    expect(await screen.findByRole("listbox", { name: "Select branch" })).toBeVisible();
  });

  it("keeps the typed prompt when the model changes", async () => {
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Task prompt"), {
      target: { value: "Refactor the auth guard" }
    });

    fireEvent.click(screen.getByRole("button", { name: "Switch model" }));
    fireEvent.click(
      within(await screen.findByRole("listbox", { name: "Switch model" })).getByRole("button", {
        name: "Sonnet 5"
      })
    );

    expect(screen.getByLabelText("Task prompt")).toHaveValue("Refactor the auth guard");
  });

  it("carries the typed prompt to the project the user switches to", async () => {
    renderWithTwoProjects();
    fireEvent.change(await screen.findByLabelText("Task prompt"), {
      target: { value: "Refactor the auth guard" }
    });

    await pickProject("Dotfiles");
    expect(screen.getByLabelText("Task prompt")).toHaveValue("Refactor the auth guard");

    await pickProject("Argmax");
    expect(screen.getByLabelText("Task prompt")).toHaveValue("Refactor the auth guard");
  });

  it.each(["picker", "sidebar"])("selects the dashboard's current repo from the %s when the launcher remembers another", async (entry) => {
    persistLaunchProjectId(secondProject().id);
    renderWithTwoProjects();
    expect(await screen.findByRole("button", { name: "Switch project" })).toHaveTextContent("Dotfiles");

    // Dashboard selection is already Argmax, so picking it cannot depend on
    // that unrelated state changing to repaint the remembered launcher repo.
    if (entry === "picker") {
      await pickProject("Argmax");
    } else {
      fireEvent.click(screen.getByRole("button", { name: "Argmax" }));
    }

    expect(screen.getByRole("button", { name: "Switch project" })).toHaveTextContent("Argmax");
  });

  it("keeps the picked repo after typing and a dashboard delta from a hidden session", async () => {
    // Default new-chat mode is Full view: ⌘N hides the grid but leaves its
    // focused session in selection state. A later dashboard:delta used to
    // mirror that hidden cell back onto the launcher chip.
    mockDashboardSnapshot({ ...snapshot, projects: [primaryProject(), secondProject()] });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    await screen.findByRole("heading", { name: "Argmax" });
    fireEvent.keyDown(document, { key: "n", metaKey: true });

    const prompt = await screen.findByLabelText("Task prompt");
    fireEvent.change(prompt, { target: { value: "First sentence" } });
    expect(screen.getByRole("button", { name: "Switch project" })).toHaveTextContent("Argmax");

    await pickProject("Dotfiles");
    expect(screen.getByRole("button", { name: "Switch project" })).toHaveTextContent("Dotfiles");

    fireEvent.change(screen.getByLabelText("Task prompt"), {
      target: { value: "First sentence. And more." }
    });
    act(() => {
      dashboardDeltaListener?.({
        workspaces: snapshot.workspaces.map((workspace) => ({
          ...workspace,
          lastActivityAt: "2026-05-08T16:00:00.000Z"
        }))
      });
    });

    expect(screen.getByRole("button", { name: "Switch project" })).toHaveTextContent("Dotfiles");
    expect(screen.getByLabelText("Task prompt")).toHaveValue("First sentence. And more.");
  });

  it("keeps the last picked project when returning to new chat after opening a session", async () => {
    mockDashboardSnapshot({ ...snapshot, projects: [primaryProject(), secondProject()] });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    await screen.findByRole("heading", { name: "Argmax" });
    fireEvent.keyDown(document, { key: "n", metaKey: true });

    expect(await screen.findByRole("button", { name: "Switch project" })).toHaveTextContent("Argmax");
    await pickProject("Dotfiles");
    expect(screen.getByRole("button", { name: "Switch project" })).toHaveTextContent("Dotfiles");

    fireEvent.click(screen.getByRole("button", { name: "Switch project" }));
    const picker = screen.getByRole("listbox", { name: "Select project" });
    const names = within(picker)
      .getAllByRole("option")
      .map((option) => optionName(option))
      .filter((name) => name && name !== "Browse folder…");
    expect(names[0]).toBe("Dotfiles");
    fireEvent.mouseDown(document.querySelector(".picker-dismiss-layer") as Element);

    fireEvent.click(screen.getByRole("button", { name: "Build dashboard" }));
    await screen.findByRole("heading", { name: "Argmax" });
    fireEvent.keyDown(document, { key: "n", metaKey: true });

    expect(await screen.findByRole("button", { name: "Switch project" })).toHaveTextContent("Dotfiles");
  });

  it("carries the typed prompt over a stale draft stored on the target project", async () => {
    window.localStorage.setItem(
      "argmax.composer.drafts",
      JSON.stringify({ "launch-project-2": { text: "Rotate the keys", attachments: [] } })
    );
    renderWithTwoProjects();
    fireEvent.change(await screen.findByLabelText("Task prompt"), {
      target: { value: "Fix the parser" }
    });

    await pickProject("Dotfiles");
    expect(screen.getByLabelText("Task prompt")).toHaveValue("Fix the parser");
  });

  it("restores a project's stored draft when the composer is empty", async () => {
    window.localStorage.setItem(
      "argmax.composer.drafts",
      JSON.stringify({ "launch-project-2": { text: "Rotate the keys", attachments: [] } })
    );
    renderWithTwoProjects();
    await screen.findByLabelText("Task prompt");

    await pickProject("Dotfiles");
    expect(screen.getByLabelText("Task prompt")).toHaveValue("Rotate the keys");
  });

  it("does not hand the carried prompt the target project's screenshots", async () => {
    // Text and images are one unsent message. Carrying the text onto another
    // project while adopting that project's stored images would submit a
    // screenshot the user never attached to this prompt — and would strand the
    // image whose explaining sentence was just overwritten.
    window.localStorage.setItem(
      "argmax.composer.drafts",
      JSON.stringify({
        "launch-project-2": {
          text: "Rotate the keys — see the screenshot",
          attachments: [{ filePath: "/tmp/shot.png", mimeType: "image/png", sizeBytes: 10 }]
        }
      })
    );
    renderWithTwoProjects();
    fireEvent.change(await screen.findByLabelText("Task prompt"), {
      target: { value: "Fix the parser" }
    });

    await pickProject("Dotfiles");

    expect(screen.getByLabelText("Task prompt")).toHaveValue("Fix the parser");
    expect(screen.queryByRole("button", { name: /Remove attachment/i })).not.toBeInTheDocument();
    const stored = JSON.parse(
      window.localStorage.getItem("argmax.composer.drafts") ?? "{}"
    ) as Record<string, { attachments?: unknown[] } | undefined>;
    expect(stored["launch-project-2"]?.attachments ?? []).toEqual([]);
  });

  it("opens a stored launcher screenshot in the image preview", async () => {
    window.localStorage.setItem(
      "argmax.composer.drafts",
      JSON.stringify({
        "launch-project-1": {
          text: "Review the screenshot",
          attachments: [{ filePath: "/tmp/shot.png", mimeType: "image/png", sizeBytes: 10 }]
        }
      })
    );
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "View attachment" }));
    expect(screen.getByRole("dialog", { name: "Attached image" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close image preview" }));
    expect(screen.queryByRole("dialog", { name: "Attached image" })).toBeNull();
  });
});
