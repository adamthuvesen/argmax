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
    expect(screen.getByText("ts")).toBeInTheDocument();
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
