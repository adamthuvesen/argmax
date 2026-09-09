import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App.js";
import { SIDE_CHAT_TITLE } from "./lib/launcherTitle.js";
import {
  GOAL_ENABLED_KEY,
  GOAL_MAX_TURNS_KEY
} from "./lib/uiPreferences.js";
import { launchProvider, setupAppTestMocks } from "../test/appTestHarness.js";

describe("App goal launcher", () => {
  beforeEach(() => {
    setupAppTestMocks();
    window.localStorage.removeItem(GOAL_ENABLED_KEY);
    window.localStorage.removeItem(GOAL_MAX_TURNS_KEY);
  });

  afterEach(() => {
    cleanup();
  });

  it("reveals the Goal slash option after typing / then /go", async () => {
    render(<App />);
    const input = await screen.findByLabelText("Task prompt");

    fireEvent.change(input, { target: { value: "/" } });
    fireEvent.change(input, { target: { value: "/go" } });

    expect(await screen.findByRole("option", { name: /^Goal/ })).toBeInTheDocument();
  });

  it("inserts '/goal ' on Goal option mouseDown without launching", async () => {
    render(<App />);
    const input = await screen.findByLabelText("Task prompt");

    fireEvent.change(input, { target: { value: "/go" } });
    fireEvent.mouseDown(await screen.findByRole("option", { name: /^Goal/ }));

    expect(input).toHaveValue("/goal ");
    expect(launchProvider).not.toHaveBeenCalled();
  });

  it("submits a goal launch with parsed condition and default max turns", async () => {
    render(<App />);
    const input = await screen.findByLabelText("Task prompt");

    fireEvent.change(input, { target: { value: "/goal all tests pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Start agent" }));

    await waitFor(() => expect(launchProvider).toHaveBeenCalledTimes(1));
    expect(launchProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "all tests pass",
        goalCondition: "all tests pass",
        goalMaxTurns: 20
      })
    );
  });

  it("submits a goal launch from side chat", async () => {
    render(<App />);
    const input = await screen.findByLabelText("Task prompt");

    fireEvent.keyDown(input, { key: "Tab" });
    fireEvent.keyDown(input, { key: "Tab" });
    await screen.findByText(SIDE_CHAT_TITLE);

    fireEvent.change(input, { target: { value: "/goal all tests pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Start agent" }));

    await waitFor(() => expect(launchProvider).toHaveBeenCalledTimes(1));
    expect(launchProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "all tests pass",
        goalCondition: "all tests pass",
        goalMaxTurns: 20
      })
    );
  });

  it("shows an alert and does not launch for '/goal clear'", async () => {
    render(<App />);
    const input = await screen.findByLabelText("Task prompt");

    fireEvent.change(input, { target: { value: "/goal clear" } });
    fireEvent.click(screen.getByRole("button", { name: "Start agent" }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(launchProvider).not.toHaveBeenCalled();
  });

  it("shows an alert and does not launch for bare '/goal'", async () => {
    render(<App />);
    const input = await screen.findByLabelText("Task prompt");

    fireEvent.change(input, { target: { value: "/goal" } });
    fireEvent.click(screen.getByRole("button", { name: "Start agent" }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(launchProvider).not.toHaveBeenCalled();
  });

  it("omits the Goal option and sends an ordinary prompt when goal launcher is disabled", async () => {
    window.localStorage.setItem(GOAL_ENABLED_KEY, "false");

    render(<App />);
    const input = await screen.findByLabelText("Task prompt");

    fireEvent.change(input, { target: { value: "/go" } });
    expect(screen.queryByRole("option", { name: /^Goal/ })).toBeNull();

    fireEvent.change(input, { target: { value: "/goal all tests pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Start agent" }));

    await waitFor(() => expect(launchProvider).toHaveBeenCalledTimes(1));
    expect(launchProvider.mock.calls[0]?.[0]).toMatchObject({
      prompt: "/goal all tests pass"
    });
    expect(launchProvider.mock.calls[0]?.[0]?.goalCondition).toBeUndefined();
  });

  it("uses a custom goal max turns from preferences", async () => {
    window.localStorage.setItem(GOAL_MAX_TURNS_KEY, "12");

    render(<App />);
    const input = await screen.findByLabelText("Task prompt");

    fireEvent.change(input, { target: { value: "/goal all tests pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Start agent" }));

    await waitFor(() => expect(launchProvider).toHaveBeenCalledTimes(1));
    expect(launchProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        goalMaxTurns: 12
      })
    );
  });
});
