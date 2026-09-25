import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MultitaskGroup, type MultitaskLive } from "./MultitaskGroup.js";
import type { MultitaskNotice } from "../lib/multitask.js";

const notices: MultitaskNotice[] = [{
  childSessionId: "child", taskLabel: "Fix label", prompt: null,
  worktree: false, state: "running", answer: null, createdAt: "2026-09-26T10:00:00Z"
}];

describe("MultitaskGroup", () => {
  afterEach(cleanup);

  it("keeps a collapsed group folded while attention and finish counts update", () => {
    const live = new Map<string, MultitaskLive>([["child", {
      state: "running", taskLabel: "Fix label", attention: "normal", approvalCommand: null, startedAt: null
    }]]);
    const { rerender } = render(<MultitaskGroup notices={notices} live={live} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Multitasks 1 running" }));
    live.set("child", { state: "blocked", taskLabel: "Fix label", attention: "question-asked", approvalCommand: null, startedAt: null });
    rerender(<MultitaskGroup notices={notices} live={live} onOpen={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Multitasks 1 needs you" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Open multitask: Fix label" })).toBeNull();
    live.set("child", { state: "complete", taskLabel: "Fix label", attention: "normal", approvalCommand: null, startedAt: null });
    rerender(<MultitaskGroup notices={notices} live={live} onOpen={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Multitasks 1 finished" })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: "Multitasks 1 finished" }));
    expect(screen.getByRole("button", { name: "Open multitask: Fix label" })).toBeVisible();
  });

  it("opens folded when it holds more than three multitasks", () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) => ({
      ...notices[0], childSessionId: `child-${index}`, taskLabel: `Task ${index}`, state: "complete"
    }));
    render(<MultitaskGroup notices={many(3)} onOpen={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Multitasks 3 finished" })).toHaveAttribute("aria-expanded", "true");
    cleanup();
    render(<MultitaskGroup notices={many(4)} onOpen={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Multitasks 4 finished" })).toHaveAttribute("aria-expanded", "false");
  });

  it("preserves unavailable task history without offering a broken chat action", () => {
    render(<MultitaskGroup notices={notices} onOpen={vi.fn()} />);
    expect(screen.getByText("Fix label")).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Open multitask/ })).toBeNull();
  });
});
