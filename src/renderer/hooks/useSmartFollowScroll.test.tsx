import { act, cleanup, renderHook } from "@testing-library/react";
import { type MutableRefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSmartFollowScroll } from "./useSmartFollowScroll.js";

type ScrollBoxState = {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
};

type ObserverEntry = {
  callback: ResizeObserverCallback;
  targets: Element[];
};

function attachListRef(
  ref: { current: HTMLDivElement | null },
  el: HTMLDivElement
): void {
  (ref as MutableRefObject<HTMLDivElement | null>).current = el;
}

function makeScrollBox(state: ScrollBoxState): HTMLDivElement {
  const el = document.createElement("div");
  const clampTop = (value: number): number =>
    Math.max(0, Math.min(value, Math.max(0, state.scrollHeight - state.clientHeight)));

  Object.defineProperties(el, {
    scrollHeight: {
      configurable: true,
      get: () => state.scrollHeight
    },
    clientHeight: {
      configurable: true,
      get: () => state.clientHeight
    },
    scrollTop: {
      configurable: true,
      get: () => state.scrollTop,
      set: (value: number) => {
        state.scrollTop = clampTop(value);
      }
    }
  });

  return el;
}

function installResizeObservers(): ObserverEntry[] {
  const observers: ObserverEntry[] = [];
  class StubResizeObserver implements ResizeObserver {
    private readonly entry: ObserverEntry;

    constructor(callback: ResizeObserverCallback) {
      this.entry = { callback, targets: [] };
      observers.push(this.entry);
    }

    observe = (target: Element): void => {
      this.entry.targets.push(target);
    };

    unobserve = vi.fn();
    disconnect = vi.fn();
  }
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  return observers;
}

