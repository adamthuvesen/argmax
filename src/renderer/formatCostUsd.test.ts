// @vitest-environment node
import { describe, expect, it } from "vitest";
import { formatCostUsd } from "./formatCost.js";

describe("formatCostUsd", () => {
  it("renders $0.00 for zero, null, undefined, negative, NaN", () => {
    expect(formatCostUsd(0)).toBe("$0.00");
    expect(formatCostUsd(null)).toBe("$0.00");
    expect(formatCostUsd(undefined)).toBe("$0.00");
    expect(formatCostUsd(-1)).toBe("$0.00");
    expect(formatCostUsd(Number.NaN)).toBe("$0.00");
  });

  it("uses 3-decimal precision under $1", () => {
    expect(formatCostUsd(0.012)).toBe("$0.012");
    expect(formatCostUsd(0.999)).toBe("$0.999");
  });

  it("uses 2-decimal precision at $1 or above", () => {
    expect(formatCostUsd(1)).toBe("$1.00");
    expect(formatCostUsd(4.32)).toBe("$4.32");
    expect(formatCostUsd(123.456)).toBe("$123.46");
  });
});
