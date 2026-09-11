import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { baseSession, renderConversation } from "../../test/sessionConversationTestHarness.js";

describe("SessionConversation — backfill", () => {
  afterEach(cleanup);

  it("holds the transcript unpainted until the backfill has landed", () => {
    renderConversation(baseSession(), [], { eventsBackfilled: false });

    expect(screen.getByRole("status")).toHaveTextContent("Loading chat…");
    const list = screen.getByLabelText("Conversation messages");
    expect(list.parentElement?.getAttribute("data-loading")).toBe("true");
  });

  it("paints and drops the status once the backfill is in", () => {
    renderConversation(baseSession(), [], { eventsBackfilled: true });

    expect(screen.queryByText("Loading chat…")).toBeNull();
    const list = screen.getByLabelText("Conversation messages");
    expect(list.parentElement?.hasAttribute("data-loading")).toBe(false);
  });
});
