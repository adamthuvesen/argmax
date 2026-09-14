import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as linkTarget from "../../lib/linkTarget.js";
import { EngramSettings } from "./EngramSettings.js";

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("EngramSettings", () => {
  it("starts as an optional setup guide without requiring a connection", () => {
    render(
      <EngramSettings provider="codex" onProviderChange={vi.fn()} />
    );

    expect(screen.getByText(/Argmax works without it/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Installation guide" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Set up Engram" }));
    expect(screen.getByRole("link", { name: "Installation guide" })).toHaveAttribute(
      "href", "https://github.com/adamthuvesen/engram#run-it"
    );
  });

  it("marks a relative directory invalid and hides command output", () => {
    render(<EngramSettings provider="codex" onProviderChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Set up Engram" }));

    const directory = screen.getByLabelText("Engram installation folder");
    fireEvent.change(directory, { target: { value: "relative/path" } });

    expect(directory).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByLabelText("3. Connect Codex")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy Engram command" })).not.toBeInTheDocument();
  });

  it("opens the installation guide through the desktop bridge", () => {
    const openPath = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("argmax", { system: { openPath } });
    vi.spyOn(linkTarget, "readStoredLinkTarget").mockReturnValue("system");
    render(<EngramSettings provider="codex" onProviderChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Set up Engram" }));
    fireEvent.click(screen.getByRole("link", { name: "Installation guide" }));

    expect(openPath).toHaveBeenCalledWith({ path: "https://github.com/adamthuvesen/engram#run-it" });
  });

  it("shows generated command for an absolute directory", () => {
    render(<EngramSettings provider="codex" onProviderChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Set up Engram" }));

    fireEvent.change(screen.getByLabelText("Engram installation folder"), {
      target: { value: "/Users/dev/argmax" }
    });

    const command = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "3. Connect Codex" });
    expect(command.value).toContain("/Users/dev/argmax");
    expect(screen.getByRole("button", { name: "Copy Engram command" })).toBeEnabled();
  });

  it("keeps the directory when provider changes and updates command format", () => {
    const path = "/Users/dev/argmax";
    const { rerender } = render(
      <EngramSettings provider="codex" onProviderChange={vi.fn()} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Set up Engram" }));

    fireEvent.change(screen.getByLabelText("Engram installation folder"), { target: { value: path } });
    const codexCommand = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "3. Connect Codex" }).value;

    rerender(<EngramSettings provider="cursor" onProviderChange={vi.fn()} />);

    expect(screen.getByLabelText("Engram installation folder")).toHaveValue(path);
    const cursorCommand = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "3. Connect Cursor" }).value;
    expect(cursorCommand).not.toBe(codexCommand);
    expect(cursorCommand).toMatch(/^\s*\{/);
  });

  it("copies the generated command to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

    render(<EngramSettings provider="codex" onProviderChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Set up Engram" }));

    fireEvent.change(screen.getByLabelText("Engram installation folder"), {
      target: { value: "/Users/dev/argmax" }
    });
    const command = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "3. Connect Codex" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy Engram command" }));
      await Promise.resolve();
    });

    expect(screen.getByText("Copied")).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(command.value);
  });

  it("calls onProviderChange when Codex is selected", () => {
    const onProviderChange = vi.fn();
    render(<EngramSettings provider="cursor" onProviderChange={onProviderChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Set up Engram" }));

    fireEvent.click(screen.getByRole("button", { name: "Engram agent" }));
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));

    expect(onProviderChange).toHaveBeenCalledWith("codex");
  });
});
