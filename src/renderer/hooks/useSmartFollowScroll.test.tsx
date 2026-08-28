import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type MutableRefObject } from "react";
import { useSmartFollowScroll } from "./useSmartFollowScroll.js";

type ScrollBoxState = {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
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
    },
    scrollTo: {
      configurable: true,
      value: vi.fn((options?: ScrollToOptions | number, y?: number) => {
        const top =
          typeof options === "number"
            ? options
            : typeof options?.top === "number"
              ? options.top
              : typeof y === "number"
                ? y
                : state.scrollTop;
        state.scrollTop = clampTop(top);
      })
    }
  });

  return el;
}

function installAnimationFrameQueue(): {
  requestAnimationFrame: ReturnType<typeof vi.fn>;
  cancelAnimationFrame: ReturnType<typeof vi.fn>;
  flushNext: () => void;
  flushAll: () => void;
} {
  let nextId = 1;
  let nowMs = performance.now();
  const queue = new Map<number, FrameRequestCallback>();
  const requestAnimationFrame = vi.fn((callback: FrameRequestCallback): number => {
    const id = nextId;
    nextId += 1;
    queue.set(id, callback);
    return id;
  });
  const cancelAnimationFrame = vi.fn((id: number): void => {
    queue.delete(id);
  });
  vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
  vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);

  return {
    requestAnimationFrame,
    cancelAnimationFrame,
    flushNext: () => {
      const [entry] = Array.from(queue.entries());
      if (!entry) return;
      const [id, callback] = entry;
      queue.delete(id);
      nowMs += 1000 / 60;
      callback(nowMs);
    },
    flushAll: () => {
      let guard = 0;
      while (queue.size > 0 && guard < 100) {
        guard += 1;
        const [id, callback] = Array.from(queue.entries())[0];
        queue.delete(id);
        nowMs += 1000 / 60;
        callback(nowMs);
      }
      if (queue.size > 0) {
        throw new Error("requestAnimationFrame queue did not settle");
      }
    }
  };
}

