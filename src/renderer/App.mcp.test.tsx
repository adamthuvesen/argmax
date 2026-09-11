import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupAppTestMocks, launchProvider } from "../test/appTestHarness.js";
import { App } from "./App.js";

describe("App connection launcher", () => {
  beforeEach(setupAppTestMocks);
  afterEach(cleanup);

  it("opens Connections from the /mcp option without launching", async () => {
    render(<App />);
    const input = await screen.findByLabelText("Task prompt");

    fireEvent.change(input, { target: { value: "/mcp" } });
    fireEvent.mouseDown(await screen.findByRole("option", { name: /^Connections/ }));

    expect(screen.getByRole("dialog", { name: "Connections" })).toBeInTheDocument();
    expect(await screen.findByText("No connections found.")).toBeInTheDocument();
    expect(input).toHaveValue("");
    expect(launchProvider).not.toHaveBeenCalled();
  });

  it("intercepts a submitted /mcp before provider launch", async () => {
    render(<App />);
    const input = await screen.findByLabelText("Task prompt");

    fireEvent.change(input, { target: { value: "/mcp" } });
    fireEvent.click(screen.getByRole("button", { name: "Start agent" }));

    expect(screen.getByRole("dialog", { name: "Connections" })).toBeInTheDocument();
    expect(await screen.findByText("No connections found.")).toBeInTheDocument();
    expect(launchProvider).not.toHaveBeenCalled();
  });
});
