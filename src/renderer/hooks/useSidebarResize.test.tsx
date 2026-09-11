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
    expect(window.localStorage.getItem("argmax.sidebar.width")).toBe("500");
  });

  it("folds at the workspace plus sidebar floor and reopens after hysteresis", () => {
    setViewportWidth(700);
    window.localStorage.setItem("argmax.sidebar.width", "272");
    const { result } = renderHook(() => useSidebarResize(400));

    expect(result.current.responsiveCollapsed).toBe(false);
    expect(result.current.sidebarWidth).toBe(272);

    act(() => {
      setViewportWidth(620);
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current.responsiveCollapsed).toBe(true);
    expect(result.current.sidebarWidth).toBe(220);

    act(() => {
      setViewportWidth(640);
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current.responsiveCollapsed).toBe(true);

    act(() => {
      setViewportWidth(645);
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current.responsiveCollapsed).toBe(false);
  });

  it("restores the saved width after a responsive squeeze", () => {
    setViewportWidth(1200);
    window.localStorage.setItem("argmax.sidebar.width", "360");
    const { result } = renderHook(() => useSidebarResize(400));
    expect(result.current.sidebarWidth).toBe(360);

    act(() => {
      setViewportWidth(650);
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current.sidebarWidth).toBe(250);
    expect(window.localStorage.getItem("argmax.sidebar.width")).toBe("360");

    act(() => {
      setViewportWidth(1200);
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current.sidebarWidth).toBe(360);
  });

  it("clamps the sidebar against a dynamic workspace minimum", () => {
    setViewportWidth(1900);
    window.localStorage.setItem("argmax.sidebar.width", "500");

    const { result, rerender } = renderHook(({ workspaceMin }) => useSidebarResize(workspaceMin), {
      initialProps: { workspaceMin: 320 }
    });

    expect(result.current.sidebarWidth).toBe(500);

    rerender({ workspaceMin: 1560 });

    expect(result.current.sidebarWidth).toBe(340);
  });
});
