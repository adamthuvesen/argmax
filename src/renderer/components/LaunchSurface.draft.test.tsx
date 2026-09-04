import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../App.js";
import {
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
