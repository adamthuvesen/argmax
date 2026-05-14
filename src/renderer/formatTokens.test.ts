import { describe, expect, it } from "vitest";
import { formatTokens } from "./formatTokens.js";

describe("formatTokens", () => {
  it("renders zero and falsy as '0'", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(null)).toBe("0");
    expect(formatTokens(undefined)).toBe("0");
    expect(formatTokens(Number.NaN)).toBe("0");
  });

  it("floors sub-100 non-zero counts at '0.1k' so usage never collapses to '0k'", () => {
    expect(formatTokens(1)).toBe("0.1k");
    expect(formatTokens(50)).toBe("0.1k");
    expect(formatTokens(99)).toBe("0.1k");
  });

  it("renders 100–999 with one decimal in the k unit", () => {
    expect(formatTokens(100)).toBe("0.1k");
    expect(formatTokens(700)).toBe("0.7k");
    expect(formatTokens(999)).toBe("1k");
  });

  it("renders thousands with at most one decimal, dropping trailing .0", () => {
    expect(formatTokens(1_000)).toBe("1k");
    expect(formatTokens(1_234)).toBe("1.2k");
    expect(formatTokens(12_300)).toBe("12.3k");
    expect(formatTokens(12_000)).toBe("12k");
    expect(formatTokens(99_900)).toBe("99.9k");
    expect(formatTokens(100_000)).toBe("100k");
    expect(formatTokens(957_000)).toBe("957k");
  });

  it("renders millions and billions with at most one decimal", () => {
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(3_200_000)).toBe("3.2M");
    expect(formatTokens(15_000_000)).toBe("15M");
    expect(formatTokens(1_500_000_000)).toBe("1.5B");
  });

  it("preserves a negative sign rather than collapsing to zero", () => {
    expect(formatTokens(-500)).toBe("-0.5k");
    expect(formatTokens(-12_300)).toBe("-12.3k");
  });
});
