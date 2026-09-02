import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getBrowserOwnerId,
  openInBrowserPanel,
  requestAgentBrowserOpen,
  resetBrowserSurfaceForTests,
  resetBrowserTabsForTests
} from "../lib/browserPanel.js";
import { useReviewState } from "./useReviewState.js";

/** Enough of the bridge for the hook's mount effect; no source is needed,
 *  because Browser mode has nothing to read from a workspace. */
function stubBridge(): void {
  Object.defineProperty(window, "argmax", {
    configurable: true,
    writable: true,
    value: {
      review: { listChangedFiles: vi.fn().mockResolvedValue([]), loadDiff: vi.fn().mockResolvedValue(null) },
      workspace: { listFiles: vi.fn().mockResolvedValue([]) }
    }
  });
}

function renderPanel(claimsBrowserRequests: boolean, sessionId?: string) {
  return renderHook(
    ({ claims }: { claims: boolean }) =>
      useReviewState(null, null, { claimsBrowserRequests: claims, sessionId }),
    { initialProps: { claims: claimsBrowserRequests } }
  );
}

describe("useReviewState — browser mode", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetBrowserSurfaceForTests();
    stubBridge();
  });

  afterEach(() => {
    cleanup();
    resetBrowserSurfaceForTests();
    resetBrowserTabsForTests();
    delete (window as unknown as { argmax?: unknown }).argmax;
  });

  it("shows a session's agent tab in that session's pane and nowhere else", () => {
    const mine = renderPanel(false, "session-a");
    const other = renderPanel(true, "session-b");
    const launcher = renderPanel(true);

    act(() => requestAgentBrowserOpen("session-a", "agent-1", "https://example.com"));

    expect(mine.result.current.mode).toBe("browser");
    expect(mine.result.current.isPanelOpen).toBe(true);
    expect(mine.result.current.browserOwner).toBe(true);
    expect(mine.result.current.browserRequest).toMatchObject({
      url: "https://example.com",
      tabId: "agent-1"
    });
    // Focus does not enter into it: the pane showing the session does.
    expect(other.result.current.mode).toBe("changes");
    expect(launcher.result.current.mode).toBe("changes");
  });

  it("does not replay an agent tab opened before the pane mounted", () => {
    act(() => requestAgentBrowserOpen("session-a", "agent-1", "https://example.com"));
    const late = renderPanel(false, "session-a");

    // The tab is in the strip either way; yanking a pane into Browser mode
    // when the reader arrives minutes later is not what they asked for.
    expect(late.result.current.mode).toBe("changes");
  });

  it("routes an open request to the panel taking them and leaves the other alone", () => {
    const claiming = renderPanel(true);
    const idle = renderPanel(false);

    act(() => openInBrowserPanel("https://argmax.dev"));

    expect(claiming.result.current.mode).toBe("browser");
    expect(claiming.result.current.isPanelOpen).toBe(true);
    expect(claiming.result.current.browserOwner).toBe(true);
    expect(claiming.result.current.browserRequest?.url).toBe("https://argmax.dev");
    expect(idle.result.current.mode).toBe("changes");
    expect(idle.result.current.browserOwner).toBe(false);
  });

  it("does not replay a request that landed while the panel was not taking them", () => {
    const panel = renderPanel(false);
    act(() => openInBrowserPanel("https://argmax.dev"));
    expect(panel.result.current.mode).toBe("changes");

    // Focus arriving later is not a request: clicking into a pane must not
    // pull up a page the reader asked for somewhere else.
    panel.rerender({ claims: true });
    expect(panel.result.current.mode).toBe("changes");
  });

  it("hands the surface to the second panel that enters Browser mode", () => {
    const first = renderPanel(true);
    const second = renderPanel(false);

    act(() => first.result.current.openBrowser());
    expect(first.result.current.browserOwner).toBe(true);

    act(() => second.result.current.openBrowser());
    expect(second.result.current.browserOwner).toBe(true);
    expect(first.result.current.browserOwner).toBe(false);
    // The demoted panel stays in Browser mode, showing the placeholder.
    expect(first.result.current.mode).toBe("browser");
  });

  it("lets a demoted panel take the surface back", () => {
    const first = renderPanel(true);
    const second = renderPanel(false);

    act(() => first.result.current.openBrowser());
    act(() => second.result.current.openBrowser());

    // "Show here" on the demoted panel: it is already in Browser mode with
    // the panel open, so nothing about its own state changes — the claim has
    // to happen on the call itself, not on a state transition.
    act(() => first.result.current.openBrowser());
    expect(first.result.current.browserOwner).toBe(true);
    expect(second.result.current.browserOwner).toBe(false);
  });

  it("releases the surface when the owner leaves Browser mode or unmounts", () => {
    const panel = renderPanel(true);

    act(() => panel.result.current.openBrowser());
    expect(getBrowserOwnerId()).not.toBeNull();

    act(() => panel.result.current.setMode("changes"));
    expect(getBrowserOwnerId()).toBeNull();

    act(() => panel.result.current.openBrowser());
    act(() => panel.result.current.closePanel());
    expect(getBrowserOwnerId()).toBeNull();

    act(() => panel.result.current.openBrowser());
    panel.unmount();
    expect(getBrowserOwnerId()).toBeNull();
  });

  it("re-navigates when the same URL is requested twice", () => {
    const panel = renderPanel(true);

    act(() => openInBrowserPanel("https://argmax.dev"));
    const first = panel.result.current.browserRequest;
    act(() => openInBrowserPanel("https://argmax.dev"));
    const second = panel.result.current.browserRequest;

    expect(second?.url).toBe(first?.url);
    expect(second?.seq).toBeGreaterThan(first?.seq ?? 0);
  });
});
