import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetLedgerPageStateForTests } from "../../lib/ledgerPageState.js";
import { ActivityPanel } from "./ActivityPanel.js";
import type { ActivitySummary, ActivitySummaryInput } from "./activityContract.js";
import { demoActivitySummary, type DemoActivityState } from "../../demoActivity.js";

/**
 * The page is exercised against its own fixture rather than against hand-built
 * literals: every card on it is an aggregation over one synthetic commit log,
 * and a per-test literal would let the hero, the heatmap and the cadence
 * disagree in a way the real backend never can.
 */
const summary = vi.fn<(input: ActivitySummaryInput) => Promise<ActivitySummary>>();

function serve(state: DemoActivityState = "normal"): void {
  summary.mockImplementation((input) => Promise.resolve(demoActivitySummary(input, state)));
}

/** The hero's own figure. "Commits" also names the metric switch in the topbar. */
function heroFigure(label: string): HTMLElement {
  return within(screen.getByRole("region", { name: "Summary" })).getByLabelText(label);
}

/**
 * How many days the heatmap drew. The cells' names live in SVG `<title>`
 * children, which Testing Library only reaches on a direct child of `<svg>`,
 * so the count is taken from the grid's published table — the accessible
 * version of the same 365 cells.
 */
function heatmapDays(): number {
  return within(screen.getByRole("table", { name: "Commits per day" })).getAllByRole("row").length;
}

/** Chooses an entry in an open picker menu. The row is the option; its button takes the click. */
function pickOption(name: string): void {
  fireEvent.click(within(screen.getByRole("option", { name })).getByRole("button"));
}

async function openActivity(): Promise<void> {
  render(<ActivityPanel />);
  await screen.findByRole("heading", { name: "Activity" });
  await waitFor(() => {
    expect(summary).toHaveBeenCalled();
  });
  await screen.findByRole("region", { name: "Summary" });
}

