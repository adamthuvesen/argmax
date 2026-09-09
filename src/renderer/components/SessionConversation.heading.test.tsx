import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { baseSession, renderConversation, workspace } from "../../test/sessionConversationTestHarness.js";

describe("SessionConversation — header", () => {
  afterEach(cleanup);

  it("reads as a path: the repository, then this chat's title", () => {
    renderConversation(baseSession());

    expect(screen.getByRole("heading", { name: "Argmax" })).toBeTruthy();
    expect(screen.getByTitle("Build dashboard")).toBeTruthy();
  });

  it("shows the repository alone until the chat has a title", () => {
    renderConversation(baseSession(), [], { workspace: { ...workspace, taskLabel: "  " } });

    expect(screen.getByRole("heading", { name: "Argmax" })).toBeTruthy();
    // No title, so no path separator either — the strip is just the repo.
    expect(screen.queryByText("/")).toBeNull();
  });
});
