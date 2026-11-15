import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatBubble } from "./ChatBubble.js";

describe("ChatBubble", () => {
  afterEach(() => {
    cleanup();
  });

  it("offers Show more only when the body is clipped, and toggles both ways", () => {
    // jsdom reports every box as 0x0, so stand in for the CSS cap: content
    // taller than the clipped client box is what makes the toggle appear.
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(900);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
    render(
      <ChatBubble kind="user" rawMarkdown="long">
        <p>long</p>
      </ChatBubble>,
    );
    const toggle = screen.getByRole("button", { name: "Show more" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("chat-bubble-body")).not.toHaveClass("expanded");

    fireEvent.click(toggle);
    const collapse = screen.getByRole("button", { name: "Show less" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("chat-bubble-body")).toHaveClass("expanded");

    fireEvent.click(collapse);
    expect(screen.getByRole("button", { name: "Show more" })).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it("leaves a short message without a Show more toggle", () => {
    render(
      <ChatBubble kind="user" rawMarkdown="and so on?">
        <p>and so on?</p>
      </ChatBubble>,
    );
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
    // `.clipped` is what turns on overflow:hidden. A short prompt must not
    // get that class — it was clipping the trailing `?` on one-line bubbles.
    expect(screen.getByTestId("chat-bubble-body")).not.toHaveClass("clipped");
  });

  it("reveals the toggle when the prose grows after mount (late image or font)", () => {
    // The capped body never changes size, so the component watches the content
    // instead. Stand in for that observer and re-run its callback once the
    // content has outgrown the cap.
    let notify: (() => void) | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          notify = callback;
        }
        observe(): void {}
        disconnect(): void {}
      },
    );
    render(
      <ChatBubble kind="user" rawMarkdown="grows">
        <p>grows</p>
      </ChatBubble>,
    );
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();

    // Per-element, not on the prototype: the capped body keeps reporting the
    // cap it is pinned to, and only the content knows it outgrew it.
    const body = screen.getByTestId("chat-bubble-body");
    Object.defineProperty(body, "clientHeight", { configurable: true, value: 300 });
    Object.defineProperty(body, "scrollHeight", { configurable: true, value: 300 });
    Object.defineProperty(screen.getByTestId("chat-bubble-content"), "scrollHeight", {
      configurable: true,
      value: 900,
    });
    act(() => notify?.());
    expect(screen.getByRole("button", { name: "Show more" })).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("does not wrap assistant messages (cap is user-only)", () => {
    render(
      <ChatBubble kind="assistant" rawMarkdown="reply">
        <p>reply</p>
      </ChatBubble>,
    );
    expect(screen.queryByTestId("chat-bubble-body")).toBeNull();
  });

  it("calls clipboard.writeText with the raw markdown on copy", async () => {
    const writeText = vi
      .fn<(text: string) => Promise<void>>()
      .mockImplementation(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <ChatBubble kind="assistant" rawMarkdown="**bold**">
        <p>**bold**</p>
      </ChatBubble>,
    );
    const button = screen.getByRole("button", { name: "Copy bubble" });
    fireEvent.click(button);
    expect(writeText).toHaveBeenCalledWith("**bold**");
    await waitFor(() => expect(button).toHaveAttribute("title", "Copied"));
  });
});
