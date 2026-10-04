import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { baseSession, renderConversation } from "../../test/sessionConversationTestHarness.js";

describe("SessionConversation — header", () => {
  afterEach(cleanup);

  it("keeps chat actions without repeating the repository and chat title", () => {
    renderConversation(baseSession());

    expect(screen.getByRole("button", { name: "Chat actions" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Argmax" })).toBeNull();
    expect(screen.queryByTitle("Build dashboard")).toBeNull();
  });
});