describe("ActivityPanel", () => {
  beforeEach(() => {
    resetLedgerPageStateForTests();
    summary.mockReset();
    serve();
    // The page reads the bridge when it is there and its fixture when it is
    // not, so the test drives the same path the packaged app does.
    window.argmax = { activity: { summary } } as unknown as typeof window.argmax;
  });

  afterEach(() => {
    cleanup();
    delete window.argmax;
  });

  it("opens on the last 30 days and says what the numbers cover", async () => {
    await openActivity();

    expect(summary).toHaveBeenCalledWith(
      expect.objectContaining({
        window: "30d",
        projectId: null,
        timeZone: expect.any(String) as unknown as string
      })
    );
    expect(screen.getByText("Aug 4 to Sep 2")).toBeInTheDocument();
    expect(screen.getByText("12 repositories")).toBeInTheDocument();
    // Which identity the commits were matched on: the difference between a
    // busy month and an empty page when a second email is in play.
    expect(screen.getByText("a.thuvesen@gmail.com")).toBeInTheDocument();
  });

  it("offers five windows including the calendar year, and asks for the one picked", async () => {
    await openActivity();

    fireEvent.click(screen.getByRole("button", { name: "Time range" }));
    const menu = screen.getByRole("listbox", { name: "Time range" });
    expect(within(menu).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Last 24 hours",
      "Last 7 days",
      "Last 30 days",
      "Last 12 months",
      String(new Date().getFullYear())
    ]);

    pickOption("Last 24 hours");

    expect(summary).toHaveBeenLastCalledWith(expect.objectContaining({ window: "24h" }));
    // Hourly buckets, so the range names hours rather than claiming days.
    expect(await screen.findByText(/Sep 2, 00:00 to Sep 3, 00:00/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Hourly commits by repository, 24 hours/ })).toBeInTheDocument();
  });

  it("labels the chart's axis by the window's own bucket, not by days", async () => {
    await openActivity();
    expect(screen.getByRole("img", { name: /Daily commits by repository, 30 days/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Time range" }));
    pickOption("Last 12 months");

    expect(summary).toHaveBeenLastCalledWith(expect.objectContaining({ window: "12m" }));
    expect(await screen.findByRole("img", { name: /Weekly commits by repository, 5[0-9] weeks/ })).toBeInTheDocument();
  });

  it("swaps the hero, the chart and the repository bars from commits to lines", async () => {
    await openActivity();
    // The figure itself rounds once it passes a million, so the exact count is
    // read off the title the hero carries for that reason.
    const commits = Number(heroFigure("Commits").title.replace(/[^0-9]/g, ""));
    expect(commits).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("radio", { name: "Lines" }));

    const lines = heroFigure("Lines changed");
    // Churn is added plus removed, so it dwarfs the commit count it replaced.
    expect(Number(lines.title.replace(/[^0-9]/g, ""))).toBeGreaterThan(commits);
    expect(
      within(screen.getByRole("region", { name: "Summary" })).queryByLabelText("Commits")
    ).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Daily lines by repository/ })).toBeInTheDocument();
    // The metric switch is a presentation change: it never re-reads the backend.
    expect(summary).toHaveBeenCalledTimes(1);
  });

  it("narrows to one repository from the picker, and the row it presses follows", async () => {
    await openActivity();
    const picker = screen.getByRole("button", { name: "Repository" });
    expect(picker).toHaveTextContent("All repositories");

    fireEvent.click(picker);
    pickOption("dbt-transform");

    await waitFor(() => {
      expect(summary).toHaveBeenLastCalledWith(
        expect.objectContaining({ window: "30d", projectId: "p-dbt" })
      );
    });
    expect(picker).toHaveTextContent("dbt-transform");
    const rows = await screen.findByRole("list", { name: "Commits by repository" });
    await waitFor(() => {
      expect(within(rows).getByRole("button", { name: /dbt-transform/ })).toHaveAttribute(
        "aria-pressed",
        "true"
      );
    });
    // The rows are the filter, so they keep every repository: a one-row table
    // is not the comparison the card exists for.
    expect(within(rows).getByRole("button", { name: /argmax/ })).toBeInTheDocument();

    fireEvent.click(within(rows).getByRole("button", { name: /argmax/ }));

    await waitFor(() => {
      expect(summary).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: "p-argmax" }));
    });
    expect(screen.getByRole("button", { name: "Repository" })).toHaveTextContent("argmax");
  });

  it("draws a cell for every day of the year with a summary a screen reader can read", async () => {
    await openActivity();

    expect(
      screen.getByRole("img", {
        name: /commits across .* active days in the 365 days ending Sep 2, 2026/
      })
    ).toBeInTheDocument();
    // One cell per day, each published with its own count and date.
    expect(heatmapDays()).toBe(365);
  });

  it("keeps the heatmap and the repository list whole while the page is narrowed", async () => {
    await openActivity();

    fireEvent.click(screen.getByRole("button", { name: "Repository" }));
    pickOption("dotfiles");

    await waitFor(() => {
      expect(summary).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: "p-dotfiles" }));
    });
    // The year and the ranking are the comparisons a filter would destroy.
    expect(heatmapDays()).toBe(365);
    const rows = screen.getByRole("list", { name: "Commits by repository" });
    expect(within(rows).getByRole("button", { name: /argmax/ })).toBeInTheDocument();
  });

  it("names each pull request's state without spending a column on it", async () => {
    await openActivity();

    const ledger = screen.getByRole("table", { name: "Pull requests you authored" });
    const merged = within(ledger).getAllByTitle("Merged");
    expect(merged.length).toBeGreaterThan(0);
    // An open row says how long it has been waiting rather than a cycle time
    // it does not have.
    expect(within(ledger).getAllByTitle("Open").length).toBeGreaterThan(0);
    expect(within(ledger).getAllByText(/so far/).length).toBeGreaterThan(0);
  });

  it("loses only the two GitHub cards when gh cannot answer", async () => {
    serve("nogh");
    await openActivity();

    const pulls = screen.getByRole("region", { name: "Pull requests" });
    expect(within(pulls).getByText("gh: not signed in to any GitHub hosts.")).toBeInTheDocument();
    expect(within(pulls).getAllByText(/gh auth login/).length).toBeGreaterThan(0);
    expect(within(pulls).queryByRole("table")).not.toBeInTheDocument();

    const reviews = screen.getByRole("region", { name: "Reviews given" });
    expect(within(reviews).getByText("gh: not signed in to any GitHub hosts.")).toBeInTheDocument();

    // Everything read out of the local clones is untouched.
    expect(heroFigure("Commits")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Repositories" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Cadence" })).toBeInTheDocument();
  });

  it("marks the numbers partial while the walk is still running", async () => {
    serve("scanning");
    await openActivity();

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Still walking your clones");
    expect(status).toHaveTextContent("4 of 12 repositories");
    expect(status).toHaveTextContent("These numbers are partial");
    // A window with no honest predecessor claims no comparison.
    expect(screen.queryByText(/vs the previous/)).not.toBeInTheDocument();
  });

  it("holds the page's own skeleton while the first walk has counted nothing", async () => {
    summary.mockImplementation((input) => {
      const partial = demoActivitySummary(input, "scanning");
      return Promise.resolve({
        ...partial,
        totals: { ...partial.totals, commits: 0, linesAdded: 0, linesRemoved: 0 },
        series: []
      });
    });
    render(<ActivityPanel />);

    // Awaited on the note rather than on the role: the page's opening
    // skeleton already answers to that role, so a bare `findByRole` resolves
    // before the read has landed and the assertion below tests nothing.
    expect(await screen.findByText(/Walking your clones/)).toBeInTheDocument();
    const status = screen.getByRole("status", { name: "Loading activity" });
    expect(status).toHaveTextContent("4 of 12 repositories");
  });

  it("says there is nothing to read rather than drawing twelve empty cards", async () => {
    serve("empty");
    render(<ActivityPanel />);

    expect(await screen.findByText("No repositories to read yet.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Summary" })).not.toBeInTheDocument();
  });

  it("reuses a cached summary on remount instead of skeletoning again", async () => {
    const { unmount } = render(<ActivityPanel />);
    await screen.findByRole("region", { name: "Summary" });
    expect(summary).toHaveBeenCalledTimes(1);

    unmount();
    summary.mockClear();
    render(<ActivityPanel />);

    expect(screen.getByRole("region", { name: "Summary" })).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Loading activity" })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(summary).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps the page offerable when the read fails", async () => {
    summary.mockRejectedValue(new Error("git log failed in ~/dev/argmax."));
    render(<ActivityPanel />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("git log failed in ~/dev/argmax.");

    serve();
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("region", { name: "Summary" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
