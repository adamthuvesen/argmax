import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { App } from "./App.js";
import { ESCAPE_STOPS_CHAT_KEY } from "./lib/uiPreferences.js";
import { openSettings, setupAppTestMocks, terminateProvider } from "../test/appTestHarness.js";

beforeEach(() => setupAppTestMocks());
afterEach(() => cleanup());

async function openRunningChat(): Promise<HTMLElement> {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
  await screen.findByRole("button", { name: "Stop chat" });
  return screen.getByLabelText("Chat prompt");
}

it("does not stop a running chat with Escape by default", async () => {
  const prompt = await openRunningChat();
  fireEvent.keyDown(prompt, { key: "Escape" });
  expect(terminateProvider).not.toHaveBeenCalled();
});

it("closes the command palette and sidebar before stopping the focused chat", async () => {
  window.localStorage.setItem(ESCAPE_STOPS_CHAT_KEY, "true");
  const prompt = await openRunningChat();
  fireEvent.keyDown(document, { key: "b", metaKey: true });
  await screen.findByRole("complementary", { name: "Review panel" });
  fireEvent.keyDown(document, { key: "k", metaKey: true });
  const palette = await screen.findByRole("dialog", { name: "Command palette" });

  fireEvent.keyDown(within(palette).getByRole("searchbox", { name: "Command palette query" }), { key: "Escape" });
  expect(screen.getByRole("complementary", { name: "Review panel" })).toBeInTheDocument();
  expect(terminateProvider).not.toHaveBeenCalled();
  fireEvent.keyDown(prompt, { key: "Escape" });
  expect(screen.queryByRole("complementary", { name: "Review panel" })).not.toBeInTheDocument();
  expect(terminateProvider).not.toHaveBeenCalled();
  fireEvent.keyDown(prompt, { key: "Escape" });
  await waitFor(() => expect(terminateProvider).toHaveBeenCalledExactlyOnceWith("session-1"));
});

it("closes Settings without also stopping the chat it reveals", async () => {
  window.localStorage.setItem(ESCAPE_STOPS_CHAT_KEY, "true");
  await openRunningChat();
  await openSettings();
  fireEvent.keyDown(document, { key: "Escape" });
  const prompt = await screen.findByLabelText("Chat prompt");
  expect(terminateProvider).not.toHaveBeenCalled();
  fireEvent.keyDown(prompt, { key: "Escape" });
  await waitFor(() => expect(terminateProvider).toHaveBeenCalledExactlyOnceWith("session-1"));
});

it("dismisses slash autocomplete before stopping the chat", async () => {
  window.localStorage.setItem(ESCAPE_STOPS_CHAT_KEY, "true");
  const prompt = await openRunningChat();
  fireEvent.change(prompt, { target: { value: "/" } });
  await screen.findByRole("listbox", { name: "Slash commands" });
  fireEvent.keyDown(prompt, { key: "Escape" });
  expect(screen.queryByRole("listbox", { name: "Slash commands" })).not.toBeInTheDocument();
  expect(terminateProvider).not.toHaveBeenCalled();
  fireEvent.keyDown(prompt, { key: "Escape" });
  await waitFor(() => expect(terminateProvider).toHaveBeenCalledExactlyOnceWith("session-1"));
});
