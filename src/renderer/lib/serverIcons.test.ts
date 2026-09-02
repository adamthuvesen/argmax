import { describe, expect, it } from "vitest";
import { serverIconFor } from "./serverIcons.js";

describe("serverIconFor", () => {
  it("maps the server names parseMcpToolName yields, whatever the casing or separators", () => {
    expect(serverIconFor("Slack")?.title).toBe("Slack");
    expect(serverIconFor("google_drive")?.title).toBe("Google Drive");
    expect(serverIconFor("Google Calendar")?.title).toBe("Google Calendar");
    expect(serverIconFor("snowflake")?.layers).toEqual([expect.objectContaining({ fill: "#29B5E8" })]);
    expect(serverIconFor("spotify")?.layers).toEqual([expect.objectContaining({ fill: "#1ED760" })]);
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

  it("draws Argmax's own tools as the mascot's head in the fox tokens", () => {
    const icon = serverIconFor("argmax");
    expect(icon?.title).toBe("Argmax");
    expect(icon?.viewBox).toBe("24 0 28 24");
    const fills = icon?.layers.map((layer) => layer.fill);
    expect(fills).toContain("var(--fox-fur)");
    expect(fills).toContain("var(--fox-nose)");
    // The nose sits in the muzzle, inside the head crop.
    expect(icon?.layers.find((layer) => layer.fill === "var(--fox-nose)")?.path).toMatch(/^M4[0-9] 2[0-9]h/);
  });

  it("returns null for a server with no mark wired up", () => {
    expect(serverIconFor("hex")).toBeNull();
    expect(serverIconFor("browser use")).toBeNull();
  });
});
