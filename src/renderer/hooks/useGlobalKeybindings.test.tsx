import { cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetChatCycle } from "../lib/chatCycle.js";
import { useGlobalKeybindings } from "./useGlobalKeybindings.js";

describe("useGlobalKeybindings", () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  beforeEach(() => {
    // Chat recency is module state; without this it leaks between cases.
    resetChatCycle();
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

  // The recency order itself is covered in lib/chatCycle.test.ts. This is the
  // wiring: that the chord steps at all on either Mac keyboard — ⌘§ sends
  // `IntlBackslash` on an ISO one, ⌘` sends `Backquote` on an ANSI one — that
  // Shift reverses it, and that releasing Cmd ends a held traversal.
  it("cycles chats on Cmd and the key under Esc, ending the traversal when Cmd comes up", () => {
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

    // Nothing selected (launcher) and nothing used yet: forward lands on the
    // first row, back on the last.
    fireEvent.keyDown(document, { key: "§", code: "IntlBackslash", metaKey: true });
    expect(onSelectWorkspace).toHaveBeenLastCalledWith("workspace-1");
    fireEvent.keyDown(document, { key: "°", code: "IntlBackslash", metaKey: true, shiftKey: true });
    expect(onSelectWorkspace).toHaveBeenLastCalledWith("workspace-3");
    expect(onCloseSettings).toHaveBeenCalledTimes(2);

    // Releasing Cmd promotes workspace-3, so the next press toggles back to
    // the row the traversal started from rather than stepping on to the next.
    fireEvent.keyUp(document, { key: "Meta" });
    const rows = document.querySelectorAll(".session-row");
    rows[2].innerHTML = '<a aria-current="true"></a>';
    fireEvent.keyDown(document, { key: "`", code: "Backquote", metaKey: true });
    expect(onSelectWorkspace).toHaveBeenLastCalledWith("workspace-1");
  });

  it("leaves Cmd+Backquote to the native menu when the sidebar is empty", () => {
    const onSelectWorkspace = vi.fn();
    document.body.innerHTML = '<div class="project-list"></div>';
    renderHook(() =>
      useGlobalKeybindings({
        onMenuCommand: vi.fn(),
        onOpenFilePalette: vi.fn(),
        onOpenSearch: vi.fn(),
        onOpenContentSearch: vi.fn(),
        onSelectWorkspace,
        onCloseSettings: vi.fn()
      })
    );

    const event = new KeyboardEvent("keydown", {
      key: "§",
      code: "Backquote",
      metaKey: true,
      cancelable: true,
      bubbles: true
    });
    document.dispatchEvent(event);
    expect(onSelectWorkspace).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
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
