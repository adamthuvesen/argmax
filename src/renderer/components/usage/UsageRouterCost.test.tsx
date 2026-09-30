import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi, RouterCostSummary, RouterTierCost } from "../../../shared/types.js";
import { RouterCostCard } from "./UsageRouterCost.js";

function stubRouterCost(result: RouterCostSummary | null): ReturnType<typeof vi.fn> {
  const read = vi.fn().mockResolvedValue(result);
  (globalThis.window as unknown as { argmax: ArgmaxApi }).argmax = {
    usage: { routerCost: read }
  } as unknown as ArgmaxApi;
  return read;
}

function tier(overrides: Partial<RouterTierCost>): RouterTierCost {
  return {
    tier: "balanced",
    chats: 1,
    turns: 1,
    escalations: 0,
    reroutes: 0,
    measuredCostUsd: 0,
    estimatedCostUsd: 0,
    unpricedTurns: 0,
    models: [],
    decisions: [],
    medianTurnSeconds: null,
    medianFirstAnswerSeconds: null,
    ...overrides
  };
}

describe("RouterCostCard", () => {
  afterEach(() => {
    cleanup();
    delete (globalThis.window as unknown as { argmax?: ArgmaxApi }).argmax;
  });

  it("stays hidden when nothing was routed in the window", async () => {
    for (const result of [null, { tiers: [] }]) {
      const read = stubRouterCost(result);
      render(<RouterCostCard usageWindow="7d" visible />);
      await waitFor(() => expect(read).toHaveBeenCalledWith({ window: "7d" }));
      expect(screen.queryByRole("region", { name: "Router" })).toBeNull();
      cleanup();
    }
  });

  it("lists Frontier, Balance, Speed and Cost and marks estimated amounts", async () => {
    stubRouterCost({
      tiers: [
        tier({
          tier: "intelligence",
          chats: 2,
          turns: 4,
          escalations: 1,
          measuredCostUsd: 8,
          medianTurnSeconds: 84.4,
          medianFirstAnswerSeconds: 4.84,
          models: [
            { provider: "claude", modelId: "claude-opus-5-5", turns: 4, costUsd: 8, estimated: false }
          ]
        }),
        tier({ tier: "balanced", turns: 2, measuredCostUsd: 1 }),
        tier({
          tier: "cost",
          chats: 3,
          turns: 5,
          estimatedCostUsd: 0.5,
          unpricedTurns: 1,
          models: [
            { provider: "cursor", modelId: "composer-2.5", turns: 4, costUsd: 0.5, estimated: true },
            { provider: "cursor", modelId: "mystery-model", turns: 1, costUsd: 0, estimated: true }
          ]
        }),
        tier({ tier: "economy", chats: 1, turns: 2, measuredCostUsd: 0.02 })
      ]
    });

    render(<RouterCostCard usageWindow="24h" visible />);

    const table = await screen.findByRole("table", { name: "Router cost by tier" });
    const rows = within(table).getAllByRole("row").slice(1);
    const names = rows.map((row) => within(row).getByRole("rowheader").firstChild?.textContent);
    expect(names).toEqual(["Frontier", "Balance", "Speed", "Cost"]);

    // Frontier: measured only, so no ≈; $8 over 4 turns.
    expect(within(rows[0]).getByText("$8.00")).toBeInTheDocument();
    expect(within(rows[0]).getByText("$2.00")).toBeInTheDocument();
    // Medians: minutes past a minute, tenths under ten seconds, a dash with none.
    expect(within(rows[0]).getByText("1m 24s")).toBeInTheDocument();
    expect(within(rows[0]).getByText("4.8s")).toBeInTheDocument();
    expect(within(rows[1]).getAllByText("—")).toHaveLength(2);
    // Speed: an estimate, and the unpriced turn is left out of the per-turn figure.
    expect(within(rows[2]).getByText("≈$0.50")).toBeInTheDocument();
    expect(within(rows[2]).getByText("≈$0.13")).toBeInTheDocument();
    expect(within(rows[2]).getByText(/mystery-model ×1/)).toBeInTheDocument();
    expect(within(rows[2]).getByText("4/5 turns priced")).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "First activity" })).toBeInTheDocument();
  });

  it("expands grouped decisions with effort, classification, and the recorded reason", async () => {
    stubRouterCost({ tiers: [tier({
      turns: 4,
      decisions: [
        {
          provider: "claude", modelId: "claude-opus-5-5", reasoningEffort: "medium",
          kind: "coding", difficulty: "standard", decision: "kept",
          reason: "coding · standard; routes to Composer 2.5 on another provider, staying",
          count: 2, turns: 3
        },
        {
          provider: "claude", modelId: "claude-opus-5-5", reasoningEffort: "high",
          kind: null, difficulty: null, decision: "fallback",
          reason: "unrouted: classifier timeout", count: 1, turns: 1
        }
      ]
    })] });
    render(<RouterCostCard usageWindow="7d" visible />);
    const toggle = await screen.findByRole("button", { name: "Balance routing decisions" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("table", { name: "Balance routing decisions" })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const details = screen.getByRole("table", { name: "Balance routing decisions" });
    expect(within(details).getByText("Follow-up · kept")).toBeInTheDocument();
    expect(within(details).getByText(/routes to Composer 2.5 on another provider, staying/)).toBeInTheDocument();
    expect(within(details).getByText(/· medium/)).toBeInTheDocument();
    expect(within(details).getByText(/· high/)).toBeInTheDocument();
    expect(within(details).getByText("Launch · fallback")).toBeInTheDocument();
    expect(within(details).getByText("Not classified")).toBeInTheDocument();
    const cells = within(within(details).getAllByRole("row")[1]).getAllByRole("cell");
    expect(cells.slice(-2).map((cell) => cell.textContent)).toEqual(["2", "3"]);
    fireEvent.click(toggle);
    expect(screen.queryByRole("table", { name: "Balance routing decisions" })).toBeNull();
  });

  it("leaves costs unknown when none of the answered turns are priced", async () => {
    stubRouterCost({ tiers: [tier({ turns: 2, unpricedTurns: 2 })] });
    render(<RouterCostCard usageWindow="7d" visible />);
    const table = await screen.findByRole("table", { name: "Router cost by tier" });
    expect(within(table).getByText("0/2 turns priced")).toBeInTheDocument();
    expect(within(table).queryByText("$0.00")).toBeNull();
    expect(within(table).getAllByText("—")).toHaveLength(4);
  });
});
