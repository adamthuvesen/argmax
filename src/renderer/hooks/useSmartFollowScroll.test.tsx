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
  flushAll: () => void;
} {
  let nextId = 1;
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
    flushAll: () => {
      let guard = 0;
      while (queue.size > 0 && guard < 100) {
        guard += 1;
        const [id, callback] = Array.from(queue.entries())[0];
        queue.delete(id);
        callback(performance.now());
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

  it("keeps following through non-user scroll gaps while content grows", () => {
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

  it("re-enables following when the user taps scroll to latest during streaming", () => {
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
      state.scrollHeight = 1250;
      state.scrollTop = 950;
      result.current.handleScroll();
    });

    expect(result.current.showScrollToBottom).toBe(false);

    act(() => {
      state.scrollHeight = 1400;
      rerender({ items: ["first", "second"] });
    });

    expect(state.scrollTop).toBe(1200);
  });

  it("keeps live output in reserved space before catching up", () => {
    const frames = installAnimationFrameQueue();
    const state: ScrollBoxState = { scrollHeight: 1056, clientHeight: 200, scrollTop: 856 };
    const el = makeScrollBox(state);
    const { result, rerender } = renderHook(
      ({ items }: { items: readonly string[] }) => useSmartFollowScroll("session-a", items, false, true),
      { initialProps: { items: ["first"] } }
    );
    attachListRef(result.current.conversationListRef, el);

    act(() => {
      state.scrollHeight = 1088;
      rerender({ items: ["first", "small-growth"] });
    });

    expect(state.scrollTop).toBe(856);
    expect(frames.requestAnimationFrame).not.toHaveBeenCalled();

    act(() => {
      state.scrollHeight = 1116;
      rerender({ items: ["first", "small-growth", "large-growth"] });
    });

    expect(frames.requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(state.scrollTop).toBe(856);
    act(() => {
      frames.flushAll();
    });

    const scrollTo = Object.getOwnPropertyDescriptor(el, "scrollTo")?.value as ReturnType<typeof vi.fn>;
    expect(scrollTo).not.toHaveBeenCalled();
    expect(state.scrollTop).toBe(916);
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
