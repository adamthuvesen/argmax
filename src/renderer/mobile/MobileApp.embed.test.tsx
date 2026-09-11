import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteConnectionState } from "../lib/wsTransport.js";
import { ACCENT_STORAGE_KEY, DEFAULT_ACCENT_ID } from "../lib/accent.js";
import { CHAT_FONT_SIZE_STORAGE_KEY, FONT_SIZE_STORAGE_KEY } from "../lib/fonts.js";
import { THEME_STORAGE_KEY } from "../lib/theme.js";
import {
  DEFAULT_USER_BUBBLE_TINT,
  USER_BUBBLE_TINT_STORAGE_KEY
} from "../lib/userBubbleTint.js";
import { mockDashboardSnapshot, setupAppTestMocks, snapshot } from "../../test/appTestHarness.js";
import { startedAgentName } from "../../test/agentRowName.js";
import { MobileApp } from "./MobileApp.js";
import type { NativeMessage } from "./nativeHost.js";

// Embed mode: the page runs inside the iPhone app's web view, which owns the
// chat list, the header and the navigation stack. These cover the web half of
// the contract in nativeHost.ts — the Swift half mirrors it.

// Same shape as MobileApp.test.tsx: the transport is a page singleton the
// component only observes, so the test drives its state rather than a socket.
const remote = vi.hoisted(() => {
  const listeners = new Set<(state: RemoteConnectionState) => void>();
  let state: RemoteConnectionState = { status: "connected", resync: false };
  return {
    reset: () => {
      listeners.clear();
      state = { status: "connected", resync: false };
    },
    publish: (next: RemoteConnectionState) => {
      state = next;
      for (const listener of [...listeners]) listener(next);
    },
    subscribe: (listener: (next: RemoteConnectionState) => void) => {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    }
  };
});

vi.mock("../lib/wsTransport.js", () => ({
  createWsTransport: vi.fn(),
  subscribeRemoteConnection: remote.subscribe
}));

const postMessage = vi.fn<(message: NativeMessage) => void>();

/** What the page has told native so far, of one kind. */
function posted<T extends NativeMessage["type"]>(
  type: T
): Extract<NativeMessage, { type: T }>[] {
  return postMessage.mock.calls
    .map(([message]) => message)
    .filter((message): message is Extract<NativeMessage, { type: T }> => message.type === type);
}

function visit(url: string): void {
  window.history.replaceState(null, "", url);
}

async function renderEmbedded(url = "/mobile.html?embed=1"): Promise<void> {
  visit(url);
  render(<MobileApp />);
  // installNativeApi runs in a mount effect; nothing native can call before it.
  await waitFor(() => expect(window.argmaxNative).toBeDefined());
}

