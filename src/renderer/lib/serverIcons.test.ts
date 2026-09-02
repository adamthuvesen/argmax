import { describe, expect, it } from "vitest";
import { serverIconFor } from "./serverIcons.js";

describe("serverIconFor", () => {
  it("maps the server names parseMcpToolName yields, whatever the casing or separators", () => {
    expect(serverIconFor("Slack")?.title).toBe("Slack");
    expect(serverIconFor("google_drive")?.title).toBe("Google Drive");
    expect(serverIconFor("Google Calendar")?.title).toBe("Google Calendar");
    expect(serverIconFor("snowflake")?.hex).toBe("29B5E8");
  });

  it("gives black marks no brand colour so they take the row's text colour", () => {
    expect(serverIconFor("notion")?.hex).toBeNull();
    expect(serverIconFor("github")?.hex).toBeNull();
  });

  it("returns null for a server with no mark wired up", () => {
    expect(serverIconFor("hex")).toBeNull();
    expect(serverIconFor("browser use")).toBeNull();
  });
});
