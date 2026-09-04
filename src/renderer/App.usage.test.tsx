import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App.js";
import { setupAppTestMocks, usageSummary, usageSummaryFixture } from "../test/appTestHarness.js";

async function openUsage(): Promise<void> {
  render(<App />);
  await screen.findByRole("button", { name: "Build dashboard" });
  fireEvent.click(screen.getByRole("button", { name: "Usage" }));
  await screen.findByRole("heading", { name: "Usage" });
}

describe("App usage", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    setupAppTestMocks();
  });

  it("opens as a standalone page and yields the sidebar column to a back rail", async () => {
    await openUsage();

    expect(screen.getByRole("complementary", { name: "Usage" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Build dashboard" })).not.toBeInTheDocument();
    expect(await screen.findByText("Aug 4 to Sep 2")).toBeInTheDocument();

    const rail = screen.getByRole("complementary", { name: "Usage" });
    fireEvent.click(within(rail).getByRole("button", { name: "Back" }));

    expect(await screen.findByRole("button", { name: "Build dashboard" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Usage" })).not.toBeInTheDocument();
  });

  it("asks the backend for the window the user picked and relabels the range", async () => {
    await openUsage();
    expect(usageSummary).toHaveBeenCalledWith(
      expect.objectContaining({ window: "30d", timeZone: expect.any(String) as unknown as string })
    );

    fireEvent.click(screen.getByRole("radio", { name: "7 days" }));

    expect(await screen.findByText("Aug 27 to Sep 2")).toBeInTheDocument();
    expect(usageSummary).toHaveBeenCalledWith(expect.objectContaining({ window: "7d" }));
    expect(screen.queryByText("Aug 4 to Sep 2")).not.toBeInTheDocument();
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

  it("compares the window with the one before it, and says nothing when there is nothing to compare", async () => {
    await openUsage();

    // $100 against the previous window's $74.50. The chip is the parent of
    // the "vs …" clause; the direction is a word for a reader who cannot see
    // the caret.
    const chip = (await screen.findByText(/vs the previous 30 days/)).parentElement;
    expect(chip).toHaveTextContent("34%");
    expect(chip).toHaveTextContent("up");

  });

  it("claims no comparison when the ledger does not reach back a whole window", async () => {
    // Otherwise a first install reads as an infinite rise off zero.
    usageSummary.mockResolvedValue(usageSummaryFixture({ previous: null }));
    await openUsage();

    expect(await screen.findByLabelText("Total cost")).toHaveTextContent("$100.00");
    expect(screen.queryByText(/vs the previous/)).not.toBeInTheDocument();
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
});
