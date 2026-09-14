import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { App } from "./App.js";
import { CHAT_VERBOSITY_KEY } from "./lib/uiPreferences.js";
import { ACCENT_STORAGE_KEY } from "./lib/accent.js";
import { CHAT_WIDTH_KEY } from "./lib/chatWidth.js";
import { CHAT_FONT_SIZE_STORAGE_KEY, FONT_SIZE_STORAGE_KEY, FONT_STORAGE_KEY } from "./lib/fonts.js";
import { INK_STRENGTH_STORAGE_KEY } from "./lib/inkStrength.js";
import { BACKGROUND_INTENSITY_STORAGE_KEY } from "./lib/backgroundIntensity.js";
import { REVIEW_PANEL_SIDE_KEY } from "./lib/reviewPanelSide.js";
import {
  COMPOSER_CONTEXT_INDICATOR_KEY,
  DESKTOP_NOTIFICATIONS_KEY,
  FAST_MODE_KEY,
  KEEP_AWAKE_KEY,
  TURN_CHANGES_EXPANDED_KEY
} from "./lib/uiPreferences.js";
import { openSettings, setNotificationsEnabledStub, setupAppTestMocks } from "../test/appTestHarness.js";

beforeEach(setupAppTestMocks);
afterEach(cleanup);

it("applies all chat verbosity levels from Cmd+K Actions and persists them in Settings", async () => {
  render(<App />);
  await screen.findByRole("button", { name: "Build dashboard" });

  for (const [index, label] of ["Minimal", "Compact", "Balanced", "Detailed"].entries()) {
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    await screen.findByRole("dialog", { name: "Command palette" });
    fireEvent.click(screen.getByRole("tab", { name: "Actions" }));
    const query = screen.getByRole("searchbox", { name: "Command palette query" });
    fireEvent.change(query, { target: { value: "verbosity" } });
    expect(screen.getAllByRole("option")).toHaveLength(4);
    fireEvent.change(query, { target: { value: `Chat detail ${index + 1}: ${label}` } });
    expect(screen.getByRole("option", { name: new RegExp(label) })).toBeInTheDocument();
    fireEvent.keyDown(query, { key: "Enter" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
      expect(window.localStorage.getItem(CHAT_VERBOSITY_KEY)).toBe(String(index + 1));
    });
  }

  await openSettings("Agents");
  expect(await screen.findByRole("slider", { name: "Chat detail & verbosity" })).toHaveValue("4");
});

it("applies display preferences from Actions to the desktop and saved settings", async () => {
  render(<App />);
  await screen.findByRole("button", { name: "Build dashboard" });

  const choices = [
    { query: "Blue accent", key: ACCENT_STORAGE_KEY, value: "blue", attribute: "data-accent" },
    { query: "Font family: Inter", key: FONT_STORAGE_KEY, value: "inter", attribute: "data-font" },
    { query: "App font size 8", key: FONT_SIZE_STORAGE_KEY, value: "8", attribute: "data-font-size" },
    { query: "Chat font size 7", key: CHAT_FONT_SIZE_STORAGE_KEY, value: "7" },
    { query: "Ink strength 3", key: INK_STRENGTH_STORAGE_KEY, value: "3", attribute: "data-ink-strength" },
    { query: "Background intensity 4", key: BACKGROUND_INTENSITY_STORAGE_KEY, value: "4", attribute: "data-background-intensity" },
    { query: "Chat width 5", key: CHAT_WIDTH_KEY, value: "5" }
  ];
  for (const choice of choices) {
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    await screen.findByRole("dialog", { name: "Command palette" });
    fireEvent.click(screen.getByRole("tab", { name: "Actions" }));
    const query = screen.getByRole("searchbox", { name: "Command palette query" });
    fireEvent.change(query, { target: { value: choice.query } });
    fireEvent.keyDown(query, { key: "Enter" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
      expect(window.localStorage.getItem(choice.key)).toBe(choice.value);
    });
    if (choice.attribute) expect(document.documentElement).toHaveAttribute(choice.attribute, choice.value);
  }
  expect(screen.getByRole("main")).toHaveAttribute("data-chat-width", "5");
});

