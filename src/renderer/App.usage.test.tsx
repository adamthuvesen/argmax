import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App.js";
import {
  setCachedUsageRemaining,
  setCachedUsageSummary
} from "./lib/ledgerPageState.js";
import { resetLedgerPrefetchForTests } from "./lib/ledgerPrefetch.js";
import {
  setupAppTestMocks,
  usageRemaining,
  usageRemainingFixture,
  usageSummary,
  usageSummaryFixture
} from "../test/appTestHarness.js";

/** Chooses an entry in an open picker menu. The row is the option; its button takes the click. */
function pickOption(name: string): void {
  fireEvent.click(within(screen.getByRole("option", { name })).getByRole("button"));
}

/** Opens Hacking from the sidebar, then crosses to Usage on its rail. */
function crossToUsage(): void {
  fireEvent.click(screen.getByRole("button", { name: "Hacking" }));
  const rail = screen.getByRole("complementary", { name: "Hacking" });
  fireEvent.click(within(rail).getByRole("button", { name: "Usage" }));
}

/**
 * The parked Activity view stays mounted beside Usage and words some of its
 * numbers the same way ("vs the previous 30 days"), so anything that reads a
 * date or a comparison has to say which page it means.
 */
function usagePage(): HTMLElement {
  return screen.getByRole("heading", { name: "Usage" }).closest(".usage-page") as HTMLElement;
}

async function openUsage(): Promise<void> {
  render(<App />);
  await screen.findByRole("button", { name: "Build dashboard" });
  crossToUsage();
  await screen.findByRole("heading", { name: "Usage" });
}

