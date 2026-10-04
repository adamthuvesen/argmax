import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi, UsageRemaining } from "../../shared/types.js";
import { resetLedgerPageStateForTests, setCachedUsageRemaining } from "../lib/ledgerPageState.js";
import { ComposerUsageChip } from "./ComposerUsageChip.js";

function plan(percent: number, fetchedAt = new Date().toISOString()): UsageRemaining {
  return {
    fetchedAt,
    providers: [
      {
        provider: "claude",
        kind: "subscription",
        planLabel: "Max",
        message: null,
        messageUrl: null,
        windows: [
          { id: "5h", label: "5-hour", remainingPercent: percent, resetsAt: new Date(Date.now() + 2 * 3_600_000).toISOString() },
          { id: "week", label: "Weekly", remainingPercent: 88, resetsAt: null }
        ]
      },
      { provider: "codex", kind: "api_key", planLabel: null, message: null, messageUrl: null, windows: [] }
    ]
  };
}

describe("ComposerUsageChip", () => {
  const remaining = vi.fn<ArgmaxApi["usage"]["remaining"]>();

  beforeEach(() => {
    resetLedgerPageStateForTests();
    remaining.mockReset();
    window.argmax = { usage: { remaining } } as unknown as ArgmaxApi;
  });
  afterEach(() => {
    cleanup();
    delete (window as unknown as { argmax?: unknown }).argmax;
  });

  it("shows the tightest window from the cache without asking the accounts again", async () => {
    setCachedUsageRemaining(plan(41), null);
    render(<ComposerUsageChip provider="claude" />);

    const chip = await screen.findByRole("button", { name: /^Claude plan: 41% left in the 5-hour window/ });
    expect(chip).toHaveTextContent("41%");
    expect(remaining).not.toHaveBeenCalled();
  });

  it("reads the accounts once when nothing is cached, however many composers ask", async () => {
    remaining.mockResolvedValue(plan(73));
    render(
      <>
        <ComposerUsageChip provider="claude" />
        <ComposerUsageChip provider="claude" />
      </>
    );

    expect(await screen.findAllByRole("button", { name: /Claude plan: 73% left/ })).toHaveLength(2);
    expect(remaining).toHaveBeenCalledOnce();
  });

  it("lists every window and its reset in a popover", async () => {
    setCachedUsageRemaining(plan(41), null);
    render(<ComposerUsageChip provider="claude" />);

    fireEvent.click(await screen.findByRole("button", { name: /Claude plan/ }));

    const dialog = await screen.findByRole("dialog", { name: "Plan usage" });
    expect(dialog).toHaveTextContent("Max");
    expect(dialog).toHaveTextContent("5-hour");
    expect(dialog).toHaveTextContent("41% left");
    expect(dialog).toHaveTextContent("Weekly");
    expect(dialog).toHaveTextContent("88% left");
  });

  it("renders nothing for a provider whose account reports no plan windows", async () => {
    setCachedUsageRemaining(plan(41), null);
    const { container } = render(<ComposerUsageChip provider="codex" />);

    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps an account's last figures when a later read reports that account as failed, and says as of when", async () => {
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    setCachedUsageRemaining(plan(41, old), null);
    // The next read succeeds overall, but Claude's own account errors.
    setCachedUsageRemaining(
      {
        fetchedAt: new Date().toISOString(),
        providers: [
          { provider: "claude", kind: "error", planLabel: null, message: "token expired", messageUrl: null, windows: [] }
        ]
      },
      null
    );
    render(<ComposerUsageChip provider="claude" />);

    const chip = await screen.findByRole("button", { name: /^Claude plan: 41% left in the 5-hour window.*as of / });
    expect(chip).toHaveAttribute("data-old", "true");
    fireEvent.click(chip);
    await screen.findByRole("dialog", { name: "Plan usage" });
  });

  it("does not claim a failed refresh just because the figures are old", async () => {
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    setCachedUsageRemaining(plan(41, old), null);
    // The refresh works, and the account still reports figures stamped long ago.
    remaining.mockResolvedValue(plan(37, old));
    render(<ComposerUsageChip provider="claude" />);

    const chip = await screen.findByRole("button", { name: /^Claude plan: 37% left.*as of / });
    fireEvent.click(chip);
    const dialog = await screen.findByRole("dialog", { name: "Plan usage" });
    expect(dialog).toHaveTextContent("37% left");
  });

  it("does not call figures old while they are fresh", async () => {
    setCachedUsageRemaining(plan(41), null);
    render(<ComposerUsageChip provider="claude" />);

    const chip = await screen.findByRole("button", { name: /Claude plan: 41% left/ });
    expect(chip).not.toHaveAttribute("data-old");
    expect(chip.getAttribute("aria-label")).not.toContain("as of");
  });

  it("keeps the last figures when a refresh fails", async () => {
    setCachedUsageRemaining(plan(41, new Date(Date.now() - 20 * 60_000).toISOString()), null);
    remaining.mockRejectedValue(new Error("offline"));
    render(<ComposerUsageChip provider="claude" />);

    await waitFor(() => expect(remaining).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: /Claude plan: 41% left/ })).toBeInTheDocument();
  });
});
