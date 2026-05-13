// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger, readLogBuffer, resetLogBufferForTesting } from "./logger.js";

describe("logger", () => {
  beforeEach(() => {
    resetLogBufferForTesting();
    delete process.env.DEBUG;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.DEBUG;
  });

  it("appends each call to the ring buffer with ISO timestamp, scope, level, fields", () => {
    logger.info("subsystem", "hello", { id: 42 });
    const entries = readLogBuffer();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: "info",
      scope: "subsystem",
      message: "hello",
      fields: { id: 42 }
    });
    expect(entries[0]?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("caps the ring buffer at 1000 entries", () => {
    for (let i = 0; i < 1500; i++) {
      logger.debug("perf", `tick ${i}`);
    }
    const entries = readLogBuffer();
    expect(entries).toHaveLength(1000);
    // Oldest 500 dropped: the first remaining entry should be tick 500.
    expect(entries[0]?.message).toBe("tick 500");
    expect(entries[999]?.message).toBe("tick 1499");
  });

  it("mirrors errors to console regardless of DEBUG env", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    logger.error("crash", "explosion", { code: "ENOENT" });
    expect(err).toHaveBeenCalledTimes(1);
  });

  it("mirrors non-error levels to console only when DEBUG=1", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dbg = vi.spyOn(console, "debug").mockImplementation(() => {});

    logger.info("scope", "without debug");
    logger.warn("scope", "without debug");
    logger.debug("scope", "without debug");
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(dbg).not.toHaveBeenCalled();

    process.env.DEBUG = "1";
    logger.info("scope", "with debug");
    logger.warn("scope", "with debug");
    logger.debug("scope", "with debug");
    expect(info).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(dbg).toHaveBeenCalledTimes(1);
  });

  it("formats console output with [scope] prefix and only attaches fields when non-empty", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    logger.error("provider", "fail");
    expect(err).toHaveBeenLastCalledWith("[provider] fail");
    logger.error("provider", "fail with detail", { sessionId: "s-1" });
    expect(err).toHaveBeenLastCalledWith("[provider] fail with detail", { sessionId: "s-1" });
  });
});
