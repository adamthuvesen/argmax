import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi, Goal } from "../../shared/types.js";
import { baseSession, renderConversation } from "../../test/sessionConversationTestHarness.js";

function activeGoal(): Goal {
  return {
    id: "goal-1",
    workspaceId: "workspace-1",
    sessionId: "session-a",
    condition: "every test in test/auth passes",
    state: "active",
    turns: 2,
    maxTurns: 20,
    lastReason: null,
    createdAt: "2026-09-11T10:00:00.000Z",
    updatedAt: "2026-09-11T10:05:00.000Z"
  };
}

function prompt(): HTMLTextAreaElement {
  return screen.getByLabelText("Chat prompt");
}

function submit(draft: string): void {
  fireEvent.change(prompt(), { target: { value: draft } });
  fireEvent.mouseDown(document.body);
  fireEvent.keyDown(prompt(), { key: "Enter" });
}

const goals = {
  set: vi.fn<ArgmaxApi["goals"]["set"]>(),
  get: vi.fn<ArgmaxApi["goals"]["get"]>(),
  list: vi.fn<ArgmaxApi["goals"]["list"]>(),
  clear: vi.fn<ArgmaxApi["goals"]["clear"]>()
};

beforeEach(() => {
  Object.values(goals).forEach((method) => method.mockReset());
  goals.get.mockResolvedValue(null);
  goals.list.mockResolvedValue([]);
  goals.set.mockResolvedValue(null as never);
  goals.clear.mockResolvedValue(null);
  window.argmax = { ...(window.argmax ?? {}), goals } as unknown as ArgmaxApi;
});

afterEach(cleanup);

describe("SessionComposer goal", () => {
  it("sets a goal instead of sending the command as a message", async () => {
    const onSendSessionInput = vi.fn().mockResolvedValue(undefined);
    renderConversation(baseSession(), [], { onSendSessionInput });

    submit("/goal every test in test/auth passes");

    await waitFor(() =>
      expect(goals.set).toHaveBeenCalledWith(
        expect.objectContaining({ condition: "every test in test/auth passes" })
      )
    );
    // Setting a goal starts its own first turn; the composer must not send one too.
    expect(onSendSessionInput).not.toHaveBeenCalled();
    await waitFor(() => expect(prompt().value).toBe(""));
  });

  it("clears a goal with /goal clear", async () => {
    renderConversation(baseSession(), []);

    submit("/goal clear");

    await waitFor(() => expect(goals.clear).toHaveBeenCalled());
    expect(goals.set).not.toHaveBeenCalled();
  });

  it("sends a bare /goal on as an ordinary message", async () => {
    const onSendSessionInput = vi.fn().mockResolvedValue(undefined);
    renderConversation(baseSession(), [], { onSendSessionInput });

    submit("/goal");

    await waitFor(() => expect(onSendSessionInput).toHaveBeenCalled());
    expect(goals.set).not.toHaveBeenCalled();
  });

  // The phone shell hides this page's composer stack, so a goal bar inside it
  // is a goal nobody can stop from a phone.
  it("keeps the goal bar out of the composer stack when the host draws the composer", async () => {
    goals.get.mockResolvedValue(activeGoal());
    renderConversation(baseSession(), [], { nativeComposerFloor: true });

    const bar = await screen.findByRole("region", { name: "Goal" });
    expect(bar.closest("form")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Clear goal" }));
    await waitFor(() => expect(goals.clear).toHaveBeenCalledWith({ sessionId: "session-a" }));
  });

  it("tucks the goal bar into the composer this page draws itself", async () => {
    goals.get.mockResolvedValue(activeGoal());
    renderConversation(baseSession(), []);

    const bar = await screen.findByRole("region", { name: "Goal" });
    expect(bar.closest("form")).not.toBeNull();
  });

  it("leaves the draft alone when goals are switched off in settings", async () => {
    const onSendSessionInput = vi.fn().mockResolvedValue(undefined);
    renderConversation(baseSession(), [], { onSendSessionInput, goalEnabled: false });

    submit("/goal every test in test/auth passes");

    await waitFor(() => expect(onSendSessionInput).toHaveBeenCalled());
    expect(goals.set).not.toHaveBeenCalled();
  });
});
