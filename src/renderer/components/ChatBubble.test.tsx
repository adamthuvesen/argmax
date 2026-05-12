import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatBubble } from "./ChatBubble.js";

describe("ChatBubble", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-05-12T15:00:00.000Z") });
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("renders the same-day timestamp and a Copy button", () => {
    render(
      <ChatBubble kind="user" createdAt="2026-05-12T14:30:00.000Z" rawMarkdown="hello">
        <p>hello</p>
      </ChatBubble>
    );
    expect(screen.getByRole("button", { name: "Copy bubble" })).toBeInTheDocument();
    // jsdom respects the fake locale; just ensure something time-looking renders
    expect(screen.getByText(/\d{1,2}:\d{2}/)).toBeInTheDocument();
  });

  it("calls clipboard.writeText with the raw markdown on copy", () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockImplementation(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    render(
      <ChatBubble kind="assistant" createdAt="2026-05-12T14:30:00.000Z" rawMarkdown="**bold**">
        <p>**bold**</p>
      </ChatBubble>
    );
    screen.getByRole("button", { name: "Copy bubble" }).click();
    expect(writeText).toHaveBeenCalledWith("**bold**");
  });
});