describe("App usage", () => {
  afterEach(() => {
    cleanup();
    resetLedgerPrefetchForTests();
  });

  beforeEach(() => {
    setupAppTestMocks();
  });

  it("opens as a standalone page and yields the sidebar column to a back rail", async () => {
    await openUsage();

    expect(screen.getByRole("complementary", { name: "Hacking" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Build dashboard" })).not.toBeInTheDocument();
    expect(await screen.findByText("Aug 4 to Sep 2")).toBeInTheDocument();

    const rail = screen.getByRole("complementary", { name: "Hacking" });
    fireEvent.click(within(rail).getByRole("button", { name: "Back" }));

    expect(await screen.findByRole("button", { name: "Build dashboard" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Usage" })).not.toBeInTheDocument();
  });

  it("asks the backend for the window the user picked and relabels the range", async () => {
    await openUsage();
    expect(usageSummary).toHaveBeenCalledWith(
      expect.objectContaining({ window: "30d", timeZone: expect.any(String) as unknown as string })
    );

    fireEvent.click(screen.getByRole("button", { name: "Time range" }));
    pickOption("Last 7 days");

    expect(await within(usagePage()).findByText("Aug 27 to Sep 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Time range" })).toHaveTextContent("Last 7 days");
    expect(usageSummary).toHaveBeenCalledWith(expect.objectContaining({ window: "7d" }));
    expect(within(usagePage()).queryByText("Aug 4 to Sep 2")).not.toBeInTheDocument();
  });

  it("swaps the hero from dollars to tokens", async () => {
    await openUsage();
    expect(screen.getByLabelText("Total cost")).toHaveTextContent("$100.00");

    fireEvent.click(screen.getByRole("radio", { name: "Tokens" }));

    expect(await screen.findByLabelText("Total tokens")).toHaveTextContent("2.1M");
    expect(screen.queryByLabelText("Total cost")).not.toBeInTheDocument();
  });

  it("says the first scan is still running and that the numbers are partial", async () => {
    usageSummary.mockResolvedValue(
      usageSummaryFixture({
        scan: {
          phase: "scanning",
          filesTotal: 5312,
          filesDone: 1974,
          lastCompletedAt: null,
          pricingAsOf: "2026-09-01"
        }
      })
    );
    await openUsage();

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Still scanning");
    expect(status).toHaveTextContent("1,974 of 5,312 files");
    expect(status).toHaveTextContent("These numbers are partial");
  });

  it("badges an unpriced model and keeps it out of the cost share", async () => {
    await openUsage();

    const table = await screen.findByRole("table", { name: "Usage by model" });
    const unpriced = within(table).getByRole("row", { name: /codex-auto-review/ });
    expect(within(unpriced).getByText("Unpriced")).toBeInTheDocument();
    // 60 of the 100 priced dollars, not of the 100 plus an unpriced row's $0.
    const opus = within(table).getByRole("row", { name: /claude-opus-5/ });
    const terra = within(table).getByRole("row", { name: /gpt-5\.6-terra/ });
    expect(within(opus).getByText("60.0%")).toBeInTheDocument();
    expect(within(terra).getByText("40.0%")).toBeInTheDocument();
    // The unpriced row claims no share at all rather than a confident 0.0%.
    expect(within(unpriced).getByText("—")).toBeInTheDocument();
  });

  it("publishes the chart's numbers as a table", async () => {
    await openUsage();

    const chart = screen.getByRole("img", { name: /Daily cost by provider/ });
    expect(chart).toHaveAttribute("tabindex", "0");

    const data = screen.getByRole("table", { name: "Daily cost by provider" });
    const row = within(data).getByRole("row", { name: /Sep 1, 2026/ });
    expect(within(row).getByText("$30.00")).toBeInTheDocument();
    expect(within(row).getByText("$12.00")).toBeInTheDocument();
  });

  it("narrows the page to a provider when its row is pressed and widens on the second press", async () => {
    await openUsage();
    const rows = await screen.findByRole("list", { name: "Usage by provider" });
    const claude = within(rows).getByRole("button", { name: /Claude/ });
    expect(claude).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(claude);

    expect(usageSummary).toHaveBeenCalledWith(expect.objectContaining({ window: "30d", provider: "claude" }));
    expect(await screen.findByLabelText("Total cost")).toHaveTextContent("$60.00");
    expect(claude).toHaveAttribute("aria-pressed", "true");
    // The rows are the filter, so they keep every provider and their whole-window shares.
    // The share is stated bare: the bar under the row is what says "of cost".
    expect(within(rows).getByRole("button", { name: /Codex/ })).toHaveTextContent("40.0%");
    const table = screen.getByRole("table", { name: "Usage by model" });
    expect(within(table).queryByRole("row", { name: /gpt-5\.6-terra/ })).not.toBeInTheDocument();
    expect(within(table).getByRole("row", { name: /claude-opus-5/ })).toBeInTheDocument();
    // Cursor has nothing to narrow to, so it is not a button.
    expect(within(rows).queryByRole("button", { name: /Cursor/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show all" }));

    expect(usageSummary).toHaveBeenLastCalledWith(expect.objectContaining({ provider: null }));
    expect(await screen.findByLabelText("Total cost")).toHaveTextContent("$100.00");
    expect(within(rows).getByRole("button", { name: /Claude/ })).toHaveAttribute("aria-pressed", "false");
  });

  it("narrows the page from the provider picker, and the picker follows a row press", async () => {
    await openUsage();
    const picker = screen.getByRole("button", { name: "Provider" });
    expect(picker).toHaveTextContent("All providers");

    fireEvent.click(picker);
    // Cursor keeps no local usage, so it is listed but cannot be chosen.
    expect(screen.getByRole("option", { name: "Cursor" })).toHaveAttribute("aria-disabled", "true");
    pickOption("Codex");

    expect(usageSummary).toHaveBeenLastCalledWith(expect.objectContaining({ provider: "codex" }));
    expect(await screen.findByLabelText("Total cost")).toHaveTextContent("$40.00");
    expect(picker).toHaveTextContent("Codex");
    const rows = screen.getByRole("list", { name: "Usage by provider" });
    expect(within(rows).getByRole("button", { name: /Codex/ })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(within(rows).getByRole("button", { name: /Claude/ }));

    expect(usageSummary).toHaveBeenLastCalledWith(expect.objectContaining({ provider: "claude" }));
    expect(await screen.findByLabelText("Total cost")).toHaveTextContent("$60.00");
    expect(picker).toHaveTextContent("Claude");
  });

  it("compares the window with the one before it, and says nothing when there is nothing to compare", async () => {
    await openUsage();

    // $100 against the previous window's $74.50. The chip is the parent of
    // the "vs …" clause; the direction is a word for a reader who cannot see
    // the caret.
    const chip = (await within(usagePage()).findByText(/vs the previous 30 days/)).parentElement;
    expect(chip).toHaveTextContent("34%");
    expect(chip).toHaveTextContent("up");

  });

  it("claims no comparison when the ledger does not reach back a whole window", async () => {
    // Otherwise a first install reads as an infinite rise off zero.
    usageSummary.mockResolvedValue(usageSummaryFixture({ previous: null }));
    await openUsage();

    expect(await screen.findByLabelText("Total cost")).toHaveTextContent("$100.00");
    expect(within(usagePage()).queryByText(/vs the previous/)).not.toBeInTheDocument();
  });

  it("breaks the tokens into their four parts and names what the cache saved", async () => {
    await openUsage();

    const flow = await screen.findByRole("region", { name: "Where the tokens went" });
    // Processed tokens are the sum of the four, so the parts carry percentages
    // of one whole rather than four unrelated totals.
    expect(within(flow).getByText("Cache read")).toBeInTheDocument();
    expect(within(flow).getByText("Cache written")).toBeInTheDocument();
    expect(within(flow).getByText("Uncached input")).toBeInTheDocument();
    expect(within(flow).getByText("Output")).toBeInTheDocument();
    expect(within(flow).getByText("$4.35")).toBeInTheDocument();
  });

  it("sorts the breakdown by whichever column is asked for", async () => {
    await openUsage();

    const table = await screen.findByRole("table", { name: "Usage by model" });
    const costHeader = within(table).getByRole("columnheader", { name: /Cost/ });
    const sessionsHeader = within(table).getByRole("columnheader", { name: /Sessions/ });
    // The page opens ranked by the metric it is showing.
    expect(costHeader).toHaveAttribute("aria-sort", "descending");
    expect(sessionsHeader).toHaveAttribute("aria-sort", "none");

    fireEvent.click(within(table).getByRole("button", { name: "Sort by Sessions" }));

    expect(sessionsHeader).toHaveAttribute("aria-sort", "descending");
    expect(costHeader).toHaveAttribute("aria-sort", "none");

    // The active column reverses rather than re-sorting the same way.
    fireEvent.click(within(table).getByRole("button", { name: "Sort by Sessions" }));
    expect(sessionsHeader).toHaveAttribute("aria-sort", "ascending");
  });

  it("says Cursor has no local usage source instead of showing it $0", async () => {
    await openUsage();

    const rows = await screen.findByRole("list", { name: "Usage by provider" });
    const cursor = within(rows).getByText("Cursor").closest("li");
    expect(cursor).not.toBeNull();
    expect(within(cursor as HTMLElement).getByText("No local usage data")).toBeInTheDocument();
    expect(within(cursor as HTMLElement).queryByText("$0.00")).not.toBeInTheDocument();
  });

  it("shows remaining usage per provider under the local spend", async () => {
    await openUsage();

    const remaining = await screen.findByRole("region", { name: "Remaining on your plans" });
    expect(within(remaining).getByText("Max 20x")).toBeInTheDocument();
    expect(within(remaining).getByText("85% left")).toBeInTheDocument();
    expect(within(remaining).getAllByText("5-hour").length).toBeGreaterThan(0);

    const cursor = within(remaining).getByText("Cursor").closest("li");
    expect(cursor).not.toBeNull();
    expect(within(cursor as HTMLElement).getByText("Teams")).toBeInTheDocument();
    expect(within(cursor as HTMLElement).queryByText(/% left/)).not.toBeInTheDocument();
  });

  it("holds the skeleton until both reads land, so the page arrives in one piece", async () => {
    let landRemaining = (): void => {};
    usageRemaining.mockImplementation(
      () =>
        new Promise((resolve) => {
          landRemaining = () => resolve(usageRemainingFixture());
        })
    );
    await openUsage();
    await waitFor(() => {
      expect(usageSummary).toHaveBeenCalled();
    });
    // Let the ledger's promise settle into state: it has landed, and it still
    // waits for the card below it.
    await act(async () => {});

    expect(screen.getByRole("status", { name: "Loading usage" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Total cost")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Remaining on your plans" })).not.toBeInTheDocument();

    landRemaining();

    expect(await screen.findByLabelText("Total cost")).toHaveTextContent("$100.00");
    expect(screen.getByRole("region", { name: "Remaining on your plans" })).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Loading usage" })).not.toBeInTheDocument();
  });

  it("keeps the local spend up when remaining usage fails", async () => {
    usageRemaining.mockRejectedValue(new Error("Claude remaining usage returned HTTP 429."));
    await openUsage();

    expect(await screen.findByLabelText("Total cost")).toHaveTextContent("$100.00");
    const remaining = await screen.findByRole("region", { name: "Remaining on your plans" });
    expect(within(remaining).getByText("Claude remaining usage returned HTTP 429.")).toBeInTheDocument();
  });

  it("opens the ledger without skeleton when boot prefetch warmed the cache", async () => {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    setCachedUsageSummary("30d", null, timeZone, usageSummaryFixture());
    setCachedUsageRemaining(usageRemainingFixture(), null);

    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });
    crossToUsage();

    expect(await screen.findByLabelText("Total cost")).toHaveTextContent("$100.00");
    expect(screen.queryByRole("status", { name: "Loading usage" })).not.toBeInTheDocument();
  });

  it("reopens with the last numbers instead of skeletoning again", async () => {
    await openUsage();
    const usagePage = screen
      .getByRole("heading", { name: "Usage" })
      .closest(".usage-page") as HTMLElement;
    expect(await within(usagePage).findByText("Aug 4 to Sep 2")).toBeInTheDocument();

    const rail = screen.getByRole("complementary", { name: "Hacking" });
    fireEvent.click(within(rail).getByRole("button", { name: "Back" }));
    await screen.findByRole("button", { name: "Build dashboard" });

    usageSummary.mockClear();
    crossToUsage();

    const reopened = screen
      .getByRole("heading", { name: "Usage" })
      .closest(".usage-page") as HTMLElement;
    expect(within(reopened).getByText("Aug 4 to Sep 2")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Loading usage" })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(usageSummary).toHaveBeenCalledTimes(1);
    });
  });

  it("refreshes remaining usage without asking for a new summary", async () => {
    await openUsage();
    await screen.findByRole("region", { name: "Remaining on your plans" });
    usageSummary.mockClear();
    usageRemaining.mockClear();
    usageRemaining.mockResolvedValue(usageRemainingFixture());

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByText("Max 20x")).toBeInTheDocument();
    expect(usageRemaining).toHaveBeenCalled();
    expect(usageSummary).not.toHaveBeenCalled();
  });
});