describe("MobileApp embed mode", () => {
  beforeEach(() => {
    remote.reset();
    postMessage.mockClear();
    window.webkit = { messageHandlers: { argmax: { postMessage } } };
    setupAppTestMocks();
  });

  afterEach(() => {
    cleanup();
    delete window.webkit;
    visit("/mobile.html");
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-accent");
    document.documentElement.removeAttribute("data-user-bubble");
  });

  it("renders no chat list and no new-chat affordance", async () => {
    await renderEmbedded();

    expect(screen.queryByRole("region", { name: "Chat list" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New chat" })).not.toBeInTheDocument();
    // Parked until native says which chat to show.
    expect(screen.queryByRole("region", { name: "Conversation" })).not.toBeInTheDocument();
  });

  it("posts ready once the bridge authenticates, and only once", async () => {
    remote.publish({ status: "connecting", resync: false });
    await renderEmbedded();

    expect(posted("ready")).toHaveLength(0);

    act(() => remote.publish({ status: "connected", resync: false }));
    await waitFor(() => expect(posted("ready")).toHaveLength(1));

    // A reconnect is not a fresh page: native has already called in.
    act(() => remote.publish({ status: "offline", resync: false }));
    act(() => remote.publish({ status: "connected", resync: true }));
    expect(posted("ready")).toHaveLength(1);
  });

  it("switches the transcript in place on openSession and reports it", async () => {
    await renderEmbedded();

    act(() => window.argmaxNative?.openSession("session-1"));

    expect(await screen.findByRole("region", { name: "Conversation" })).toBeInTheDocument();
    await waitFor(() =>
      expect(posted("session")).toContainEqual({
        type: "session",
        sessionId: "session-1",
        title: "Build dashboard",
        state: "running",
        attention: "normal"
      })
    );
  });

  // The native composer draws its model chip, effort dial and queued stack
  // from this rather than re-deriving the composer's own rules.
  it("reports the composer's own state on open, for the native card to draw", async () => {
    await renderEmbedded();

    act(() => window.argmaxNative?.openSession("session-1"));

    await waitFor(() =>
      expect(posted("composer")).toContainEqual({
        type: "composer",
        sessionId: "session-1",
        provider: "codex",
        modelId: "gpt-5.6-terra",
        modelLabel: "GPT-5.6 Terra",
        effort: "medium",
        efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        queued: [],
        running: true
      })
    );
  });

  it("hides its own composer stack once native says it is drawing the card", async () => {
    await renderEmbedded();
    act(() => window.argmaxNative?.openSession("session-1"));
    await screen.findByRole("region", { name: "Conversation" });

    const shell = () => document.querySelector(".mobile-shell");
    expect(shell()?.getAttribute("data-composer-hidden")).toBeNull();

    act(() => window.argmaxNative?.setComposer(true));
    expect(shell()?.getAttribute("data-composer-hidden")).toBe("true");

    act(() => window.argmaxNative?.setComposer(false));
    expect(shell()?.getAttribute("data-composer-hidden")).toBeNull();
  });

  it("reads the transcript one type step up, without touching the stored preference", async () => {
    await renderEmbedded();
    act(() => window.argmaxNative?.openSession("session-1"));

    const shell = (await screen.findByRole("region", { name: "Conversation" })).closest(
      "[data-font-size]"
    );
    // One above the 7 the web phone runs a transcript at: inside the shell
    // the transcript is the whole screen. See MobileApp.
    expect(shell?.getAttribute("data-font-size")).toBe("9");
    // The step is the shell's, for this page only. The phone's own browser
    // tab keeps whatever it was set to.
    expect(window.localStorage.getItem(FONT_SIZE_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(CHAT_FONT_SIZE_STORAGE_KEY)).toBeNull();
  });

  // A chat the native shell has just started exists on the Mac before the
  // delta carrying its row reaches this page. Dropping the link on that first
  // miss left the reader on a blank pane under the previous chat's title.
  it("re-reads for a chat the loaded snapshot has not caught up with", async () => {
    mockDashboardSnapshot({
      ...snapshot,
      sessions: snapshot.sessions.filter((session) => session.id !== "session-1")
    });
    await renderEmbedded();

    // The Mac has it now; this page's snapshot is the one from a moment ago.
    mockDashboardSnapshot(snapshot);
    act(() => window.argmaxNative?.openSession("session-1"));

    expect(await screen.findByRole("region", { name: "Conversation" })).toBeInTheDocument();
    await waitFor(() =>
      expect(posted("session")).toContainEqual({
        type: "session",
        sessionId: "session-1",
        title: "Build dashboard",
        state: "running",
        attention: "normal"
      })
    );
  });

  it("parks the pane on closeSession", async () => {
    await renderEmbedded();
    act(() => window.argmaxNative?.openSession("session-1"));
    await screen.findByRole("region", { name: "Conversation" });

    act(() => window.argmaxNative?.closeSession());

    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Conversation" })).not.toBeInTheDocument()
    );
  });

  it("opens the review screen on openReview", async () => {
    await renderEmbedded();
    act(() => window.argmaxNative?.openSession("session-1"));
    await screen.findByRole("region", { name: "Conversation" });

    // The native trailing menu's "Changes": the shell has no review screen
    // of its own, so it asks the page for the one it already has.
    act(() => window.argmaxNative?.openReview());

    await waitFor(() => expect(posted("review")).toEqual([{ type: "review", open: true }]));
  });

  it("asks native to stand its composer down while the peek is up", async () => {
    // The peek is a bottom sheet drawn to cover the parent's composer. In the
    // shell that composer is native chrome the sheet cannot reach over, so it
    // only reaches the bottom of the screen if native drops its card first.
    mockDashboardSnapshot({
      ...snapshot,
      events: [
        ...snapshot.events,
        {
          id: "event-agent-start",
          sessionId: "session-1",
          type: "command.started",
          message: "Task",
          payload: {
            id: "tu_agent",
            name: "Task",
            input: { description: "Audit the dashboard query", prompt: "Read it and report back." }
          },
          createdAt: "2026-05-08T15:54:01.000Z"
        },
        {
          id: "event-agent-done",
          sessionId: "session-1",
          type: "command.completed",
          message: "tool_result",
          payload: { tool_use_id: "tu_agent", content: "No issues found." },
          createdAt: "2026-05-08T15:54:02.000Z"
        }
      ]
    });
    await renderEmbedded();
    act(() => window.argmaxNative?.openSession("session-1"));
    await screen.findByRole("region", { name: "Conversation" });

    fireEvent.click(
      await screen.findByRole("button", { name: startedAgentName("Audit the dashboard query") })
    );
    await screen.findByRole("dialog", { name: "Delegated work" });
    await waitFor(() => expect(posted("agents")).toEqual([{ type: "agents", open: true }]));

    fireEvent.click(screen.getByRole("button", { name: "Close Delegated work" }));

    await waitFor(() =>
      expect(posted("agents")).toEqual([
        { type: "agents", open: true },
        { type: "agents", open: false }
      ])
    );
  });

  it("asks native to leave the chat on Escape", async () => {
    await renderEmbedded();
    act(() => window.argmaxNative?.openSession("session-1"));
    await screen.findByRole("region", { name: "Conversation" });

    fireEvent.keyDown(window, { key: "Escape" });

    expect(posted("back")).toHaveLength(1);
  });

  it("applies theme, accent and bubble tint for the page lifetime without storing them", async () => {
    await renderEmbedded();

    act(() => window.argmaxNative?.setTheme("light"));
    act(() => window.argmaxNative?.setAccent("orange"));
    // The bubbles are drawn here, but the setting is the shell's — Settings →
    // Appearance on the phone, not this page's own menu.
    act(() => window.argmaxNative?.setUserBubble("neutral"));

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.accent).toBe("orange");
    expect(document.documentElement.dataset.userBubble).toBe("neutral");
    // The phone's own browser tab keeps the preferences it had.
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(ACCENT_STORAGE_KEY)).toBe(DEFAULT_ACCENT_ID);
    expect(window.localStorage.getItem(USER_BUBBLE_TINT_STORAGE_KEY)).toBe(DEFAULT_USER_BUBBLE_TINT);
  });

  it("ignores a bubble tint the page does not know", async () => {
    await renderEmbedded();
    act(() => window.argmaxNative?.setUserBubble("neutral"));

    act(() => (window.argmaxNative as { setUserBubble: (value: string) => void }).setUserBubble("puce"));

    expect(document.documentElement.dataset.userBubble).toBe("neutral");
  });

  // On the phone the composer's effort control is a dial across the whole
  // composer (mobile.css), and the thumb dragging it covers the label it is
  // moving to. Each snap is felt instead.
  it("beats a light haptic on every snap of the effort dial", async () => {
    await renderEmbedded();
    act(() => window.argmaxNative?.openSession("session-1"));
    await screen.findByRole("region", { name: "Conversation" });

    fireEvent.click(screen.getByRole("button", { name: "Chat model effort" }));
    const dial = screen.getByRole("dialog", { name: "Chat model effort" });
    expect(posted("haptic")).toHaveLength(0);

    fireEvent.click(within(dial).getByRole("button", { name: "Set effort to High" }));
    expect(posted("haptic")).toEqual([{ type: "haptic", kind: "light" }]);

    // A tap that lands on the stop it is already on has not moved anything.
    fireEvent.click(within(dial).getByRole("button", { name: "Set effort to High" }));
    expect(posted("haptic")).toHaveLength(1);

    // Every stop crossed, not one per gesture.
    const rail = within(dial).getByRole("slider", { name: "Reasoning effort" });
    fireEvent.keyDown(rail, { key: "ArrowRight" });
    fireEvent.keyDown(rail, { key: "ArrowRight" });
    expect(posted("haptic")).toHaveLength(3);
  });

  it("keeps embed=1 in the address bar while consuming ?session=", async () => {
    await renderEmbedded("/mobile.html?embed=1&session=session-1");

    expect(await screen.findByRole("region", { name: "Conversation" })).toBeInTheDocument();
    // importChunk reloads this URL when a chunk hash goes missing; the reload
    // has to come back embedded, so only the one-shot session id is scrubbed.
    expect(window.location.search).toBe("?embed=1");
  });

  it("leaves the browser page alone without embed=1", async () => {
    visit("/mobile.html");
    render(<MobileApp />);

    expect(await screen.findByRole("region", { name: "Chat list" })).toBeInTheDocument();
    expect(window.argmaxNative).toBeUndefined();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(postMessage).not.toHaveBeenCalled();
  });
});