describe("useSmartFollowScroll", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("pins a large completed chunk to the exact bottom before paint", () => {
    const state: ScrollBoxState = { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 };
    const el = makeScrollBox(state);
    const { result, rerender } = renderHook(
      ({ items }: { items: readonly string[] }) =>
        useSmartFollowScroll("session-a", items, false),
      { initialProps: { items: ["first"] } }
    );
    attachListRef(result.current.conversationListRef, el);

    act(() => {
      state.scrollHeight = 6000;
      rerender({ items: ["first", "large-completed-chunk"] });
    });

    expect(state.scrollTop).toBe(5800);
  });

  it("keeps following after downward input cannot move the pinned viewport", () => {
    const state: ScrollBoxState = { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 };
    const el = makeScrollBox(state);
    const { result, rerender } = renderHook(
      ({ items }: { items: readonly string[] }) =>
        useSmartFollowScroll("session-a", items, false),
      { initialProps: { items: ["streaming-turn"] } }
    );
    attachListRef(result.current.conversationListRef, el);

    act(() => {
      result.current.handleUserScrollIntent();
      state.scrollHeight = 1100;
      rerender({ items: ["streaming-turn", "final-growth"] });
    });

    expect(state.scrollTop).toBe(900);
    expect(result.current.showScrollToBottom).toBe(false);
  });

  it("detaches only after user intent produces real movement away", () => {
    const state: ScrollBoxState = { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 };
    const el = makeScrollBox(state);
    const { result, rerender } = renderHook(
      ({ items }: { items: readonly string[] }) =>
        useSmartFollowScroll("session-a", items, false),
      { initialProps: { items: ["first"] } }
    );
    attachListRef(result.current.conversationListRef, el);

    act(() => {
      result.current.handleUserScrollIntent();
      state.scrollTop = 500;
      result.current.handleScroll();
    });

    expect(result.current.showScrollToBottom).toBe(true);

    act(() => {
      state.scrollHeight = 1300;
      rerender({ items: ["first", "second"] });
    });

    expect(state.scrollTop).toBe(500);
  });

  it("corrects browser-driven movement when no user gesture occurred", () => {
    const state: ScrollBoxState = { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 };
    const el = makeScrollBox(state);
    const { result } = renderHook(() => useSmartFollowScroll("session-a", ["turn"], false));
    attachListRef(result.current.conversationListRef, el);

    act(() => {
      state.scrollTop = 500;
      result.current.handleScroll();
    });

    expect(state.scrollTop).toBe(800);
    expect(result.current.showScrollToBottom).toBe(false);
  });

  it("detaches on the first small upward gesture near the bottom", () => {
    const observers = installResizeObservers();
    const state: ScrollBoxState = { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 };
    const el = makeScrollBox(state);
    const turn = document.createElement("article");
    el.appendChild(turn);
    const { result, rerender } = renderHook(
      ({ items }: { items: readonly string[] }) => {
        const api = useSmartFollowScroll("session-a", items, false);
        attachListRef(api.conversationListRef, el);
        return api;
      },
      { initialProps: { items: ["turn"] } }
    );
    const childObserver = observers.find((observer) => observer.targets.includes(turn));

    act(() => {
      result.current.handleUserScrollIntent();
      state.scrollTop = 799.75;
      result.current.handleScroll();
    });

    expect(state.scrollTop).toBe(799.75);
    expect(result.current.showScrollToBottom).toBe(false);

    act(() => {
      // A smooth scroll, scrollbar drag, or selection autoscroll can emit
      // several events after only one initial intent signal.
      state.scrollTop = 799.5;
      result.current.handleScroll();
      state.scrollHeight = 1010;
      childObserver?.callback([], {} as ResizeObserver);
    });

    expect(state.scrollTop).toBe(799.5);

    act(() => {
      state.scrollHeight = 1100;
      rerender({ items: ["turn", "new-output"] });
    });

    expect(state.scrollTop).toBe(799.5);
  });

  it("detaches when streamed growth lands between the gesture and its scroll event", () => {
    const state: ScrollBoxState = { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 };
    const el = makeScrollBox(state);
    const { result, rerender } = renderHook(
      ({ items }: { items: readonly string[] }) =>
        useSmartFollowScroll("session-a", items, false),
      { initialProps: { items: ["turn"] } }
    );
    attachListRef(result.current.conversationListRef, el);

    act(() => {
      result.current.handleUserScrollIntent();
      state.scrollHeight = 1100;
      rerender({ items: ["turn", "streamed-chunk"] });
    });
    expect(state.scrollTop).toBe(900);

    act(() => {
      state.scrollTop = 860;
      result.current.handleScroll();
    });

    expect(state.scrollTop).toBe(860);
    expect(result.current.showScrollToBottom).toBe(false);
  });

  it("keeps a sub-pixel gesture alive through a reconcile that writes nothing", () => {
    const observers = installResizeObservers();
    const state: ScrollBoxState = { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 };
    const el = makeScrollBox(state);
    const turn = document.createElement("article");
    el.appendChild(turn);
    const { result } = renderHook(() => {
      const api = useSmartFollowScroll("session-a", ["turn"], false);
      attachListRef(api.conversationListRef, el);
      return api;
    });
    const childObserver = observers.find((observer) => observer.targets.includes(turn));

    act(() => {
      result.current.handleUserScrollIntent();
      state.scrollTop = 799.75;
      // Within the write tolerance, so this pass leaves the viewport alone and
      // has no movement of its own to rebase the gesture against.
      childObserver?.callback([], {} as ResizeObserver);
      result.current.handleScroll();
    });

    expect(state.scrollTop).toBe(799.75);

    act(() => {
      state.scrollHeight = 1200;
      childObserver?.callback([], {} as ResizeObserver);
    });

    expect(state.scrollTop).toBe(799.75);
    expect(result.current.showScrollToBottom).toBe(true);
  });

  it("resumes following when the reader clicks scroll to latest", () => {
    const state: ScrollBoxState = { scrollHeight: 1200, clientHeight: 200, scrollTop: 1000 };
    const el = makeScrollBox(state);
    const { result, rerender } = renderHook(
      ({ items }: { items: readonly string[] }) =>
        useSmartFollowScroll("session-a", items, false),
      { initialProps: { items: ["first"] } }
    );
    attachListRef(result.current.conversationListRef, el);

    act(() => {
      result.current.handleUserScrollIntent();
      state.scrollTop = 700;
      result.current.handleScroll();
    });
    expect(result.current.showScrollToBottom).toBe(true);

    act(() => {
      result.current.scrollToBottom();
    });
    expect(state.scrollTop).toBe(1000);

    act(() => {
      state.scrollHeight = 1400;
      rerender({ items: ["first", "second"] });
    });
    expect(state.scrollTop).toBe(1200);
  });

  it("keeps following when the composer shrinks the viewport", () => {
    const observers = installResizeObservers();
    const state: ScrollBoxState = { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 };
    const el = makeScrollBox(state);
    el.appendChild(document.createElement("article"));
    const composer = document.createElement("textarea");
    const composerRef = { current: composer };

    renderHook(() => {
      const api = useSmartFollowScroll("session-a", ["turn"], false, composerRef);
      attachListRef(api.conversationListRef, el);
      return api;
    });

    const viewport = observers.find((observer) => observer.targets.includes(el));
    expect(viewport?.targets).toContain(composer);

    act(() => {
      state.clientHeight = 240;
      viewport?.callback([], {} as ResizeObserver);
    });

    expect(state.scrollTop).toBe(760);
  });

  it("follows streamed growth inside an existing conversation item", () => {
    const observers = installResizeObservers();
    const state: ScrollBoxState = { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 };
    const el = makeScrollBox(state);
    const turn = document.createElement("article");
    el.appendChild(turn);

    renderHook(() => {
      const api = useSmartFollowScroll("session-a", ["streaming-turn"], false);
      attachListRef(api.conversationListRef, el);
      return api;
    });

    const childObserver = observers.find((observer) => observer.targets.includes(turn));
    expect(childObserver).toBeDefined();

    act(() => {
      state.scrollHeight = 1140;
      childObserver?.callback([], {} as ResizeObserver);
    });

    expect(state.scrollTop).toBe(940);
  });

  it("does not move detached history when an existing item grows", () => {
    const observers = installResizeObservers();
    const state: ScrollBoxState = { scrollHeight: 1200, clientHeight: 200, scrollTop: 1000 };
    const el = makeScrollBox(state);
    const turn = document.createElement("article");
    el.appendChild(turn);
    const { result } = renderHook(() => {
      const api = useSmartFollowScroll("session-a", ["turn"], false);
      attachListRef(api.conversationListRef, el);
      return api;
    });
    const childObserver = observers.find((observer) => observer.targets.includes(turn));

    act(() => {
      result.current.handleUserScrollIntent();
      state.scrollTop = 600;
      result.current.handleScroll();
      state.scrollHeight = 1400;
      childObserver?.callback([], {} as ResizeObserver);
    });

    expect(state.scrollTop).toBe(600);
    expect(result.current.showScrollToBottom).toBe(true);
  });

  it("re-attaches when collapsing content brings the bottom into view", () => {
    const observers = installResizeObservers();
    const state: ScrollBoxState = { scrollHeight: 1400, clientHeight: 200, scrollTop: 1200 };
    const el = makeScrollBox(state);
    const turn = document.createElement("article");
    el.appendChild(turn);
    const { result } = renderHook(() => {
      const api = useSmartFollowScroll("session-a", ["turn"], false);
      attachListRef(api.conversationListRef, el);
      return api;
    });
    const childObserver = observers.find((observer) => observer.targets.includes(turn));

    act(() => {
      result.current.handleUserScrollIntent();
      state.scrollTop = 900;
      result.current.handleScroll();
    });
    expect(result.current.showScrollToBottom).toBe(true);

    act(() => {
      state.scrollHeight = 1100;
      childObserver?.callback([], {} as ResizeObserver);
    });

    expect(state.scrollTop).toBe(900);
    expect(result.current.showScrollToBottom).toBe(false);
  });

  it("snaps an asynchronously loaded first transcript batch to the bottom", () => {
    const state: ScrollBoxState = { scrollHeight: 200, clientHeight: 200, scrollTop: 0 };
    const el = makeScrollBox(state);
    const { result, rerender } = renderHook(
      ({ items }: { items: readonly string[] }) =>
        useSmartFollowScroll("session-a", items, false),
      { initialProps: { items: [] as readonly string[] } }
    );
    attachListRef(result.current.conversationListRef, el);

    act(() => {
      state.scrollHeight = 3000;
      rerender({ items: ["loaded-history"] });
    });

    expect(state.scrollTop).toBe(2800);
  });

  it("snaps the next session to its latest content", () => {
    const state: ScrollBoxState = { scrollHeight: 1200, clientHeight: 200, scrollTop: 1000 };
    const el = makeScrollBox(state);
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) =>
        useSmartFollowScroll(sessionId, ["turn"], false),
      { initialProps: { sessionId: "session-a" } }
    );
    attachListRef(result.current.conversationListRef, el);

    act(() => {
      result.current.handleUserScrollIntent();
      state.scrollTop = 600;
      result.current.handleScroll();
      state.scrollHeight = 2200;
      rerender({ sessionId: "session-b" });
    });

    expect(state.scrollTop).toBe(2000);
    expect(result.current.showScrollToBottom).toBe(false);
  });

  it("sizes the leftover-viewport spacer from the latest user message through the tail", () => {
    const state: ScrollBoxState = { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 };
    const el = makeScrollBox(state);
    const user = document.createElement("div");
    user.setAttribute("data-turn-anchor", "true");
    Object.defineProperty(user, "offsetTop", { configurable: true, get: () => 5000 });
    Object.defineProperty(user, "offsetHeight", { configurable: true, get: () => 80 });
    const tail = document.createElement("div");
    tail.className = "conversation-tail";
    Object.defineProperty(tail, "offsetTop", { configurable: true, get: () => 5080 });
    Object.defineProperty(tail, "offsetHeight", { configurable: true, get: () => 20 });
    const spacer = document.createElement("div");
    spacer.setAttribute("data-conversation-spacer", "");
    el.append(user, tail, spacer);

    const originalGetComputedStyle = window.getComputedStyle.bind(window);
    const styleSpy = vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
      if (element === el) {
        return { paddingTop: "32px", paddingBottom: "32px" } as CSSStyleDeclaration;
      }
      return originalGetComputedStyle(element);
    });

    const { result, rerender } = renderHook(
      ({ items }: { items: readonly string[] }) =>
        useSmartFollowScroll("session-a", items, false, undefined, "u1"),
      { initialProps: { items: ["turn"] } }
    );
    attachListRef(result.current.conversationListRef, el);

    act(() => {
      rerender({ items: ["turn", "follow-up"] });
    });

    // 200px pane - 32px fades - 100px from user message through the tail.
    expect(spacer.style.height).toBe("36px");
    styleSpy.mockRestore();
  });

  it("reattaches when a new user message arrives", () => {
    const state: ScrollBoxState = { scrollHeight: 1200, clientHeight: 200, scrollTop: 1000 };
    const el = makeScrollBox(state);
    const { result, rerender } = renderHook(
      ({ lastUserMessageId }: { lastUserMessageId: string }) =>
        useSmartFollowScroll("session-a", ["turn"], false, undefined, lastUserMessageId),
      { initialProps: { lastUserMessageId: "u1" } }
    );
    attachListRef(result.current.conversationListRef, el);

    act(() => {
      result.current.handleUserScrollIntent();
      state.scrollTop = 600;
      result.current.handleScroll();
    });
    expect(result.current.showScrollToBottom).toBe(true);

    act(() => {
      state.scrollHeight = 1400;
      rerender({ lastUserMessageId: "u2" });
    });

    expect(state.scrollTop).toBe(1200);
    expect(result.current.showScrollToBottom).toBe(false);
  });
});
