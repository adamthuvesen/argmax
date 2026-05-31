import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useStableFilter } from "./useStableFilter.js";

type Row = { id: string; sessionId: string };

describe("useStableFilter", () => {
  it("keeps the same reference when the filtered slice is unchanged", () => {
    const a = { id: "a", sessionId: "s1" };
    const b = { id: "b", sessionId: "s2" };
    const c = { id: "c", sessionId: "s1" };

    const { result, rerender } = renderHook(
      ({ items }: { items: Row[] }) => useStableFilter(items, "s1", (row) => row.sessionId === "s1"),
      { initialProps: { items: [a, b, c] } }
    );
    const first = result.current;
    expect(first).toEqual([a, c]);

    // New array prop, but s1's rows are the same objects in the same order.
    rerender({ items: [a, b, c, { id: "d", sessionId: "s2" }] });
    expect(result.current).toBe(first);
  });

  it("returns a new reference when this key's rows change", () => {
    const a = { id: "a", sessionId: "s1" };
    const b = { id: "b", sessionId: "s1" };
    const { result, rerender } = renderHook(
      ({ items }: { items: Row[] }) => useStableFilter(items, "s1", (row) => row.sessionId === "s1"),
      { initialProps: { items: [a] } }
    );
    const first = result.current;
    rerender({ items: [a, b] });
    expect(result.current).not.toBe(first);
    expect(result.current).toEqual([a, b]);
  });

  it("passes the array through unfiltered when key is null", () => {
    const items: Row[] = [{ id: "a", sessionId: "s1" }];
    const { result } = renderHook(() => useStableFilter(items, null, () => false));
    expect(result.current).toBe(items);
  });
});
