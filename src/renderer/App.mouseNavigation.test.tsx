import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { openSettings, setupAppTestMocks } from "../test/appTestHarness.js";

beforeEach(() => setupAppTestMocks());
afterEach(() => cleanup());

function mouseHistory(button: number, target: HTMLElement = document.body): void {
  fireEvent.mouseDown(target, { button });
  fireEvent.mouseUp(target, { button });
}

it("goes back and forward through chats and Settings without recording replay", async () => {
  render(<App />);
  await screen.findByLabelText("Task prompt");
  fireEvent.click(screen.getByRole("button", { name: "Build dashboard" }));
  await screen.findByRole("group", { name: "Chat panes" });
  await openSettings();

  mouseHistory(3);
  expect(await screen.findByRole("group", { name: "Chat panes" })).toBeInTheDocument();
  expect(screen.queryByRole("complementary", { name: "Settings groups" })).not.toBeInTheDocument();
  mouseHistory(3);
  expect(await screen.findByLabelText("Task prompt")).toBeInTheDocument();
  mouseHistory(4);
  expect(await screen.findByRole("group", { name: "Chat panes" })).toBeInTheDocument();
  mouseHistory(4);
  expect(await screen.findByRole("complementary", { name: "Settings groups" })).toBeInTheDocument();
});

it("drops forward history after opening a different app page", async () => {
  render(<App />);
  await screen.findByLabelText("Task prompt");
  fireEvent.click(screen.getByRole("button", { name: "Build dashboard" }));
  await screen.findByRole("group", { name: "Chat panes" });
  await openSettings();
  mouseHistory(3);
  await screen.findByRole("group", { name: "Chat panes" });
  fireEvent.click(screen.getByRole("button", { name: "Browser" }));
  await screen.findByRole("region", { name: "Browser" });

  mouseHistory(4);
  expect(screen.getByRole("region", { name: "Browser" })).toBeInTheDocument();
  mouseHistory(3);
  expect(await screen.findByRole("group", { name: "Chat panes" })).toBeInTheDocument();
  mouseHistory(4);
  expect(await screen.findByRole("region", { name: "Browser" })).toBeInTheDocument();
});

it("keeps browser chrome clicks in page history", async () => {
  const browser = window.argmax!.browser;
  const back = vi.spyOn(browser, "back");
  const forward = vi.spyOn(browser, "forward");
  render(<App />);
  await screen.findByLabelText("Task prompt");
  fireEvent.click(screen.getByRole("button", { name: "Browser" }));
  const address = await screen.findByRole("textbox", { name: "Address" });

  mouseHistory(3, address);
  mouseHistory(4, address);
  expect(back).toHaveBeenCalledOnce();
  expect(forward).toHaveBeenCalledOnce();
  expect(screen.getByRole("region", { name: "Browser" })).toBeInTheDocument();
  mouseHistory(3);
  expect(await screen.findByLabelText("Task prompt")).toBeInTheDocument();
});

it("restores side-chat mode for an earlier New chat destination", async () => {
  render(<App />);
  await screen.findByLabelText("Task prompt");

  fireEvent.click(screen.getByRole("button", { name: "New chat without a repository" }));
  expect(await screen.findByRole("button", { name: "Chat mode" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Build dashboard" }));
  await screen.findByRole("group", { name: "Chat panes" });

  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  await screen.findByLabelText("Task prompt");
  expect(screen.queryByRole("button", { name: "Chat mode" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Build dashboard" }));
  await screen.findByRole("group", { name: "Chat panes" });

  mouseHistory(3);
  await screen.findByLabelText("Task prompt");
  expect(screen.queryByRole("button", { name: "Chat mode" })).not.toBeInTheDocument();
  mouseHistory(3);
  expect(await screen.findByRole("group", { name: "Chat panes" })).toBeInTheDocument();
  mouseHistory(3);
  expect(await screen.findByRole("button", { name: "Chat mode" })).toBeInTheDocument();
});
