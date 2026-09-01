import { cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGlobalKeybindings } from "./useGlobalKeybindings.js";

describe("useGlobalKeybindings", () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  beforeEach(() => {
    document.body.innerHTML = `
      <div class="project-list">
        <div class="session-row" data-workspace-id="workspace-1"></div>
        <div class="session-row" data-workspace-id="workspace-2"></div>
        <div class="session-row" data-workspace-id="workspace-3"></div>
      </div>
    `;
  });

  it("selects the nth workspace on Cmd+1..9 even when typing in a textarea", () => {
    const onSelectWorkspace = vi.fn();
    const onCloseSettings = vi.fn();
    const onMenuCommand = vi.fn();

    renderHook(() =>
      useGlobalKeybindings({
        onMenuCommand,
        onOpenFilePalette: vi.fn(),
        onOpenSearch: vi.fn(),
        onOpenContentSearch: vi.fn(),
        onSelectWorkspace,
        onCloseSettings
      })
    );

    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    textarea.focus();

    fireEvent.keyDown(textarea, { key: "2", metaKey: true });
    expect(onCloseSettings).toHaveBeenCalledTimes(1);
    expect(onSelectWorkspace).toHaveBeenCalledWith("workspace-2");

    fireEvent.keyDown(textarea, { key: "1", metaKey: true });
    expect(onCloseSettings).toHaveBeenCalledTimes(2);
    expect(onSelectWorkspace).toHaveBeenCalledWith("workspace-1");
  });

  it("resolves digit shortcuts from event.code fallback (Digit1..9 / Numpad1..9)", () => {
    const onSelectWorkspace = vi.fn();
    const onCloseSettings = vi.fn();

    renderHook(() =>
      useGlobalKeybindings({
        onMenuCommand: vi.fn(),
        onOpenFilePalette: vi.fn(),
        onOpenSearch: vi.fn(),
        onOpenContentSearch: vi.fn(),
        onSelectWorkspace,
        onCloseSettings
      })
    );

    // On non-US keyboards, key might be '&' but code is 'Digit1'
    fireEvent.keyDown(document, { key: "&", code: "Digit1", metaKey: true });
    expect(onSelectWorkspace).toHaveBeenCalledWith("workspace-1");

    // Numpad key
    fireEvent.keyDown(document, { key: "Unidentified", code: "Numpad3", metaKey: true });
    expect(onSelectWorkspace).toHaveBeenCalledWith("workspace-3");
  });

  it("ignores digit shortcuts during IME composition or with Alt key", () => {
    const onSelectWorkspace = vi.fn();
    const onCloseSettings = vi.fn();

    renderHook(() =>
      useGlobalKeybindings({
        onMenuCommand: vi.fn(),
        onOpenFilePalette: vi.fn(),
        onOpenSearch: vi.fn(),
        onOpenContentSearch: vi.fn(),
        onSelectWorkspace,
        onCloseSettings
      })
    );

    fireEvent.keyDown(document, { key: "1", metaKey: true, isComposing: true });
    expect(onSelectWorkspace).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: "1", metaKey: true, altKey: true });
    expect(onSelectWorkspace).not.toHaveBeenCalled();
  });

  it("fires search and cheat sheet shortcuts even when a text input is focused", () => {
    const onMenuCommand = vi.fn();
    const onOpenSearch = vi.fn();
    const onOpenContentSearch = vi.fn();

    renderHook(() =>
      useGlobalKeybindings({
        onMenuCommand,
        onOpenFilePalette: vi.fn(),
        onOpenSearch,
        onOpenContentSearch,
        onSelectWorkspace: vi.fn(),
        onCloseSettings: vi.fn()
      })
    );

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    fireEvent.keyDown(input, { key: "/", metaKey: true });
    expect(onMenuCommand).toHaveBeenCalledWith("open-cheat-sheet");

    fireEvent.keyDown(input, { key: "f", metaKey: true });
    expect(onOpenSearch).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(input, { key: "F", metaKey: true, shiftKey: true });
    expect(onOpenContentSearch).toHaveBeenCalledTimes(1);
  });
});
