import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type JSX } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCopyToClipboard } from "./useCopyToClipboard.js";

function CopyButton({ text }: { text: string }): JSX.Element {
  const [flash, copy] = useCopyToClipboard();
  return (
    <button type="button" onClick={() => void copy(text)}>
      {flash}
    </button>
  );
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(document, "execCommand");
});

/** jsdom ships no `execCommand`, so the fallback needs one to call. */
function stubExecCommand(result: boolean): ReturnType<typeof vi.fn> {
  const execCommand = vi.fn(() => result);
  Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
  return execCommand;
}

describe("useCopyToClipboard", () => {
  it("copies through the command when the async clipboard is missing", async () => {
    // The chat opened over the remote bridge's plain HTTP is not a secure
    // context, and `navigator.clipboard` is undefined there.
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    const execCommand = stubExecCommand(true);
    render(<CopyButton text="the reply" />);
    const button = screen.getByRole("button");

    fireEvent.click(button);
    await vi.waitFor(() => expect(button).toHaveTextContent("copied"));

    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("falls back to the command when the async write is refused", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockRejectedValue(
      new DOMException("Document is not focused", "NotAllowedError")
    );
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    stubExecCommand(true);
    render(<CopyButton text="the reply" />);
    const button = screen.getByRole("button");

    fireEvent.click(button);
    await vi.waitFor(() => expect(button).toHaveTextContent("copied"));
  });

  it("reports a failure only when nothing reached the clipboard", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    stubExecCommand(false);
    render(<CopyButton text="the reply" />);
    const button = screen.getByRole("button");

    fireEvent.click(button);
    await vi.waitFor(() => expect(button).toHaveTextContent("failed"));
  });
});
