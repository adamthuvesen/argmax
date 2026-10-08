import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionPrSummary } from "../../shared/types.js";
import { PrWatchPill } from "./PrWatchPill.js";

function pr(overrides: Partial<SessionPrSummary>): SessionPrSummary {
  return {
    sessionId: "s1",
    prNumber: 1666,
    url: "https://github.com/o/r/pull/1666",
    title: "Separate signing",
    prState: "OPEN",
    headRefName: "fix/signing",
    relationship: "worked",
    activityAt: "2026-10-08T05:00:00.000Z",
    updatedAt: "2026-10-08T05:00:00.000Z",
    checkState: "success",
    isPrimary: true,
    isPinned: false,
    isWatched: true,
    refreshError: null,
    ...overrides
  };
}

describe("<PrWatchPill />", () => {
  afterEach(() => {
    cleanup();
    delete (window as { argmax?: unknown }).argmax;
  });

  it("opens the PR when clicked", () => {
    const openPath = vi.fn().mockResolvedValue({ ok: true });
    (window as { argmax?: unknown }).argmax = { system: { openPath } };
    render(<PrWatchPill prs={[pr({})]} />);

    fireEvent.click(screen.getByRole("button", { name: "Babysitting PR #1666" }));

    expect(openPath).toHaveBeenCalledWith({ path: "https://github.com/o/r/pull/1666" });
  });

  it("shows each open PR the chat watches and nothing else", () => {
    render(
      <PrWatchPill
        prs={[
          pr({}),
          pr({ prNumber: 1665, prState: "MERGED" }),
          pr({ prNumber: 1370, isWatched: false })
        ]}
      />
    );
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Babysitting PR #1666"
    ]);
  });

  it("renders nothing once no open PR is watched", () => {
    const { container } = render(<PrWatchPill prs={[pr({ prState: "MERGED" })]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
