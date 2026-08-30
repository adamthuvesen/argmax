import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App.js";
import { mockDashboardSnapshot, setupAppTestMocks, snapshot } from "../test/appTestHarness.js";

async function openSessionPane(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
  expect(await screen.findByRole("heading", { name: "Argmax" })).toBeInTheDocument();
}

// The seeded session runs on Codex, so "Sonnet 5" crosses providers and raises
// the confirmation. The path under test is the recommended one: the launcher
// has to come up already aimed at the picked model, holding the follow-up the
// user had started for the old agent.
describe("provider switch — new session instead", () => {
  beforeEach(() => {
    setupAppTestMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("opens the launcher with the picked model and the carried draft", async () => {
    // Provider switching is gated to idle sessions: the seeded session is
    // running, which locks the picker to its own provider.
    mockDashboardSnapshot({
      ...snapshot,
      workspaces: snapshot.workspaces.map((workspace) => ({ ...workspace, state: "complete" })),
      sessions: snapshot.sessions.map((session) => ({ ...session, state: "complete" }))
    });
    render(<App />);
    await openSessionPane();

    fireEvent.change(screen.getByRole("textbox", { name: "Session prompt" }), {
      target: { value: "Second opinion on the auth guard" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Session model" }));
    fireEvent.click(
      within(screen.getByRole("listbox", { name: "Session model" })).getByRole("button", {
        name: "Sonnet 5"
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "New session" }));

    expect(await screen.findByLabelText("Task prompt")).toHaveValue("Second opinion on the auth guard");
    expect(screen.getByRole("button", { name: "Switch model" })).toHaveTextContent("Sonnet 5");
  });
});
