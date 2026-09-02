import { describe, expect, it } from "vitest";
import { serverIconFor } from "./serverIcons.js";

describe("serverIconFor", () => {
  it("maps the server names parseMcpToolName yields, whatever the casing or separators", () => {
    expect(serverIconFor("Slack")?.title).toBe("Slack");
    expect(serverIconFor("google_drive")?.title).toBe("Google Drive");
    expect(serverIconFor("Google Calendar")?.title).toBe("Google Calendar");
    expect(serverIconFor("snowflake")?.layers).toEqual([expect.objectContaining({ fill: "#29B5E8" })]);
  });

  it("gives black marks no fill so they take the row's text colour", () => {
    expect(serverIconFor("notion")?.layers[0]?.fill).toBeNull();
    expect(serverIconFor("github")?.layers[0]?.fill).toBeNull();
  });

  it("keeps the multi-coloured Google marks in their own colours", () => {
    const fills = serverIconFor("gmail")?.layers.map((layer) => layer.fill);
    expect(fills).toContain("#EA4335");
    expect(fills).toContain("#34A853");
  });

  it("returns null for a server with no mark wired up", () => {
    expect(serverIconFor("hex")).toBeNull();
    expect(serverIconFor("browser use")).toBeNull();
  });
});