describe("useSmartFollowScroll", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("smoothly follows when the composer grows under the list", () => {
    const frames = installAnimationFrameQueue();
    // One observer per useEffect; the viewport one is whichever observed the
    // list itself (the other watches the list's children).
    const observers: { callback: ResizeObserverCallback; targets: Element[] }[] = [];
    class StubResizeObserver implements ResizeObserver {
      private entry: { callback: ResizeObserverCallback; targets: Element[] };
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
    const state: ScrollBoxState = { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 };
    const el = makeScrollBox(state);
    el.appendChild(document.createElement("article"));
    // Assign during render, the way React attaches a ref before effects run.
    // the observer effect has to see the element on its first pass.
    renderHook(() => {
      const api = useSmartFollowScroll("session-a", ["streaming-turn"], false, true);
      attachListRef(api.conversationListRef, el);
      return api;
    });

    const viewport = observers.find((observer) => observer.targets.includes(el));
    expect(viewport, "expected an observer on the scroll viewport").toBeDefined();

    act(() => {
      // A wrapped draft line takes 60px from the list's viewport.
      state.clientHeight = 240;
      viewport?.callback([], {} as ResizeObserver);
    });

    expect(frames.requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(state.scrollTop).toBe(700);
    act(() => {
      frames.flushAll();
    });

    expect(state.scrollTop).toBe(760);
  });

  it("re-pins after the turn ends even when the near-bottom flag has gone stale", () => {
    const frames = installAnimationFrameQueue();
    const observers: { callback: ResizeObserverCallback; targets: Element[] }[] = [];
    class StubResizeObserver implements ResizeObserver {
      private entry: { callback: ResizeObserverCallback; targets: Element[] };
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
    const state: ScrollBoxState = { scrollHeight: 1000, clientHeight: 300, scrollTop: 500 };
    const el = makeScrollBox(state);
    el.appendChild(document.createElement("article"));
    const composer = document.createElement("textarea");
    // Stable across renders, the way the real props are. A fresh array or ref
    // each render would re-run the follow effect and mask the behavior here.
    const composerRef = { current: composer };
    const items = ["settled-turn"];
    const { result } = renderHook(() => {
      const api = useSmartFollowScroll("session-a", items, false, false, composerRef);
      attachListRef(api.conversationListRef, el);
      return api;
    });

    const viewport = observers.find((observer) => observer.targets.includes(el));
    // The composer's textarea is observed too: its growth is what shrinks the
    // list, and that notification lands whether or not the list's own does.
    expect(viewport?.targets).toContain(composer);

    // Read history, then settle back at the latest without a scroll event.
    // the flag stays false while the view is demonstrably at the bottom.
    state.scrollTop = 500;
    act(() => {
      result.current.handleUserScrollIntent();
      result.current.handleScroll();
    });
    expect(result.current.showScrollToBottom).toBe(true);
    state.scrollTop = 700;

    act(() => {
      // The draft wraps onto three more lines.
      state.clientHeight = 240;
      viewport?.callback([], {} as ResizeObserver);
    });
    act(() => {
      frames.flushAll();
    });

    expect(state.scrollTop).toBe(760);
  });

  it("keeps following through non-user scroll gaps while content grows", () => {
    const frames = installAnimationFrameQueue();
    const state: ScrollBoxState = { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 };
    const el = makeScrollBox(state);
    const { result, rerender } = renderHook(
      ({ items }: { items: readonly string[] }) => useSmartFollowScroll("session-a", items, false),
      { initialProps: { items: ["first"] } }
    );
    attachListRef(result.current.conversationListRef, el);

    act(() => {
      state.scrollHeight = 1200;
      result.current.handleScroll();
    });

    expect(result.current.showScrollToBottom).toBe(false);

    act(() => {
      state.scrollHeight = 1300;
      rerender({ items: ["first", "second"] });
    });
    act(() => {
      frames.flushAll();
    });

    expect(state.scrollTop).toBe(1100);
  });

  it("pauses following when the user scrolls away from the bottom", () => {
    const state: ScrollBoxState = { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 };
    const el = makeScrollBox(state);
    const { result, rerender } = renderHook(
      ({ items }: { items: readonly string[] }) => useSmartFollowScroll("session-a", items, false),
      { initialProps: { items: ["first"] } }
    );
    attachListRef(result.current.conversationListRef, el);

    act(() => {
      result.current.handleUserScrollIntent();
      state.scrollHeight = 1200;
      result.current.handleScroll();
    });

    expect(result.current.showScrollToBottom).toBe(true);

    act(() => {
      state.scrollHeight = 1300;
      rerender({ items: ["first", "second"] });
    });

    expect(state.scrollTop).toBe(800);
  });

  it("does not snap back when the session becomes live while the user reads history", () => {
    const frames = installAnimationFrameQueue();
    const state: ScrollBoxState = { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 };
    const el = makeScrollBox(state);
    const { result, rerender } = renderHook(
      ({ live }: { live: boolean }) => useSmartFollowScroll("session-a", ["turn"], false, live),
      { initialProps: { live: false } }
    );
    attachListRef(result.current.conversationListRef, el);

    act(() => {
      result.current.handleUserScrollIntent();
      state.scrollTop = 500;
      result.current.handleScroll();
    });
    act(() => {
      rerender({ live: true });
    });

    expect(frames.requestAnimationFrame).not.toHaveBeenCalled();
    expect(state.scrollTop).toBe(500);
  });

  it("re-enables following when the user taps scroll to latest during streaming", () => {
    const frames = installAnimationFrameQueue();
    const state: ScrollBoxState = { scrollHeight: 1200, clientHeight: 200, scrollTop: 800 };
    const el = makeScrollBox(state);
    const { result, rerender } = renderHook(
      ({ items }: { items: readonly string[] }) => useSmartFollowScroll("session-a", items, false),
      { initialProps: { items: ["first"] } }
    );
    attachListRef(result.current.conversationListRef, el);

    act(() => {
      result.current.handleUserScrollIntent();
      result.current.handleScroll();
    });

    expect(result.current.showScrollToBottom).toBe(true);

    act(() => {
      result.current.scrollToBottom();
    });
    act(() => {
      frames.flushAll();
    });

    expect(result.current.showScrollToBottom).toBe(false);
    expect(state.scrollTop).toBe(1000);

    act(() => {
      state.scrollHeight = 1400;
      rerender({ items: ["first", "second"] });
    });
    act(() => {
      frames.flushAll();
    });

    expect(state.scrollTop).toBe(1200);
  });

  it("eases to the true bottom on every live growth", () => {
    const frames = installAnimationFrameQueue();
    const state: ScrollBoxState = { scrollHeight: 1056, clientHeight: 200, scrollTop: 856 };
    const el = makeScrollBox(state);
    const { result, rerender } = renderHook(
      ({ items }: { items: readonly string[] }) => useSmartFollowScroll("session-a", items, false, true),
      { initialProps: { items: ["first"] } }
    );
    attachListRef(result.current.conversationListRef, el);

    // No toggled reserve to absorb into: even a small live growth schedules an
    // eased catch-up toward the physical bottom. The scroll doesn't move until
    // the animation frames run.
    act(() => {
      state.scrollHeight = 1088;
      rerender({ items: ["first", "small-growth"] });
    });

    expect(frames.requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(state.scrollTop).toBe(856);

    act(() => {
      frames.flushAll();
    });

    const scrollTo = Object.getOwnPropertyDescriptor(el, "scrollTo")?.value as ReturnType<typeof vi.fn>;
    expect(scrollTo).not.toHaveBeenCalled();
    expect(state.scrollTop).toBe(888);
  });

  it("never reverses upward when the live bottom moves during catch-up", () => {
    const frames = installAnimationFrameQueue();
    const state: ScrollBoxState = { scrollHeight: 1056, clientHeight: 200, scrollTop: 856 };
    const el = makeScrollBox(state);
    const { result, rerender } = renderHook(
      ({ items }: { items: readonly string[] }) => useSmartFollowScroll("session-a", items, false, true),
      { initialProps: { items: ["streaming-turn"] } }
    );
    attachListRef(result.current.conversationListRef, el);

    act(() => {
      state.scrollHeight = 1156;
      rerender({ items: ["streaming-turn", "growth"] });
    });
    act(() => {
      frames.flushNext();
    });
    const caughtUpTop = state.scrollTop;

    act(() => {
      // A live row can settle to a smaller measured height while the follower
      // is still running. The follower must not turn that into a visible
      // reverse step. The browser owns any unavoidable max-scroll clamp.
      state.scrollHeight = 1050;
      frames.flushNext();
    });

    expect(state.scrollTop).toBe(caughtUpTop);
  });

  it("coalesces live height changes inside an existing conversation item", () => {
    const frames = installAnimationFrameQueue();
    let triggerResize: (() => void) | null = null;
    class StubResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        triggerResize = () => callback([], this);
      }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal("ResizeObserver", StubResizeObserver);
    const state: ScrollBoxState = { scrollHeight: 1056, clientHeight: 200, scrollTop: 856 };
    const el = makeScrollBox(state);
    el.appendChild(document.createElement("article"));
    const { result, rerender } = renderHook(
      ({ items }: { items: readonly string[] }) => useSmartFollowScroll("session-a", items, false, true),
      { initialProps: { items: ["streaming-turn"] } }
    );
    attachListRef(result.current.conversationListRef, el);

    act(() => {
      rerender({ items: ["streaming-turn"] });
    });

    act(() => {
      state.scrollHeight = 1116;
      triggerResize?.();
      state.scrollHeight = 1140;
      triggerResize?.();
    });

    expect(frames.requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(state.scrollTop).toBe(856);
    act(() => {
      frames.flushAll();
    });

    const scrollTo = Object.getOwnPropertyDescriptor(el, "scrollTo")?.value as ReturnType<typeof vi.fn>;
    expect(scrollTo).not.toHaveBeenCalled();
    expect(state.scrollTop).toBe(940);
  });

  it("keeps one follower when stream and composer growth land together", () => {
    const frames = installAnimationFrameQueue();
    const observers: { callback: ResizeObserverCallback; targets: Element[] }[] = [];
    class StubResizeObserver implements ResizeObserver {
      private entry: { callback: ResizeObserverCallback; targets: Element[] };
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
    const state: ScrollBoxState = { scrollHeight: 1056, clientHeight: 200, scrollTop: 856 };
    const el = makeScrollBox(state);
    el.appendChild(document.createElement("article"));
    const { result, rerender } = renderHook(
      ({ items }: { items: readonly string[] }) => useSmartFollowScroll("session-a", items, false, true),
      { initialProps: { items: ["streaming-turn"] } }
    );
    attachListRef(result.current.conversationListRef, el);
    const viewport = observers.find((observer) => observer.targets.includes(el));

    act(() => {
      state.scrollHeight = 1116;
      rerender({ items: ["streaming-turn", "growth"] });
    });
    act(() => {
      state.clientHeight = 180;
      viewport?.callback([], {} as ResizeObserver);
    });

    expect(frames.requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(state.scrollTop).toBe(856);
    act(() => {
      frames.flushAll();
    });
    expect(state.scrollTop).toBe(936);
  });

  it("hides the scroll-to-bottom button when collapsing content brings the bottom into view", () => {
    let triggerResize: (() => void) | null = null;
    class StubResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        triggerResize = () => callback([], this);
      }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal("ResizeObserver", StubResizeObserver);
    const state: ScrollBoxState = { scrollHeight: 1400, clientHeight: 200, scrollTop: 900 };
    const el = makeScrollBox(state);
    el.appendChild(document.createElement("article"));
    const { result, rerender } = renderHook(
      ({ items }: { items: readonly string[] }) => useSmartFollowScroll("session-a", items, false),
      { initialProps: { items: ["turn-with-tools"] } }
    );
    attachListRef(result.current.conversationListRef, el);

    act(() => {
      rerender({ items: ["turn-with-tools"] });
      result.current.handleUserScrollIntent();
      result.current.handleScroll();
    });

    expect(result.current.showScrollToBottom).toBe(true);

    act(() => {
      state.scrollHeight = 1100;
      triggerResize?.();
    });

    expect(result.current.showScrollToBottom).toBe(false);
  });
});
