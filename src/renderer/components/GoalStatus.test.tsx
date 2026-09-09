import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi, Goal, SessionSummary } from "../../shared/types.js";
import { defaultDashboardSnapshot } from "../../test/fixtures/dashboardSnapshot.js";
import { GoalStatus } from "./GoalStatus.js";

const session: SessionSummary = { ...defaultDashboardSnapshot.sessions[0], state: "running", attention: "normal" };

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "goal-1",
    workspaceId: session.workspaceId,
    sessionId: session.id,
    condition: "every test in test/auth passes",
    state: "active",
    turns: 3,
    maxTurns: 20,
    lastReason: "Two auth tests still fail on timeout.",
    createdAt: "2026-09-08T10:00:00.000Z",
    updatedAt: "2026-09-08T10:05:00.000Z",
    ...overrides
  };
}

const goals = {
  set: vi.fn<ArgmaxApi["goals"]["set"]>(),
  get: vi.fn<ArgmaxApi["goals"]["get"]>(),
  list: vi.fn<ArgmaxApi["goals"]["list"]>(),
  clear: vi.fn<ArgmaxApi["goals"]["clear"]>()
};

beforeEach(() => {
  Object.values(goals).forEach((method) => method.mockReset());
  goals.get.mockResolvedValue(goal());
  goals.clear.mockResolvedValue(goal({ state: "stopped" }));
  window.argmax = { goals } as unknown as ArgmaxApi;
});

afterEach(() => { delete (window as { argmax?: ArgmaxApi }).argmax; });

describe("GoalStatus", () => {
  it("reports the condition, the turn budget, and the evaluator's reason", async () => {
    render(<GoalStatus session={session} />);
    expect(await screen.findByText("every test in test/auth passes")).toBeInTheDocument();
    expect(screen.getByText("turn 3 of 20")).toBeInTheDocument();
    expect(screen.getByText("Two auth tests still fail on timeout.")).toBeInTheDocument();
  });

  it("shows nothing when the session has no goal", async () => {
    goals.get.mockResolvedValue(null);
    const { container } = render(<GoalStatus session={session} />);
    await waitFor(() => expect(goals.get).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("clears an active goal and stops showing it", async () => {
    render(<GoalStatus session={session} />);
    fireEvent.click(await screen.findByRole("button", { name: "Clear" }));
    await waitFor(() => expect(goals.clear).toHaveBeenCalledWith({ sessionId: session.id }));
    await waitFor(() => expect(screen.queryByText("every test in test/auth passes")).not.toBeInTheDocument());
  });

  it("keeps a met goal on screen until it is dismissed, without clearing it again", async () => {
    goals.get.mockResolvedValue(goal({ state: "achieved", lastReason: "All auth tests pass." }));
    render(<GoalStatus session={session} />);
    expect(await screen.findByText("Goal met")).toBeInTheDocument();
    expect(screen.queryByText(/turn \d+ of/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByText("Goal met")).not.toBeInTheDocument());
    expect(goals.clear).not.toHaveBeenCalled();
  });

  it("names an impossible goal rather than dropping it silently", async () => {
    goals.get.mockResolvedValue(goal({ state: "impossible", lastReason: "The referenced test file does not exist." }));
    render(<GoalStatus session={session} />);
    expect(await screen.findByText("Goal can't be met")).toBeInTheDocument();
    expect(screen.getByText("The referenced test file does not exist.")).toBeInTheDocument();
  });
});
