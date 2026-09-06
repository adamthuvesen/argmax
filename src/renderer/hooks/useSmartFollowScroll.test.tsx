import { act, cleanup, renderHook } from "@testing-library/react";
import { type MutableRefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSmartFollowScroll } from "./useSmartFollowScroll.js";

type ScrollBoxState = {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  /** When set, `scrollHeight` and the scrollTop clamp read this instead. */
  scrollHeightOf?: () => number;
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
  const scrollHeightOf = (): number => state.scrollHeightOf?.() ?? state.scrollHeight;
  const clampTop = (value: number): number =>
    Math.max(0, Math.min(value, Math.max(0, scrollHeightOf() - state.clientHeight)));

  Object.defineProperties(el, {
    scrollHeight: {
      configurable: true,
      get: () => scrollHeightOf()
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

  it("resumes following when the reader scrolls back to the physical bottom", () => {
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
      state.scrollTop = 1000;
      result.current.handleScroll();
    });
    expect(result.current.showScrollToBottom).toBe(false);

    act(() => {
      state.scrollHeight = 1400;
      rerender({ items: ["first", "second"] });
    });
    expect(state.scrollTop).toBe(1200);
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

  it("does not resume following when collapsing content brings the bottom into view", () => {
    const observers = installResizeObservers();
    const state: ScrollBoxState = { scrollHeight: 1400, clientHeight: 200, scrollTop: 1200 };
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

    act(() => {
      state.scrollHeight = 1600;
      rerender({ items: ["turn", "more-output"] });
      childObserver?.callback([], {} as ResizeObserver);
    });

    // The bottom arrived on its own. New output must not pin the reader, or
    // the turn spacer would jump them to the latest user message.
    expect(state.scrollTop).toBe(900);
    expect(result.current.showScrollToBottom).toBe(true);
  });

  it("stays detached when collapsing content drags the viewport to the bottom", () => {
    const observers = installResizeObservers();
    const state: ScrollBoxState = { scrollHeight: 2400, clientHeight: 800, scrollTop: 1600 };
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
      state.scrollTop = 1000;
      result.current.handleScroll();
    });
    expect(result.current.showScrollToBottom).toBe(true);

    // A finished tool row collapses: the document loses more height than the
    // reader had below them, so the browser parks them at the new bottom.
    act(() => {
      state.scrollHeight = 1400;
      state.scrollTop = 600;
      childObserver?.callback([], {} as ResizeObserver);
      result.current.handleScroll();
    });

    // The spacer after the latest user message grows back into the freed room.
    act(() => {
      state.scrollHeight = 2400;
      childObserver?.callback([], {} as ResizeObserver);
    });

    expect(state.scrollTop).toBe(600);
    expect(result.current.showScrollToBottom).toBe(true);
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

  it("keeps a detached reader on the in-view node when content is inserted above it", () => {
    const observers = installResizeObservers();
    const state: ScrollBoxState = { scrollHeight: 1200, clientHeight: 200, scrollTop: 1000 };
    const el = makeScrollBox(state);
    const turn = document.createElement("article");
    const paragraph = document.createElement("p");
    turn.appendChild(paragraph);
    el.appendChild(turn);
    const emptyRect = {
      left: 0,
      width: 400,
      right: 400,
      x: 0,
      toJSON: () => ({})
    };
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
      ...emptyRect,
      top: 0,
      y: 0,
      height: 200,
      bottom: 200
    });
    let nodeContentTop = 800;
    vi.spyOn(paragraph, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          ...emptyRect,
          top: nodeContentTop - state.scrollTop,
          y: nodeContentTop - state.scrollTop,
          height: 40,
          bottom: nodeContentTop - state.scrollTop + 40
        })
    );
    document.elementFromPoint = () => paragraph;

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
    });
    expect(result.current.showScrollToBottom).toBe(true);

    act(() => {
      nodeContentTop = 1100;
      state.scrollHeight = 1700;
      childObserver?.callback([], {} as ResizeObserver);
    });

    expect(state.scrollTop).toBe(900);
    expect(result.current.showScrollToBottom).toBe(true);
  });

  it.each(["auto", "hidden"])(
    "anchors a nested %s scroll container instead of its moving descendant",
    (overflowY) => {
      const observers = installResizeObservers();
      const state: ScrollBoxState = { scrollHeight: 1213, clientHeight: 200, scrollTop: 1013 };
      const el = makeScrollBox(state);
      const turn = document.createElement("article");
      const nestedScroller = document.createElement("div");
      const line = document.createElement("span");
      nestedScroller.style.overflowY = overflowY;
      nestedScroller.appendChild(line);
      turn.appendChild(nestedScroller);
      el.appendChild(turn);
      Object.defineProperties(nestedScroller, {
        scrollHeight: { configurable: true, get: () => 800 },
        clientHeight: { configurable: true, get: () => 300 }
      });
      const emptyRect = { left: 0, width: 400, right: 400, x: 0, toJSON: () => ({}) };
      vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
        ...emptyRect,
        top: 0,
        y: 0,
        height: 200,
        bottom: 200
      });
      let nestedContentTop = 1040;
      let nestedScrollTop = 0;
      vi.spyOn(nestedScroller, "getBoundingClientRect").mockImplementation(() => ({
        ...emptyRect,
        top: nestedContentTop - state.scrollTop,
        y: nestedContentTop - state.scrollTop,
        height: 300,
        bottom: nestedContentTop - state.scrollTop + 300
      }));
      vi.spyOn(line, "getBoundingClientRect").mockImplementation(() => ({
        ...emptyRect,
        top: nestedContentTop + 10 - nestedScrollTop - state.scrollTop,
        y: nestedContentTop + 10 - nestedScrollTop - state.scrollTop,
        height: 20,
        bottom: nestedContentTop + 30 - nestedScrollTop - state.scrollTop
      }));
      document.elementFromPoint = () => line;

      const { result } = renderHook(() => {
        const api = useSmartFollowScroll("session-a", ["turn"], false);
        attachListRef(api.conversationListRef, el);
        return api;
      });
      const childObserver = observers.find((observer) => observer.targets.includes(turn));

      act(() => {
        result.current.handleUserScrollIntent();
        state.scrollTop = 1003;
        result.current.handleScroll();
      });

      act(() => {
        nestedScrollTop = 500;
        state.scrollHeight = 1263;
        childObserver?.callback([], {} as ResizeObserver);
      });

      // The file diff scrolled and more output arrived below the viewport.
      // Neither event moved the nested card in the outer transcript.
      expect(state.scrollTop).toBe(1003);

      act(() => {
        nestedContentTop += 120;
        state.scrollHeight = 1383;
        childObserver?.callback([], {} as ResizeObserver);
      });

      // Actual layout growth above the card still keeps the reader's outer
      // viewport anchored on that card.
      expect(state.scrollTop).toBe(1123);
    }
  );

  it.each(["item update", "child resize"] as const)(
    "does not apply a shrink twice after the browser clamps scrollTop (%s)",
    (trigger) => {
      const observers = installResizeObservers();
      const state: ScrollBoxState = { scrollHeight: 1513, clientHeight: 500, scrollTop: 1013 };
      const el = makeScrollBox(state);
      const turn = document.createElement("article");
      const paragraph = document.createElement("p");
      turn.appendChild(paragraph);
      el.appendChild(turn);
      const emptyRect = { left: 0, width: 400, right: 400, x: 0, toJSON: () => ({}) };
      vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
        ...emptyRect,
        top: 0,
        y: 0,
        height: 500,
        bottom: 500
      });
      let paragraphContentTop = 1040;
      vi.spyOn(paragraph, "getBoundingClientRect").mockImplementation(() => ({
        ...emptyRect,
        top: paragraphContentTop - state.scrollTop,
        y: paragraphContentTop - state.scrollTop,
        height: 40,
        bottom: paragraphContentTop - state.scrollTop + 40
      }));
      document.elementFromPoint = () => paragraph;

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
        state.scrollTop = 1003;
        result.current.handleScroll();
      });

      act(() => {
        paragraphContentTop = 540;
        state.scrollHeight = 1013;
        // WebKit clamps to the new maximum before delivering either update.
        state.scrollTop = 513;
        if (trigger === "item update") {
          rerender({ items: ["turn", "shrunk"] });
        } else {
          childObserver?.callback([], {} as ResizeObserver);
        }
      });

      // The paragraph moved up by 500px, so the reader should move from 1003
      // to 503. The browser's 490px clamp already supplied most of that move.
      expect(state.scrollTop).toBe(503);

      act(() => {
        result.current.handleUserScrollIntent();
        state.scrollTop = 400;
        paragraphContentTop = 640;
        state.scrollHeight = 1113;
        if (trigger === "item update") {
          rerender({ items: ["turn", "grown"] });
        } else {
          childObserver?.callback([], {} as ResizeObserver);
        }
      });

      // This time the list was not clamped: a pending user movement supplied
      // the new base, and the 100px anchor correction is added to that base.
      expect(state.scrollTop).toBe(500);
    }
  );

  it("anchors on the child straddling the probe line when the hit test lands in the gutter", () => {
    // The reading column is centred by the list's inline padding, so a probe
    // in the padding hits the scroller itself. The anchor must fall back to
    // geometry rather than give up, or nothing keeps a detached reader still.
    const observers = installResizeObservers();
    const state: ScrollBoxState = { scrollHeight: 1200, clientHeight: 200, scrollTop: 1000 };
    const el = makeScrollBox(state);
    const older = document.createElement("article");
    const turn = document.createElement("article");
    el.appendChild(older);
    el.appendChild(turn);
    const emptyRect = { left: 0, width: 400, right: 400, x: 0, toJSON: () => ({}) };
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
      ...emptyRect,
      top: 0,
      y: 0,
      height: 200,
      bottom: 200
    });
    // `older` ends above the probe line; `turn` straddles it.
    vi.spyOn(older, "getBoundingClientRect").mockImplementation(
      () => ({ ...emptyRect, top: -state.scrollTop, y: -state.scrollTop, height: 500, bottom: 500 - state.scrollTop })
    );
    let nodeContentTop = 560;
    vi.spyOn(turn, "getBoundingClientRect").mockImplementation(
      () => ({
        ...emptyRect,
        top: nodeContentTop - state.scrollTop,
        y: nodeContentTop - state.scrollTop,
        height: 300,
        bottom: nodeContentTop - state.scrollTop + 300
      })
    );
    document.elementFromPoint = () => el;

    const { result } = renderHook(() => {
      const api = useSmartFollowScroll("session-a", ["older", "turn"], false);
      attachListRef(api.conversationListRef, el);
      return api;
    });
    const childObserver = observers.find((observer) => observer.targets.includes(turn));

    act(() => {
      result.current.handleUserScrollIntent();
      state.scrollTop = 600;
      result.current.handleScroll();
    });
    expect(result.current.showScrollToBottom).toBe(true);

    act(() => {
      nodeContentTop = 860;
      state.scrollHeight = 1500;
      childObserver?.callback([], {} as ResizeObserver);
    });

    expect(state.scrollTop).toBe(900);
  });

  it("resumes following when momentum lands within a pixel of the bottom", () => {
    // iOS reports fractional scrollTop against rounded scrollHeight, and the
    // intent window has expired by the time momentum stops.
    installResizeObservers();
    const state: ScrollBoxState = { scrollHeight: 1200, clientHeight: 200, scrollTop: 1000 };
    const el = makeScrollBox(state);
    const { result } = renderHook(() => {
      const api = useSmartFollowScroll("session-a", ["a"], false);
      attachListRef(api.conversationListRef, el);
      return api;
    });

    act(() => {
      result.current.handleUserScrollIntent();
      state.scrollTop = 600;
      result.current.handleScroll();
    });
    expect(result.current.showScrollToBottom).toBe(true);

    act(() => {
      state.scrollTop = 999.5;
      result.current.handleScroll();
    });
    expect(result.current.showScrollToBottom).toBe(false);

    // Following again: the next content change pins to the new bottom.
    act(() => {
      state.scrollHeight = 1400;
      result.current.handleScroll();
    });
    expect(state.scrollTop).toBe(1200);
  });

  it("stays pinned to the bottom when a width reflow grows the transcript", () => {
    const observers = installResizeObservers();
    const state = { scrollHeight: 1000, clientHeight: 200, scrollTop: 800, clientWidth: 800 };
    const el = makeScrollBox(state);
    Object.defineProperty(el, "clientWidth", { configurable: true, get: () => state.clientWidth });
    el.appendChild(document.createElement("article"));
    renderHook(() => {
      const api = useSmartFollowScroll("session-a", ["turn"], false);
      attachListRef(api.conversationListRef, el);
      return api;
    });
    const listObserver = observers.find((observer) => observer.targets.includes(el));
    expect(listObserver).toBeDefined();

    act(() => {
      // Side panel opens: narrower list, taller transcript, same content.
      state.clientWidth = 500;
      state.scrollHeight = 1300;
      listObserver?.callback([], {} as ResizeObserver);
    });

    expect(state.scrollTop).toBe(1100);
  });

  it("keeps a bottom-dwelling detached reader at the bottom across a width reflow without re-arming follow", () => {
    const observers = installResizeObservers();
    const state = { scrollHeight: 1000, clientHeight: 200, scrollTop: 800, clientWidth: 800 };
    const el = makeScrollBox(state);
    Object.defineProperty(el, "clientWidth", { configurable: true, get: () => state.clientWidth });
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
    const listObserver = observers.find((observer) => observer.targets.includes(el));

    // Detach with a 0.5px nudge, like the small-gesture test.
    act(() => {
      result.current.handleUserScrollIntent();
      state.scrollTop = 799.5;
      result.current.handleScroll();
    });

    // Height-only growth must leave a detached reader alone.
    act(() => {
      state.scrollHeight = 1010;
      listObserver?.callback([], {} as ResizeObserver);
    });
    expect(state.scrollTop).toBe(799.5);

    // Same growth driven by a width change (panel toggle) keeps the bottom.
    act(() => {
      state.clientWidth = 500;
      state.scrollHeight = 1310;
      listObserver?.callback([], {} as ResizeObserver);
    });
    expect(state.scrollTop).toBe(1110);
    expect(result.current.showScrollToBottom).toBe(false);

    // Still detached: the next streamed chunk leaves the viewport alone.
    act(() => {
      state.scrollHeight = 1500;
      rerender({ items: ["turn", "more"] });
    });
    expect(state.scrollTop).toBe(1110);
  });

  it("preserves the viewport when the panel layout key changes", () => {
    const state = { scrollHeight: 1000, clientHeight: 200, scrollTop: 800, clientWidth: 800 };
    const el = makeScrollBox(state);
    Object.defineProperty(el, "clientWidth", { configurable: true, get: () => state.clientWidth });
    el.appendChild(document.createElement("article"));
    const { rerender } = renderHook(
      ({ layoutKey }: { layoutKey: string }) => {
        const api = useSmartFollowScroll("session-a", ["turn"], false, undefined, null, layoutKey);
        attachListRef(api.conversationListRef, el);
        return api;
      },
      { initialProps: { layoutKey: "chat:nlog" } }
    );

    // Panel opens: the DOM mutation lands before the layout effect runs.
    state.clientWidth = 500;
    state.scrollHeight = 1300;
    act(() => {
      rerender({ layoutKey: "panel:nlog" });
    });

    expect(state.scrollTop).toBe(1100);
  });

  it("does not jump a leftover-viewport spacer when a tiny upward gesture detaches", () => {
    // Pinning to the bottom of a leftover spacer sits the latest user message
    // at the top of the pane. A shrink in the live turn (or clearing the
    // spacer) while the reader is 1px off the bottom clamps them onto the
    // previous message. Recompute the leftover so used+spacer stays the
    // viewport, then put scrollTop back if the browser already clamped.
    const observers = installResizeObservers();
    const spacer = document.createElement("div");
    spacer.setAttribute("data-conversation-spacer", "");
    spacer.style.height = "600px";
    const contentHeight = 1000;
    const state: ScrollBoxState = {
      scrollHeight: contentHeight + 600,
      clientHeight: 800,
      scrollTop: 800,
      scrollHeightOf: () => contentHeight + (Number.parseFloat(spacer.style.height) || 0)
    };
    const el = makeScrollBox(state);
    const user = document.createElement("div");
    user.setAttribute("data-turn-anchor", "true");
    Object.defineProperty(user, "offsetTop", { configurable: true, get: () => 200 });
    Object.defineProperty(user, "offsetHeight", { configurable: true, get: () => 40 });
    const tail = document.createElement("div");
    tail.className = "conversation-tail";
    Object.defineProperty(tail, "offsetTop", { configurable: true, get: () => 380 });
    Object.defineProperty(tail, "offsetHeight", { configurable: true, get: () => 20 });
    const turn = document.createElement("article");
    el.append(user, turn, tail, spacer);
    const originalGetComputedStyle = window.getComputedStyle.bind(window);
    const styleSpy = vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
      if (element === el) {
        return { paddingTop: "32px", paddingBottom: "32px" } as CSSStyleDeclaration;
      }
      return originalGetComputedStyle(element);
    });

    const { result, rerender } = renderHook(
      ({ items }: { items: readonly string[] }) => {
        const api = useSmartFollowScroll("session-a", items, false, undefined, "u1");
        attachListRef(api.conversationListRef, el);
        return api;
      },
      { initialProps: { items: ["turn"] } }
    );
    const childObserver = observers.find((observer) => observer.targets.includes(turn));

    act(() => {
      rerender({ items: ["turn"] });
    });
    // 800px pane - 64px padding - 200px from user message through the tail.
    expect(spacer.style.height).toBe("536px");
    expect(state.scrollTop).toBe(contentHeight + 536 - 800);

    const pinnedTop = state.scrollTop;
    act(() => {
      result.current.handleUserScrollIntent();
      state.scrollTop = pinnedTop - 4;
      result.current.handleScroll();
    });
    expect(state.scrollTop).toBe(pinnedTop - 4);
    expect(spacer.style.height).toBe("536px");

    act(() => {
      // A remount, a missed following-path apply, or a missing turn-anchor
      // used to write 0px here. Restoring after the clamp is too late if
      // we also forget the pre-collapse scrollTop.
      spacer.style.height = "0px";
      state.scrollTop = Math.max(0, contentHeight - 800);
      childObserver?.callback([], {} as ResizeObserver);
      result.current.handleScroll();
    });

    expect(spacer.style.height).toBe("536px");
    expect(state.scrollTop).toBe(pinnedTop - 4);
    expect(result.current.showScrollToBottom).toBe(false);

    act(() => {
      // Further reader movement must not be rewound to the detach snapshot.
      state.scrollTop = pinnedTop - 200;
      result.current.handleScroll();
    });
    expect(spacer.style.height).toBe("536px");
    expect(state.scrollTop).toBe(pinnedTop - 200);
    expect(result.current.showScrollToBottom).toBe(true);

    act(() => {
      spacer.style.height = "0px";
      state.scrollTop = Math.max(0, contentHeight - 800);
      childObserver?.callback([], {} as ResizeObserver);
      result.current.handleScroll();
    });
    expect(spacer.style.height).toBe("536px");
    expect(state.scrollTop).toBe(pinnedTop - 200);

    styleSpy.mockRestore();
  });
});
