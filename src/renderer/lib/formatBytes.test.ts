import { describe, expect, it } from "vitest";
import { formatBytes } from "./formatBytes.js";

describe("formatBytes", () => {
  it("renders zero and negatives as '0 B'", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-1)).toBe("0 B");
  });

  it("renders the byte tier as integers", () => {
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("crosses to KB at 1024 and uses one decimal", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 * 1.5)).toBe("1.5 KB");
  });

  it("crosses to MB at one mebibyte", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1024 * 1024 * 2.5)).toBe("2.5 MB");
  });

  it("crosses to GB at one gibibyte", () => {
    expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
    expect(formatBytes(1024 ** 3 * 1.25)).toBe("1.3 GB");
  });

  it("drops the decimal once the value is >= 100 in its unit", () => {
    expect(formatBytes(1024 * 250)).toBe("250 KB");
    expect(formatBytes(1024 * 1024 * 999)).toBe("999 MB");
  });
});
