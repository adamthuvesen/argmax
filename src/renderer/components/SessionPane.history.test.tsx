import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../../shared/types.js";
import { baseSession } from "../../test/sessionConversationTestHarness.js";
import { SessionPane } from "./SessionPane.js";

function pane(session: SessionSummary, onLoadSessionEvents: (sessionId: string) => Promise<void>) {
  return (
    <SessionPane
      approvals={[]}
      onLoadSessionEvents={onLoadSessionEvents}
      onResolveApproval={vi.fn().mockResolvedValue(undefined)}
      onSendSessionInput={vi.fn().mockResolvedValue(undefined)}
      onCancelQueuedMessage={vi.fn().mockResolvedValue(undefined)}
      onSendQueuedMessageNow={vi.fn().mockResolvedValue(undefined)}
      onTerminateSession={vi.fn().mockResolvedValue(undefined)}
      onClearSession={vi.fn().mockResolvedValue(undefined)}
      project={null}
      session={session}
      workspace={null}
    />
  );
}

async function flushRead(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("SessionPane history loading", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("quietly retries a transient failure and reveals the transcript on success", async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("temporary read failure"))
      .mockResolvedValue(undefined);
    render(pane(baseSession({ state: "complete" }), load));

    await flushRead();
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status", { name: "Loading chat" })).toBeInTheDocument();
    expect(screen.queryByText("Chat history could not load.")).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("status", { name: "Loading chat" })).not.toBeInTheDocument();
    expect(screen.queryByText("Chat history could not load.")).not.toBeInTheDocument();
  });

  it("offers one inline retry after three failures, then recovers", async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"))
      .mockRejectedValueOnce(new Error("third"))
      .mockResolvedValue(undefined);
    render(pane(baseSession({ state: "complete" }), load));

    await flushRead();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
    });
    expect(load).toHaveBeenCalledTimes(3);
    expect(screen.getByText("Chat history could not load.")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Loading chat" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await flushRead();
    expect(load).toHaveBeenCalledTimes(4);
    expect(screen.queryByText("Chat history could not load.")).not.toBeInTheDocument();
  });

  it("cancels a pending retry when the pane switches sessions", async () => {
    const load = vi.fn((sessionId: string) => sessionId === "session-a"
      ? Promise.reject(new Error("read failure"))
      : Promise.resolve());
    const { rerender } = render(pane(baseSession({ id: "session-a", state: "complete" }), load));
    await flushRead();

    rerender(pane(baseSession({ id: "session-b", state: "complete" }), load));
    await flushRead();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
    });

    expect(load.mock.calls.map(([sessionId]) => sessionId)).toEqual(["session-a", "session-b"]);
    expect(screen.queryByText("Chat history could not load.")).not.toBeInTheDocument();
  });
});
