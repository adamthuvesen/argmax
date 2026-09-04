// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "./logger.js";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.DEBUG;
});

describe("logger", () => {
  it("mirrors errors to console regardless of DEBUG", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    logger.error("crash", "explosion", { code: "ENOENT" });
    expect(error).toHaveBeenCalledWith("[crash] explosion", { code: "ENOENT" });
  });

  it("mirrors non-error levels only when DEBUG=1", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    logger.info("scope", "without debug");
    logger.warn("scope", "without debug");
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    process.env.DEBUG = "1";
    logger.info("scope", "with debug");
    logger.warn("scope", "with debug");
    expect(info).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("formats console output with a scope prefix", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    logger.error("provider", "fail");
    logger.error("provider", "fail with detail", { sessionId: "s-1" });
    expect(error).toHaveBeenNthCalledWith(1, "[provider] fail");
    expect(error).toHaveBeenNthCalledWith(2, "[provider] fail with detail", { sessionId: "s-1" });
  });
});
