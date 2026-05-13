// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scheduleSigkillEscalation } from "./processControl.js";

describe("scheduleSigkillEscalation — narrowed error swallowing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls SIGTERM immediately and SIGKILL after the grace window", () => {
    const killTerm = vi.fn();
    const killKill = vi.fn();
    const { cancel } = scheduleSigkillEscalation(killTerm, killKill, { graceMs: 500 });

    expect(killTerm).toHaveBeenCalledTimes(1);
    expect(killKill).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(killKill).toHaveBeenCalledTimes(1);

    cancel(); // post-fire cancel is a no-op; just confirm it doesn't throw.
  });

  it("cancel() skips the SIGKILL fallback when the child exits before the grace window", () => {
    const killTerm = vi.fn();
    const killKill = vi.fn();
    const { cancel } = scheduleSigkillEscalation(killTerm, killKill, { graceMs: 500 });

    cancel();
    vi.advanceTimersByTime(500);

    expect(killTerm).toHaveBeenCalledTimes(1);
    expect(killKill).not.toHaveBeenCalled();
  });

  it("swallows ESRCH from SIGTERM (process already dead) without re-throwing", () => {
    const esrch = Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    const killTerm = vi.fn(() => {
      throw esrch;
    });
    const killKill = vi.fn();
    expect(() => scheduleSigkillEscalation(killTerm, killKill, { graceMs: 500 })).not.toThrow();
  });

  it("swallows ESRCH from SIGKILL inside the timer without crashing the process", () => {
    const esrch = Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    const killTerm = vi.fn();
    const killKill = vi.fn(() => {
      throw esrch;
    });
    scheduleSigkillEscalation(killTerm, killKill, { graceMs: 100 });
    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    expect(killKill).toHaveBeenCalledTimes(1);
  });

  it("propagates non-ESRCH errors from SIGTERM instead of silently swallowing them", () => {
    const eperm = Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    const killTerm = vi.fn(() => {
      throw eperm;
    });
    expect(() => scheduleSigkillEscalation(killTerm, vi.fn())).toThrow(/EPERM/);
  });
});
