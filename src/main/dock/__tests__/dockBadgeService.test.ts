import { describe, expect, it, vi } from "vitest";
import { DockBadgeService } from "../dockBadgeService.js";

describe("DockBadgeService", () => {
  it("sets the badge text to the total attention count", () => {
    const setBadge = vi.fn<(text: string) => void>();
    const service = new DockBadgeService({
      setBadge,
      countAttention: () => ({ total: 3 })
    });
    service.update();
    expect(setBadge).toHaveBeenCalledWith("3");
  });

  it("clears the badge when the total is zero", () => {
    let total = 2;
    const setBadge = vi.fn<(text: string) => void>();
    const service = new DockBadgeService({
      setBadge,
      countAttention: () => ({ total })
    });
    service.update();
    expect(setBadge).toHaveBeenLastCalledWith("2");
    total = 0;
    service.update();
    expect(setBadge).toHaveBeenLastCalledWith("");
  });

  it("caps high counts at '99+'", () => {
    const setBadge = vi.fn<(text: string) => void>();
    const service = new DockBadgeService({
      setBadge,
      countAttention: () => ({ total: 150 })
    });
    service.update();
    expect(setBadge).toHaveBeenCalledWith("99+");
  });

  it("skips redundant updates", () => {
    const setBadge = vi.fn<(text: string) => void>();
    const service = new DockBadgeService({
      setBadge,
      countAttention: () => ({ total: 4 })
    });
    service.update();
    service.update();
    service.update();
    expect(setBadge).toHaveBeenCalledTimes(1);
  });
});
