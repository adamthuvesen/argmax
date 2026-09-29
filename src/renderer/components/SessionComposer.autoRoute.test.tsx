import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  baseSession,
  renderConversation,
  rerenderConversation
} from "../../test/sessionConversationTestHarness.js";

const routedSession = baseSession({
  provider: "claude",
  modelLabel: "Opus 5.5",
  modelId: "claude-opus-5-5",
  reasoningEffort: "medium",
  autoTier: "balanced",
  autoRoute: "coding · standard"
});

describe("SessionComposer Auto chip", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(cleanup);

  it("names the tier and the routed model, with the reason on hover", () => {
    renderConversation(routedSession);

    const chip = screen.getByRole("button", { name: "Chat model" });
    expect(chip.textContent).toBe("Balance → Opus 5.5");
    expect(chip).toHaveAttribute("title", "coding · standard");
    expect(screen.getByRole("button", { name: "Chat model effort" }).textContent).toBe("Medium");
  });

  it("reads plainly once a different model is picked, which pins the chat", () => {
    renderConversation(routedSession);

    fireEvent.click(screen.getByRole("button", { name: "Chat model" }));
    fireEvent.click(
      within(screen.getByRole("listbox", { name: "Chat model" })).getByRole("button", { name: "Sonnet 5.5" })
    );

    expect(screen.getByRole("button", { name: "Chat model" }).textContent).toBe("Sonnet 5.5");
  });

  it("offers no Auto rows in the follow-up picker", () => {
    renderConversation(routedSession);

    fireEvent.click(screen.getByRole("button", { name: "Chat model" }));

    expect(
      within(screen.getByRole("listbox", { name: "Chat model" })).queryByRole("button", { name: "Router Balance" })
    ).toBeNull();
  });

  it("follows a re-route, so the next follow-up does not pin the old model", async () => {
    const onSendSessionInput = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderConversation(routedSession, [], { onSendSessionInput });

    const escalated = { ...routedSession, modelLabel: "Fable 5.1", modelId: "claude-fable-5-1", reasoningEffort: "high" as const };
    rerenderConversation(rerender, escalated, [], { onSendSessionInput });

    expect(screen.getByRole("button", { name: "Chat model" }).textContent).toBe("Balance → Fable 5.1");
    const promptInput = screen.getByLabelText("Chat prompt");
    fireEvent.change(promptInput, { target: { value: "keep going" } });
    fireEvent.keyDown(promptInput, { key: "Enter" });

    await waitFor(() => expect(onSendSessionInput).toHaveBeenCalled());
    expect(onSendSessionInput.mock.calls[0]?.[2]).toMatchObject({ provider: "claude", modelId: "claude-fable-5-1", reasoningEffort: "high", autoTier: "balanced" });
  });

  it("says why when the router switches the chat, until the next draft starts", () => {
    const { rerender } = renderConversation(routedSession);
    expect(screen.queryByText("coding · heavy; confident upgrade")).toBeNull();

    const upgraded = {
      ...routedSession,
      modelLabel: "Fable 5.1",
      modelId: "claude-fable-5-1",
      reasoningEffort: "high" as const,
      autoRoute: "coding · heavy; confident upgrade"
    };
    rerenderConversation(rerender, upgraded);

    // The chip reads the new route from the first frame of the switch.
    expect(screen.getByRole("button", { name: "Chat model" }).textContent).toBe("Balance → Fable 5.1");
    expect(screen.getByRole("button", { name: "Chat model effort" }).textContent).toBe("High");
    expect(screen.getByText("coding · heavy; confident upgrade").closest("[role='status']")).not.toBeNull();

    fireEvent.change(screen.getByLabelText("Chat prompt"), { target: { value: "n" } });
    expect(screen.queryByText("coding · heavy; confident upgrade")).toBeNull();
  });

  it("names the router's pick once when a routed chat has just launched", () => {
    const launched = baseSession({ ...routedSession, id: "session-fresh", startedAt: new Date().toISOString() });
    renderConversation(launched);

    expect(screen.getByRole("button", { name: "Chat model" }).textContent).toBe("Balance → Opus 5.5");
    expect(screen.getByText("coding · standard").closest("[role='status']")).not.toBeNull();
  });

  it("says nothing for the route a chat opened with, or for a pin", () => {
    const { rerender } = renderConversation(routedSession);
    const pinned = { ...routedSession, modelLabel: "Sonnet 5.5", modelId: "claude-sonnet-5-5", autoTier: null, autoRoute: null };
    rerenderConversation(rerender, pinned);

    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps the user's own pick when the chat is re-routed", async () => {
    const onSendSessionInput = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderConversation(routedSession, [], { onSendSessionInput });
    fireEvent.click(screen.getByRole("button", { name: "Chat model" }));
    fireEvent.click(
      within(screen.getByRole("listbox", { name: "Chat model" })).getByRole("button", { name: "Sonnet 5.5" })
    );

    const escalated = { ...routedSession, modelLabel: "Fable 5.1", modelId: "claude-fable-5-1", reasoningEffort: "high" as const };
    rerenderConversation(rerender, escalated, [], { onSendSessionInput });

    expect(screen.getByRole("button", { name: "Chat model" }).textContent).toBe("Sonnet 5.5");
    const promptInput = screen.getByLabelText("Chat prompt");
    fireEvent.change(promptInput, { target: { value: "keep going" } });
    fireEvent.keyDown(promptInput, { key: "Enter" });

    await waitFor(() => expect(onSendSessionInput).toHaveBeenCalled());
    expect(onSendSessionInput.mock.calls[0]?.[2]).toMatchObject({ modelId: "claude-sonnet-5-5" });
    expect(onSendSessionInput.mock.calls[0]?.[2]).not.toHaveProperty("autoTier");
  });
});
