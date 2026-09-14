import { useLayoutEffect, useRef, type CSSProperties, type JSX } from "react";

/** Carry the active tab's box across a tablist without owning tab behavior. */
export function SlidingTabIndicator({ activeKey }: { activeKey: string }): JSX.Element {
  const indicatorRef = useRef<HTMLSpanElement | null>(null);

  useLayoutEffect(() => {
    const indicator = indicatorRef.current;
    const tablist = indicator?.parentElement;
    if (!indicator || !tablist) return undefined;

    const place = (animate: boolean): void => {
      const activeTab = tablist.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      if (!activeTab) return;
      indicator.style.setProperty("--sliding-tab-x", `${activeTab.offsetLeft}px`);
      indicator.style.setProperty("--sliding-tab-width", `${activeTab.offsetWidth}px`);
      indicator.dataset.ready = animate ? "true" : "false";
      if (!animate) {
        void indicator.offsetWidth;
        indicator.dataset.ready = "true";
      }
    };

    place(indicator.dataset.ready === "true");
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => place(false));
    observer.observe(tablist);
    return () => observer.disconnect();
  }, [activeKey]);

  return (
    <span
      ref={indicatorRef}
      className="sliding-tab-indicator"
      aria-hidden="true"
      style={{ "--sliding-tab-x": "0px", "--sliding-tab-width": "0px" } as CSSProperties}
    />
  );
}
