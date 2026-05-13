import { cleanup, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useFreshSet } from "./useFreshSet.js";

type Item = { id: string };
const getId = (item: Item): string => item.id;

describe("useFreshSet — ref mutation moved out of render", () => {
  afterEach(() => {
    cleanup();
  });

  /**
   * audit-2026-05-11 / SPEC P1.14 — the previous implementation mutated
   * `seenRef.current` inside the render body. Under React 18 StrictMode the
   * render runs twice in dev; the second invocation would double-handle the
   * seen set. The fix moves the mutation into a `useEffect` so render stays
   * pure and StrictMode's double-invoke is a no-op.
   */
  it("treats initial items as already-seen after mount under StrictMode", () => {
    const initial = [{ id: "a" }, { id: "b" }];
    const { result } = renderHook(() => useFreshSet(initial, getId, "context-1"), {
      wrapper: StrictMode
    });

    // After mount + effect commit, the items present at mount are seen.
    const [first, second] = initial;
    expect(result.current(first)).toBe(false);
    expect(result.current(second)).toBe(false);
  });

  it("marks newly-arrived items as seen after the next render+effect cycle", () => {
    let items: Item[] = [{ id: "a" }];
    const { result, rerender } = renderHook(
      ({ list }: { list: Item[] }) => useFreshSet(list, getId, "context-1"),
      { initialProps: { list: items }, wrapper: StrictMode }
    );

    const [a] = items;
    expect(result.current(a)).toBe(false);

    items = [{ id: "a" }, { id: "b" }];
    rerender({ list: items });

    expect(result.current({ id: "a" })).toBe(false);
    expect(result.current({ id: "b" })).toBe(false);
  });

  it("predicate identity is stable while getId and resetKey are stable", () => {
    // Under the prior in-render mutation, the predicate's identity could
    // shift every render because the closure captured a freshly-modified
    // ref. The fix keeps the predicate stable as long as its deps
    // (`getId`, `resetKey`) are stable.
    const items = [{ id: "a" }];
    const { result, rerender } = renderHook(
      ({ list }: { list: Item[] }) => useFreshSet(list, getId, "context-1"),
      { initialProps: { list: items }, wrapper: StrictMode }
    );
    const first = result.current;
    rerender({ list: [...items, { id: "b" }] });
    expect(result.current).toBe(first);
  });
});
