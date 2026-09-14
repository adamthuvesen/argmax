import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SlidingTabIndicator } from "./SlidingTabIndicator.js";

function Tabs({ active }: { active: "one" | "two" }): React.JSX.Element {
  return (
    <div role="tablist">
      <SlidingTabIndicator activeKey={active} />
      <button role="tab" aria-selected={active === "one"}>One</button>
      <button role="tab" aria-selected={active === "two"}>Two</button>
    </div>
  );
}

describe("SlidingTabIndicator", () => {
  it("follows the selected tab box", () => {
    const { rerender } = render(<Tabs active="one" />);
    const [one, two] = screen.getAllByRole("tab");
    Object.defineProperties(one, {
      offsetLeft: { configurable: true, value: 8 },
      offsetWidth: { configurable: true, value: 42 }
    });
    Object.defineProperties(two, {
      offsetLeft: { configurable: true, value: 56 },
      offsetWidth: { configurable: true, value: 64 }
    });

    rerender(<Tabs active="two" />);

    const indicator = document.querySelector<HTMLElement>(".sliding-tab-indicator");
    expect(indicator?.style.getPropertyValue("--sliding-tab-x")).toBe("56px");
    expect(indicator?.style.getPropertyValue("--sliding-tab-width")).toBe("64px");
    expect(indicator).toHaveAttribute("data-ready", "true");
  });
});
