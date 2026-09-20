import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IdentityPlans } from "./IdentityPlans.js";
import {
  resetLedgerPageStateForTests,
  setCachedUsageRemaining
} from "../lib/ledgerPageState.js";
import type { ArgmaxApi, UsageRemaining } from "../../shared/types.js";
import { usageRemainingFixture } from "../../test/fixtures/usageRemaining.js";

/** The menu is a `ul`; the block renders the `li`s that sit inside it. */
function renderPlans(onOpenUsage = vi.fn()): void {
  render(
    <ul>
      <IdentityPlans onOpenUsage={onOpenUsage} />
    </ul>
  );
}

function fresh(overrides: Partial<UsageRemaining> = {}): UsageRemaining {
  return usageRemainingFixture({ fetchedAt: new Date().toISOString(), ...overrides });
}

function stubRemaining(remaining: UsageRemaining): ReturnType<typeof vi.fn> {
  const read = vi.fn().mockResolvedValue(remaining);
  (globalThis.window as unknown as { argmax: ArgmaxApi }).argmax = {
    usage: { remaining: read }
  } as unknown as ArgmaxApi;
  return read;
}

describe("IdentityPlans", () => {
  afterEach(() => {
    cleanup();
    resetLedgerPageStateForTests();
    delete (globalThis.window as unknown as { argmax?: ArgmaxApi }).argmax;
  });

  it("meters every window a login reported and leaves out the logins that reported none", () => {
    setCachedUsageRemaining(fresh(), null);

    renderPlans();

    const list = screen.getByLabelText("Remaining on your plans");
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => row.dataset.provider)).toEqual([
      "claude",
      "codex",
      "opencode",
      "grok"
    ]);
    // Cursor is Teams, with its remaining on a dashboard we cannot read.
    expect(within(list).queryByText("Cursor")).toBeNull();
    // Claude's three windows each carry their own figure.
    expect(within(rows[0]).getByText("5-hour")).toBeInTheDocument();
    expect(within(rows[0]).getByText("85%")).toBeInTheDocument();
    expect(within(rows[0]).getByText("54%")).toBeInTheDocument();
    expect(within(rows[0]).getByText("58%")).toBeInTheDocument();
  });

  it("keeps the menu as it was when no login reports a window", async () => {
    const empty = fresh({ providers: [] });
    setCachedUsageRemaining(empty, null);

    renderPlans();

    await waitFor(() => {
      expect(screen.queryByLabelText("Remaining on your plans")).toBeNull();
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("takes the reader to the Usage page", () => {
    setCachedUsageRemaining(fresh(), null);
    const onOpenUsage = vi.fn();

    renderPlans(onOpenUsage);
    fireEvent.click(screen.getByRole("button", { name: "Usage" }));

    expect(onOpenUsage).toHaveBeenCalledTimes(1);
  });

  it("re-reads the accounts only once the cached figures have aged", async () => {
    const read = stubRemaining(fresh());
    setCachedUsageRemaining(fresh(), null);

    renderPlans();
    await waitFor(() => {
      expect(screen.getByLabelText("Remaining on your plans")).toBeInTheDocument();
    });
    expect(read).not.toHaveBeenCalled();

    cleanup();
    setCachedUsageRemaining(
      usageRemainingFixture({ fetchedAt: new Date(Date.now() - 6 * 60_000).toISOString() }),
      null
    );
    renderPlans();

    await waitFor(() => {
      expect(read).toHaveBeenCalledTimes(1);
    });
  });
});
