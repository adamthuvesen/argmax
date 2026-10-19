import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detachSidebarChat,
  resetSidebarChatNestingForTests,
  setSidebarChatsNested,
  SIDEBAR_CHAT_NESTING_STORAGE_KEY,
  useSidebarChatNesting
} from "./sidebarChatNesting.js";

beforeEach(() => {
  window.localStorage.removeItem(SIDEBAR_CHAT_NESTING_STORAGE_KEY);
  resetSidebarChatNestingForTests();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.removeItem(SIDEBAR_CHAT_NESTING_STORAGE_KEY);
  resetSidebarChatNestingForTests();
});

describe("sidebar chat nesting", () => {
  it("defaults to nested and keeps one stable snapshot until a choice changes", () => {
    const { result, rerender } = renderHook(useSidebarChatNesting);
    const initial = result.current;
    expect(initial.nested).toBe(true);
    expect(initial.detachedIds.size).toBe(0);
    rerender();
    expect(result.current).toBe(initial);
    act(() => setSidebarChatsNested(true));
    expect(result.current).toBe(initial);
  });

  it("publishes both preferences atomically and preserves detached chats across layout changes and reloads", () => {
    const { result } = renderHook(useSidebarChatNesting);
    act(() => detachSidebarChat("child"));
    expect(result.current.nested).toBe(true);
    expect([...result.current.detachedIds]).toEqual(["child"]);
    const detached = result.current;
    act(() => detachSidebarChat("child"));
    expect(result.current).toBe(detached);
    act(() => setSidebarChatsNested(false));
    expect(JSON.parse(window.localStorage.getItem(SIDEBAR_CHAT_NESTING_STORAGE_KEY)!)).toEqual({ nested: false, detachedIds: ["child"] });
    act(() => resetSidebarChatNestingForTests());
    expect(result.current.nested).toBe(false);
    expect(result.current.detachedIds.has("child")).toBe(true);
    act(() => setSidebarChatsNested(true));
    expect(result.current.detachedIds.has("child")).toBe(true);
  });

  it("rejects malformed stored preferences without coercing their values", () => {
    window.localStorage.setItem(SIDEBAR_CHAT_NESTING_STORAGE_KEY, JSON.stringify({ nested: "false", detachedIds: [42] }));
    const { result } = renderHook(useSidebarChatNesting);
    expect(result.current.nested).toBe(true);
    expect(result.current.detachedIds.size).toBe(0);
  });

  it("applies preferences for the current session when browser storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    const { result } = renderHook(useSidebarChatNesting);
    act(() => {
      setSidebarChatsNested(false);
      detachSidebarChat("child");
    });
    expect(result.current.nested).toBe(false);
    expect(result.current.detachedIds.has("child")).toBe(true);
  });
});
