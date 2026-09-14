import { describe, expect, it } from "vitest";
import { formatResetIn } from "./usageFormat.js";

describe("formatResetIn", () => {
  it("keeps distant resets relative", () => {
    const now = new Date("2026-09-11T10:00:00.000Z");

    expect(formatResetIn("2026-09-28T12:46:05.845Z", now)).toBe("resets in 17d");
  });
});
