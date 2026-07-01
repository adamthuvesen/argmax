import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSidebarResize } from "./useSidebarResize.js";

function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width
  });
}

describe("useSidebarResize", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setViewportWidth(420);
  });

  afterEach(() => {
    window.localStorage.clear();
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });

  it("clamps a stored sidebar width that would crowd the workspace", () => {
    window.localStorage.setItem("argmax.sidebar.width", "500");

    const { result } = renderHook(() => useSidebarResize());

    expect(result.current.sidebarWidth).toBe(220);
  });

  it("keeps a drag from widening the sidebar past the responsive maximum", () => {
    const { result } = renderHook(() => useSidebarResize());

    act(() => {
      result.current.onResizeMouseDown({
        preventDefault: () => undefined,
        clientX: 180
      } as React.MouseEvent);
    });
    act(() => {
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: 500 }));
    });
    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup"));
    });

    expect(result.current.sidebarWidth).toBe(220);
  });

  it("clamps the sidebar when the viewport narrows after mount", () => {
    setViewportWidth(1000);
    window.localStorage.setItem("argmax.sidebar.width", "500");
    const { result } = renderHook(() => useSidebarResize());
    expect(result.current.sidebarWidth).toBe(500);

    act(() => {
      setViewportWidth(420);
      window.dispatchEvent(new Event("resize"));
    });

    expect(result.current.sidebarWidth).toBe(220);
  });
});
