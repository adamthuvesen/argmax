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

describe("useSmartFollowScroll", () => {
  afterEach(() => {
    cleanup();
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
});
