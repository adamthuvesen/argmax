import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

  it("opens as a standalone page and yields the sidebar column to a back rail", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));

    expect(await screen.findByRole("complementary", { name: "Schedule" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Schedule" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Build dashboard" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Task prompt")).not.toBeInTheDocument();

    const rail = screen.getByRole("complementary", { name: "Schedule" });
    fireEvent.click(within(rail).getByRole("button", { name: "Back" }));

    expect(await screen.findByRole("button", { name: "Build dashboard" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Schedule" })).not.toBeInTheDocument();
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
