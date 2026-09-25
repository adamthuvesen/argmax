import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { baseSession, event, renderConversation, rerenderConversation } from "../../test/sessionConversationTestHarness.js";

describe("SessionConversation — backfill", () => {
  afterEach(cleanup);

  it("holds the transcript unpainted until the backfill has landed", () => {
    renderConversation(baseSession(), [], { eventsBackfilled: false });

    expect(screen.getByRole("status", { name: "Loading chat" })).not.toHaveTextContent(/\S/);
    const list = screen.getByLabelText("Conversation messages");
    expect(list.parentElement?.getAttribute("data-loading")).toBe("true");
  });

  it("paints and drops the status once the backfill is in", () => {
    renderConversation(baseSession(), [], { eventsBackfilled: true });

    expect(screen.queryByRole("status", { name: "Loading chat" })).toBeNull();
    const list = screen.getByLabelText("Conversation messages");
    expect(list.parentElement?.hasAttribute("data-loading")).toBe(false);
  });

  it("keeps available and newly arriving replies visible after history retries fail", () => {
    const session = baseSession({ state: "running" });
    const events = [event("reply", "message.completed", "Already received", "2026-05-12T15:00:00.000Z")];
    const options = { eventsBackfilled: false, historyLoadFailed: true };
    const { rerender } = renderConversation(session, events, options);
    expect(screen.getByRole("status", { name: "Chat history unavailable" })).toBeInTheDocument();
    expect(screen.getByText("Already received")).toBeInTheDocument();
    expect(screen.getByLabelText("Conversation messages").parentElement).not.toHaveAttribute("data-loading");
    rerenderConversation(rerender, session, [
      event("new", "message.completed", "Still working", "2026-05-12T15:00:01.000Z"), ...events
    ], options);
    expect(screen.getByText("Still working")).toBeInTheDocument();
    expect(screen.getByLabelText("Conversation messages").parentElement).not.toHaveAttribute("data-loading");
  });
});
