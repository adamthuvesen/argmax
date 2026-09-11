import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  baseSession,
  event,
  renderConversation
} from "../../test/sessionConversationTestHarness.js";

const architectureSource = {
  id: "source-1",
  title: "Architecture",
  kind: "file",
  location: "docs/architecture.md",
  guidance: "Before runtime edits"
};

describe("SessionConversation project source session note", () => {
  afterEach(cleanup);

  it("keeps the latest thinking turn live when a source note follows it", () => {
    renderConversation(baseSession({ state: "running" }), [
      event("note", "session.note", "Read project source: Architecture", "2026-05-12T15:00:02.000Z", {
        operation: "project-source", action: "read", source: architectureSource
      }),
      event("thought", "message.delta", "Checking the current architecture", "2026-05-12T15:00:01.000Z", { thinking: true }),
      event("prompt", "user.message", "Check the architecture", "2026-05-12T15:00:00.000Z")
    ], { thinkingDisplay: "collapsed" });
    expect(screen.getByRole("button", { name: "Thinking" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Checking the current architecture")).toBeInTheDocument();
  });

  it("expands a read project source note with truncated retrieval details", () => {
    renderConversation(baseSession({ state: "complete" }), [
      event(
        "note",
        "session.note",
        "Project source note.",
        "2026-05-12T15:02:00.000Z",
        {
          operation: "project-source",
          action: "read",
          source: architectureSource,
          readAt: "2026-05-12T15:02:00.000Z",
          location: "/checkout/docs/architecture.md",
          truncated: true
        }
      ),
      event("answer", "message.completed", "Done", "2026-05-12T15:00:01.000Z")
    ]);

    const summary = screen.getByLabelText("Read project source: Architecture");
    expect(screen.getByRole("status")).toHaveTextContent("Read project source: Architecture");
    fireEvent.click(summary);

    expect(screen.getByText(/Only part of the content/)).toBeTruthy();
    expect(screen.getByText(/Retrieval does not verify/)).toBeTruthy();
    expect(screen.getByText("/checkout/docs/architecture.md")).toBeTruthy();
  });

  it("shows an added project source note without read verification copy", () => {
    renderConversation(baseSession({ state: "complete" }), [
      event(
        "note",
        "session.note",
        "Project source note.",
        "2026-05-12T15:02:00.000Z",
        {
          operation: "project-source",
          action: "added",
          source: architectureSource,
          at: "2026-05-12T15:02:00.000Z"
        }
      ),
      event("answer", "message.completed", "Done", "2026-05-12T15:00:01.000Z")
    ]);

    expect(screen.getByLabelText("Added project source: Architecture")).toBeTruthy();
    expect(
      screen.getByText(/Listed for future reference, not read or verified/ )
    ).toBeTruthy();
  });

  it("falls back to a generic message when project source payload lacks source id", () => {
    renderConversation(baseSession({ state: "complete" }), [
      event(
        "note",
        "session.note",
        "Project source note.",
        "2026-05-12T15:02:00.000Z",
        {
          operation: "project-source",
          action: "read",
          source: {
            title: "Architecture",
            kind: "file",
            location: "docs/architecture.md"
          },
          readAt: "2026-05-12T15:02:00.000Z"
        }
      ),
      event("answer", "message.completed", "Done", "2026-05-12T15:00:01.000Z")
    ]);

    expect(screen.queryByLabelText("Read project source: Architecture")).toBeNull();
    expect(screen.getByText("Project source note.")).toBeTruthy();
  });
});
