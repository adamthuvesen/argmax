import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App.js";
import { setupAppTestMocks } from "../test/appTestHarness.js";

describe("App schedule", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    setupAppTestMocks();
  });

  it("opens in the workspace with the app sidebar kept, and Esc leaves it", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));

    expect(await screen.findByRole("heading", { name: "Schedule" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Build dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Schedule" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByLabelText("Task prompt")).not.toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(screen.queryByRole("heading", { name: "Schedule" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Schedule" })).not.toHaveAttribute("aria-current");
  });

  it("does not leak the schedule editor into settings", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    fireEvent.click(await screen.findByRole("button", { name: "New task" }));
    expect(screen.getByLabelText("Name")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: ",", metaKey: true });

    expect(await screen.findByRole("heading", { name: "General" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Schedule" })).not.toBeInTheDocument();
    expect(screen.queryByText("New task")).not.toBeInTheDocument();
  });
});
