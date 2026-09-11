import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageRail } from "./UsageRail.js";

describe("UsageRail", () => {
  afterEach(() => {
    cleanup();
  });

  it("carries both ledger pages and marks the one showing", () => {
    render(<UsageRail active="activity" onBack={() => {}} onNavigate={() => {}} />);

    // The rail is named after the section, not the page showing inside it, so
    // the standalone column announces itself the way settings does.
    const rail = screen.getByRole("complementary", { name: "Hacking" });
    const usage = within(rail).getByRole("button", { name: "Usage" });
    const activity = within(rail).getByRole("button", { name: "Activity" });

    expect(activity).toHaveAttribute("aria-current", "page");
    expect(usage).not.toHaveAttribute("aria-current");
  });

  it("crosses between the two pages without going back out through the sidebar", () => {
    const onNavigate = vi.fn();
    const onBack = vi.fn();
    render(<UsageRail active="usage" onBack={onBack} onNavigate={onNavigate} />);

    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    expect(onNavigate).toHaveBeenCalledWith("activity");

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalled();
  });
});
