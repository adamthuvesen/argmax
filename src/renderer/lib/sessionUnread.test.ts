// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetSessionUnreadForTests,
  SESSION_VIEWED_STORAGE_KEY,
  syncWorkspaceViewed,
  useUnreadWorkspaceIds,
  workspaceHasUnreadResponse
} from "./sessionUnread.js";

const earlier = "2026-05-12T15:54:00.000Z";
const later = "2026-05-12T16:10:00.000Z";

afterEach(() => {
  window.localStorage.removeItem(SESSION_VIEWED_STORAGE_KEY);
  resetSessionUnreadForTests();
});

describe("session unread stamps", () => {
  it("acknowledges only the observed activity of the open shared chat", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "argmax");
    const markWorkspacesViewed = vi.fn().mockResolvedValue([]);
    Object.defineProperty(window, "argmax", { configurable: true, value: { markWorkspacesViewed } });
    try {
      const working = new Set<string>();
      const { rerender, unmount } = renderHook(
        ({ lastViewedAt }) => useUnreadWorkspaceIds(
          [{ id: "w1", lastActivityAt: later, lastViewedAt }], "w1", working
        ),
        { initialProps: { lastViewedAt: earlier } }
      );
      expect(markWorkspacesViewed).toHaveBeenCalledExactlyOnceWith({
        workspaces: [{ workspaceId: "w1", observedActivityAt: later }]
      });
      await act(async () => { rerender({ lastViewedAt: later }); });
      expect(markWorkspacesViewed).toHaveBeenCalledTimes(1);
      unmount();
    } finally {
      if (descriptor) Object.defineProperty(window, "argmax", descriptor);
      else Reflect.deleteProperty(window, "argmax");
    }
  });

  it("uses shared host read state instead of stale device-local stamps", () => {
    syncWorkspaceViewed([{ id: "w1", lastActivityAt: earlier }], null);
    expect(workspaceHasUnreadResponse(
      { id: "w1", lastActivityAt: later, lastViewedAt: later },
      { selectedWorkspaceId: null, working: false }
    )).toBe(false);
    syncWorkspaceViewed([{ id: "w1", lastActivityAt: later }], "w1");
    expect(workspaceHasUnreadResponse(
      { id: "w1", lastActivityAt: later, lastViewedAt: earlier },
      { selectedWorkspaceId: null, working: false }
    )).toBe(true);
  });

  it("does not treat first sight as unread", () => {
    const workspace = { id: "w1", lastActivityAt: later };
    syncWorkspaceViewed([workspace], null);

    expect(
      workspaceHasUnreadResponse(workspace, { selectedWorkspaceId: null, working: false })
    ).toBe(false);
  });

  it("is unread once activity moves past the stamp", () => {
    const workspace = { id: "w1", lastActivityAt: earlier };
    syncWorkspaceViewed([workspace], null);

    expect(
      workspaceHasUnreadResponse(
        { id: "w1", lastActivityAt: later },
        { selectedWorkspaceId: null, working: false }
      )
    ).toBe(true);
  });

  it("is never unread while selected or working", () => {
    const workspace = { id: "w1", lastActivityAt: earlier };
    syncWorkspaceViewed([workspace], null);
    const next = { id: "w1", lastActivityAt: later };

    expect(
      workspaceHasUnreadResponse(next, { selectedWorkspaceId: "w1", working: false })
    ).toBe(false);
    expect(
      workspaceHasUnreadResponse(next, { selectedWorkspaceId: null, working: true })
    ).toBe(false);
  });

  it("clears unread by stamping the open chat to the activity it is showing", () => {
    const workspace = { id: "w1", lastActivityAt: earlier };
    syncWorkspaceViewed([workspace], null);
    const next = { id: "w1", lastActivityAt: later };
    syncWorkspaceViewed([next], "w1");

    expect(
      workspaceHasUnreadResponse(next, { selectedWorkspaceId: null, working: false })
    ).toBe(false);
  });

  it("lights up again after a later response once the chat is no longer open", () => {
    syncWorkspaceViewed([{ id: "w1", lastActivityAt: earlier }], "w1");
    syncWorkspaceViewed([{ id: "w1", lastActivityAt: earlier }], null);

    expect(
      workspaceHasUnreadResponse(
        { id: "w1", lastActivityAt: later },
        { selectedWorkspaceId: null, working: false }
      )
    ).toBe(true);
  });

  it("drops stamps for workspaces that left the snapshot", () => {
    syncWorkspaceViewed(
      [
        { id: "keep", lastActivityAt: earlier },
        { id: "gone", lastActivityAt: earlier }
      ],
      null
    );
    syncWorkspaceViewed([{ id: "keep", lastActivityAt: earlier }], null);

    const stored = JSON.parse(window.localStorage.getItem(SESSION_VIEWED_STORAGE_KEY) ?? "{}") as Record<
      string,
      string
    >;
    expect(stored).toEqual({ keep: earlier });
  });

  it("the hook reports unread after activity moves, then drops it when selected", () => {
    const none = new Set<string>();
    type Props = {
      workspaces: { id: string; lastActivityAt: string }[];
      selected: string | null;
    };
    const initial: Props = { workspaces: [{ id: "w1", lastActivityAt: earlier }], selected: null };
    const { result, rerender } = renderHook(
      (props: Props) => useUnreadWorkspaceIds(props.workspaces, props.selected, none),
      { initialProps: initial }
    );

    expect(result.current.has("w1")).toBe(false);

    act(() => {
      rerender({ workspaces: [{ id: "w1", lastActivityAt: later }], selected: null });
    });
    expect(result.current.has("w1")).toBe(true);

    act(() => {
      rerender({ workspaces: [{ id: "w1", lastActivityAt: later }], selected: "w1" });
    });
    expect(result.current.has("w1")).toBe(false);
  });
});
