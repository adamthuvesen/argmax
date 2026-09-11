import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodeBlock } from "./CodeBlock.js";

describe("CodeBlock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("renders the language label when className declares one", () => {
    render(<CodeBlock className="language-ts">const x = 1;</CodeBlock>);
    expect(screen.getByText("TypeScript")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy code" }).closest("[data-label]")).toHaveAttribute(
      "data-label",
      "TypeScript"
    );
  });

  it("provides an in-flow wrap control for long lines", () => {
    render(<CodeBlock className="language-ts">const x = 1;</CodeBlock>);
    const wrapButton = screen.getByRole("button", { name: "Wrap lines" });

    expect(wrapButton).toHaveAttribute("aria-pressed", "false");
    expect(wrapButton.closest(".code-block-header")?.nextElementSibling?.tagName).toBe("PRE");

    fireEvent.click(wrapButton);

    expect(wrapButton).toHaveAttribute("aria-pressed", "true");
    expect(wrapButton).toHaveAttribute("title", "Unwrap lines");
    expect(wrapButton.closest(".code-block")).toHaveAttribute("data-wrap", "true");
  });

  it("hides the label for plain-text fences — TEXT over plain output is noise", () => {
    render(<CodeBlock className="language-text">plain output</CodeBlock>);
    expect(screen.queryByText("text")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy code" }).closest("[data-label]")).toBeNull();
  });

  it("copies the raw text content to the clipboard", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    render(<CodeBlock className="language-py">print("hi")</CodeBlock>);
    const button = screen.getByRole("button", { name: "Copy code" });
    expect(button).toHaveAttribute("title", "Copy code");
    fireEvent.click(button);
    expect(writeText).toHaveBeenCalledWith('print("hi")');
    await act(async () => {
      await Promise.resolve();
    });
    expect(button).toHaveAttribute("title", "Copied!");
    expect(screen.getByRole("status")).toHaveTextContent("Code copied.");
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(button).toHaveAttribute("title", "Copy code");
  });

  it("collects text from nested children (syntax-highlighter shape)", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(
      <CodeBlock className="language-ts">
        <span>const </span>
        <span>x</span>
        <span> = 1;</span>
      </CodeBlock>
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    expect(writeText).toHaveBeenCalledWith("const x = 1;");
    await act(async () => {
      await Promise.resolve();
    });
  });
});
