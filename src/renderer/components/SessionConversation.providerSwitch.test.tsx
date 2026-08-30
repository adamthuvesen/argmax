import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  baseSession,
  event,
  renderConversation
} from "../../test/sessionConversationTestHarness.js";

// `events` reach the pane newest-first, matching the dashboard merge order.
describe("SessionConversation provider handoff", () => {
  afterEach(cleanup);

  it("shows the seam with both providers and the model taking over", () => {
    renderConversation(baseSession({ state: "complete", provider: "codex" }), [
      event("d2", "message.delta", "Picking this up", "2026-05-12T15:02:01.000Z"),
      event("switch", "session.provider-changed", "Switched provider to Codex.", "2026-05-12T15:02:00.000Z", {
        from: "cursor",
        provider: "codex",
        modelLabel: "GPT-5.6 Sol"
      }),
      event("d1", "message.delta", "Earlier work", "2026-05-12T15:00:01.000Z")
    ]);

    expect(screen.getByRole("status", { name: "Cursor → Codex, GPT-5.6 Sol" })).toBeTruthy();
  });

  it("falls back to the row's message when the payload predates the provider fields", () => {
    renderConversation(baseSession({ state: "complete", provider: "codex" }), [
      event("switch", "session.provider-changed", "Switched provider to Codex.", "2026-05-12T15:02:00.000Z"),
      event("d1", "message.delta", "Earlier work", "2026-05-12T15:00:01.000Z")
    ]);

    expect(screen.getByRole("status", { name: /Switched provider to Codex/ })).toBeTruthy();
  });

  it("ends the turn so work after the handoff is not folded into the old agent's", () => {
    renderConversation(baseSession({ state: "complete", provider: "codex" }), [
      event("after", "message.completed", "New agent answer", "2026-05-12T15:02:01.000Z"),
      event("switch", "session.provider-changed", "Switched provider to Codex.", "2026-05-12T15:02:00.000Z", {
        from: "cursor",
        provider: "codex",
        modelLabel: "GPT-5.6 Sol"
      }),
      event("before", "message.completed", "Old agent answer", "2026-05-12T15:00:01.000Z")
    ]);

    const seam = screen.getByRole("status", { name: "Cursor → Codex, GPT-5.6 Sol" });
    const before = screen.getByText("Old agent answer");
    const after = screen.getByText("New agent answer");
    // DOCUMENT_POSITION_FOLLOWING === 4: the seam sits between the two answers.
    expect(before.compareDocumentPosition(seam) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(seam.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
