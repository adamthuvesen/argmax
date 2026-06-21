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

  it("wraps a user message body in the height-capped scroll container", () => {
    const longMessage = Array.from({ length: 40 }, (_, i) => `paragraph ${i}`).join("\n\n");
    const { container } = render(
      <ChatBubble kind="user" rawMarkdown={longMessage}>
        <p>{longMessage}</p>
      </ChatBubble>
    );
    const body = container.querySelector(".chat-bubble-body");
    expect(body).not.toBeNull();
    expect(body?.querySelector("p")).toHaveTextContent("paragraph 0");
  });

  it("does not wrap assistant messages (cap is user-only)", () => {
    const { container } = render(
      <ChatBubble kind="assistant" rawMarkdown="reply">
        <p>reply</p>
      </ChatBubble>
    );
    expect(container.querySelector(".chat-bubble-body")).toBeNull();
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
