import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatBubble } from "./ChatBubble.js";

describe("ChatBubble", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders a Copy button", () => {
    render(
      <ChatBubble kind="user" rawMarkdown="hello">
        <p>hello</p>
      </ChatBubble>
    );
    expect(screen.getByRole("button", { name: "Copy bubble" })).toBeInTheDocument();
  });

  it("calls clipboard.writeText with the raw markdown on copy", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockImplementation(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    render(
      <ChatBubble kind="assistant" rawMarkdown="**bold**">
        <p>**bold**</p>
      </ChatBubble>
    );
    const button = screen.getByRole("button", { name: "Copy bubble" });
    fireEvent.click(button);
    expect(writeText).toHaveBeenCalledWith("**bold**");
    await waitFor(() => expect(button).toHaveAttribute("title", "Copied!"));
  });
});
