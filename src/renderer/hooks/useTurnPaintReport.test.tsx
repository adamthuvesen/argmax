import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi, TimelineEvent } from "../../shared/types.js";
import { useTurnPaintReport } from "./useTurnPaintReport.js";

function event(id: string, type: string, payload: Record<string, unknown> = {}): TimelineEvent {
  const row: TimelineEvent = { id, sessionId: "s1", type, message: "", payload, createdAt: "" };
  return row;
}

describe("useTurnPaintReport", () => {
  afterEach(() => {
    delete (window as { argmax?: ArgmaxApi }).argmax;
  });

  it("reports the newest turn once its answer is on screen, reading events newest-first", async () => {
    const turnPainted = vi.fn(() => Promise.resolve());
    window.argmax = { session: { turnPainted } } as unknown as ArgmaxApi;
    const newestFirst = [
      event("a2", "message.delta"),
      event("u2", "user.message"),
      event("a1", "message.completed"),
      event("u1", "user.message"),
    ];
    renderHook(() => useTurnPaintReport("s1", newestFirst));
    await waitFor(() => expect(turnPainted).toHaveBeenCalledTimes(1));
    expect(turnPainted).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s1", turnKey: "u2" }),
    );
  });

  it("waits while the newest turn has only a raw echo", async () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    const turnPainted = vi.fn(() => Promise.resolve());
    window.argmax = { session: { turnPainted } } as unknown as ArgmaxApi;
    renderHook(() =>
      useTurnPaintReport("s1", [
        event("raw", "message.delta", { stream: "stdout" }),
        event("u3", "user.message"),
        event("a0", "message.completed"),
        event("u0", "user.message"),
      ]),
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(turnPainted).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