it("applies the font family and Files panel side from Actions", async () => {
  render(<App />);
  await screen.findByRole("button", { name: "Build dashboard" });

  const choices = [
    { query: "Font family: Inter", key: FONT_STORAGE_KEY, value: "inter" },
    { query: "Files panel: left", key: REVIEW_PANEL_SIDE_KEY, value: "left" }
  ];
  for (const choice of choices) {
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    await screen.findByRole("dialog", { name: "Command palette" });
    fireEvent.click(screen.getByRole("tab", { name: "Actions" }));
    const query = screen.getByRole("searchbox", { name: "Command palette query" });
    fireEvent.change(query, { target: { value: choice.query } });
    fireEvent.keyDown(query, { key: "Enter" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
      expect(window.localStorage.getItem(choice.key)).toBe(choice.value);
    });
  }
  expect(document.documentElement).toHaveAttribute("data-font", "inter");
  expect(screen.getByRole("main")).toHaveAttribute("data-review-panel-side", "left");
});

it("uses next-action labels and persists the boolean Actions", async () => {
  render(<App />);
  await screen.findByRole("button", { name: "Build dashboard" });

  const openActions = async (): Promise<HTMLElement> => {
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    fireEvent.click(screen.getByRole("tab", { name: "Actions" }));
    return dialog;
  };

  await openActions();
  const notificationsQuery = screen.getByRole("searchbox", { name: "Command palette query" });
  fireEvent.change(notificationsQuery, { target: { value: "desktop notifications" } });
  expect(screen.getByRole("option", { name: /Disable desktop notifications/ })).toBeInTheDocument();
  fireEvent.keyDown(notificationsQuery, { key: "Enter" });
  await waitFor(() => expect(window.localStorage.getItem(DESKTOP_NOTIFICATIONS_KEY)).toBe("false"));
  expect(setNotificationsEnabledStub).toHaveBeenCalledWith(false);

  await openActions();
  const enableNotificationsQuery = screen.getByRole("searchbox", { name: "Command palette query" });
  fireEvent.change(enableNotificationsQuery, { target: { value: "desktop notifications" } });
  expect(screen.getByRole("option", { name: /Enable desktop notifications/ })).toBeInTheDocument();
  fireEvent.keyDown(enableNotificationsQuery, { key: "Enter" });
  await waitFor(() => expect(window.localStorage.getItem(DESKTOP_NOTIFICATIONS_KEY)).toBe("true"));

  const booleanActions = [
    { query: "keep computer awake", key: KEEP_AWAKE_KEY, value: "true", label: "Enable keep computer awake" },
    { query: "fast mode", key: FAST_MODE_KEY, value: "true", label: "Enable fast mode" },
    { query: "changed files", key: TURN_CHANGES_EXPANDED_KEY, value: "false", label: "Collapse changed files" },
    { query: "context indicator", key: COMPOSER_CONTEXT_INDICATOR_KEY, value: "true", label: "Show context indicator" }
  ];
  for (const action of booleanActions) {
    await openActions();
    const actionQuery = screen.getByRole("searchbox", { name: "Command palette query" });
    fireEvent.change(actionQuery, { target: { value: action.query } });
    expect(screen.getByRole("option", { name: new RegExp(action.label) })).toBeInTheDocument();
    fireEvent.keyDown(actionQuery, { key: "Enter" });
    await waitFor(() => expect(window.localStorage.getItem(action.key)).toBe(action.value));
  }

  const reverseBooleanActions = [
    { query: "keep computer awake", key: KEEP_AWAKE_KEY, value: "false", label: "Disable keep computer awake" },
    { query: "fast mode", key: FAST_MODE_KEY, value: "false", label: "Disable fast mode" },
    { query: "changed files", key: TURN_CHANGES_EXPANDED_KEY, value: "true", label: "Expand changed files" },
    { query: "context indicator", key: COMPOSER_CONTEXT_INDICATOR_KEY, value: "false", label: "Hide context indicator" }
  ];
  for (const action of reverseBooleanActions) {
    await openActions();
    const actionQuery = screen.getByRole("searchbox", { name: "Command palette query" });
    fireEvent.change(actionQuery, { target: { value: action.query } });
    expect(screen.getByRole("option", { name: new RegExp(action.label) })).toBeInTheDocument();
    fireEvent.keyDown(actionQuery, { key: "Enter" });
    await waitFor(() => expect(window.localStorage.getItem(action.key)).toBe(action.value));
  }

  expect(window.argmax?.system.setKeepAwake).toHaveBeenCalledWith(true);
  expect(window.argmax?.system.setKeepAwake).toHaveBeenCalledWith(false);
});
