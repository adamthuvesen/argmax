import { describe, expect, it } from "vitest";

import { leadingSlashCommand } from "./slashHighlight.js";

describe("leadingSlashCommand", () => {
  it("returns null when the input is empty or has no slash", () => {
    expect(leadingSlashCommand("")).toBeNull();
    expect(leadingSlashCommand("hello there")).toBeNull();
  });

  it("returns null for a bare slash with no token yet", () => {
    expect(leadingSlashCommand("/")).toBeNull();
  });

  it("returns the token for a slash command with no args", () => {
    expect(leadingSlashCommand("/commit")).toBe("commit");
  });

  it("returns just the token when args follow", () => {
    expect(leadingSlashCommand("/commit all local changes")).toBe("commit");
  });

  it("keeps non-space punctuation in the token (flags, namespaces)", () => {
    expect(leadingSlashCommand("/code-review --fix")).toBe("code-review");
    expect(leadingSlashCommand("/hookify:help")).toBe("hookify:help");
  });

  it("returns null when whitespace precedes the slash or the token", () => {
    expect(leadingSlashCommand(" /commit")).toBeNull();
    expect(leadingSlashCommand("/ commit")).toBeNull();
  });
});
