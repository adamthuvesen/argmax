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

  it("restores the target project's own draft instead of overwriting it", async () => {
    window.localStorage.setItem(
      "argmax.composer.drafts",
      JSON.stringify({ "launch-project-2": { text: "Rotate the keys", attachments: [] } })
    );
    renderWithTwoProjects();
    fireEvent.change(await screen.findByLabelText("Task prompt"), {
      target: { value: "Fix the parser" }
    });

    await pickProject("Dotfiles");
    expect(screen.getByLabelText("Task prompt")).toHaveValue("Rotate the keys");

    await pickProject("Argmax");
    expect(screen.getByLabelText("Task prompt")).toHaveValue("Fix the parser");
  });
});
