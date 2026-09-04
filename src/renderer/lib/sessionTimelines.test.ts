// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type {
  RawProviderOutput,
  SessionEventsSinceResult,
  TimelineEvent
} from "../../shared/types.js";
import { SessionTimelines } from "./sessionTimelines.js";

function event(
  sessionId: string,
  id: string,
  rowCursor: number,
  overrides: Partial<TimelineEvent> = {}
): TimelineEvent {
  return {
    id,
    sessionId,
    type: "message.completed",
    message: id,
    payload: {},
    createdAt: new Date(Date.UTC(2026, 8, 5, 10, 0, 0, rowCursor)).toISOString(),
    rowCursor,
    ...overrides
  };
}

function rawOutput(sessionId: string, id: string, rowCursor: number): RawProviderOutput {
  return {
    id,
    sessionId,
    stream: "stdout",
    content: id,
    createdAt: new Date(Date.UTC(2026, 8, 5, 10, 0, 0, rowCursor)).toISOString(),
    rowCursor
  };
}

function result(
  events: TimelineEvent[] = [],
  rawOutputs: RawProviderOutput[] = [],
  eventCursor = 0,
  rawOutputCursor = 0,
  revision: {
    changeCursor?: number | null;
    deletedEventIds?: string[];
    deletedRawOutputIds?: string[];
    resetRequired?: boolean;
    hasMore?: boolean;
  } = {}
): SessionEventsSinceResult {
  return { events, rawOutputs, eventCursor, rawOutputCursor, ...revision };
}

function visit(store: SessionTimelines, sessionId: string): void {
  const ticket = store.beginRead(sessionId);
  store.cancelRead(sessionId, ticket);
}

describe("SessionTimelines", () => {
  it("reads an absent snapshot without creating an inactive bucket", () => {
    const store = new SessionTimelines();

    expect(store.getSnapshot("metadata-only")).toEqual({ events: [], rawOutputs: [] });
    expect(store.sessionCount).toBe(0);
  });

  it("notifies only subscribers for sessions whose transcript changed", () => {
    const store = new SessionTimelines();
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    store.subscribe("first", firstListener);
    store.subscribe("second", secondListener);

    store.merge([event("first", "event-1", 1)], []);

    expect(firstListener).toHaveBeenCalledTimes(1);
    expect(secondListener).not.toHaveBeenCalled();
  });

  it("reports only sessions with active subscribers", () => {
    const store = new SessionTimelines();
    const unsubscribeFirst = store.subscribe("first", () => undefined);
    store.subscribe("second", () => undefined);
    store.beginRead("inactive");

    expect(store.subscribedSessionIds()).toEqual(["first", "second"]);
    unsubscribeFirst();
    expect(store.subscribedSessionIds()).toEqual(["second"]);
  });

  it("applies event and raw-output caps independently per session", () => {
    const store = new SessionTimelines();
    const firstEvents = Array.from({ length: 2_100 }, (_, index) =>
      event("first", `first-event-${index}`, index + 1)
    );
    const secondEvents = Array.from({ length: 2_100 }, (_, index) =>
      event("second", `second-event-${index}`, index + 1)
    );
    const firstRaw = Array.from({ length: 120 }, (_, index) =>
      rawOutput("first", `first-raw-${index}`, index + 1)
    );
    const secondRaw = Array.from({ length: 120 }, (_, index) =>
      rawOutput("second", `second-raw-${index}`, index + 1)
    );

    store.merge([...firstEvents, ...secondEvents], [...firstRaw, ...secondRaw]);

    expect(store.getSnapshot("first").events).toHaveLength(2_000);
    expect(store.getSnapshot("second").events).toHaveLength(2_000);
    expect(store.getSnapshot("first").rawOutputs).toHaveLength(100);
    expect(store.getSnapshot("second").rawOutputs).toHaveLength(100);
  });

  it("keeps at most twelve inactive sessions after repeated visits", () => {
    const store = new SessionTimelines();

    for (let index = 0; index < 200; index += 1) {
      visit(store, `session-${index}`);
    }

    expect(store.sessionCount).toBe(12);
  });

  it("pins subscribed sessions outside the inactive cache", () => {
    const store = new SessionTimelines();
    const unsubscribe = store.subscribe("active", () => undefined);
    store.merge([event("active", "active-event", 1)], []);

    for (let index = 0; index < 200; index += 1) {
      visit(store, `inactive-${index}`);
    }

    expect(store.sessionCount).toBe(13);
    expect(store.getSnapshot("active").events.map((item) => item.id)).toEqual([
      "active-event"
    ]);
    unsubscribe();
  });

  it("rejects a read whose bucket was evicted", () => {
    const store = new SessionTimelines();
    const ticket = store.beginRead("evicted");
    for (let index = 0; index < 13; index += 1) {
      visit(store, `other-${index}`);
    }

    expect(
      store.finishRead("evicted", ticket, result([event("evicted", "late", 1)], [], 1))
    ).toBe(false);
    expect(store.getSnapshot("evicted").events).toEqual([]);
  });

  it("rejects reads after removal and reset", () => {
    const store = new SessionTimelines();
    const removedTicket = store.beginRead("removed");
    store.remove(["removed"]);
    expect(
      store.finishRead(
        "removed",
        removedTicket,
        result([event("removed", "removed-late", 1)], [], 1)
      )
    ).toBe(false);

    const resetTicket = store.beginRead("reset");
    store.reset(["reset"]);
    expect(
      store.finishRead(
        "reset",
        resetTicket,
        result([event("reset", "reset-late", 1)], [], 1)
      )
    ).toBe(false);
    expect(store.getSnapshot("removed").events).toEqual([]);
    expect(store.getSnapshot("reset").events).toEqual([]);
  });

  it("retains only allowed buckets and keeps subscriptions across reset", () => {
    const store = new SessionTimelines();
    const listener = vi.fn();
    store.subscribe("kept", listener);
    store.merge(
      [event("kept", "kept-event", 1), event("removed", "removed-event", 2)],
      []
    );

    store.retainSessions(["kept"]);
    expect(store.getSnapshot("kept").events).toHaveLength(1);
    expect(store.getSnapshot("removed").events).toEqual([]);

    store.reset(["kept"]);
    store.merge([event("kept", "after-reset", 3)], []);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(store.getSnapshot("kept").events[0]?.id).toBe("after-reset");
  });

  it("keeps a newer pushed row when an older read finishes", () => {
    const store = new SessionTimelines();
    const initial = event("session", "same-id", 1, { message: "initial" });
    store.merge([initial], []);
    const ticket = store.beginRead("session");
    const pushed = event("session", "same-id", 1, { message: "pushed" });
    store.merge([pushed], []);

    expect(
      store.finishRead(
        "session",
        ticket,
        result([event("session", "same-id", 1, { message: "stale read" })], [], 10)
      )
    ).toBe(true);
    expect(store.getSnapshot("session").events[0]?.message).toBe("pushed");
    expect(store.beginRead("session").eventCursor).toBe(10);
  });

  it("applies revision-feed deletions and advances the consumed change cursor", () => {
    const store = new SessionTimelines();
    store.merge(
      [event("session", "event-to-delete", 1)],
      [rawOutput("session", "raw-to-delete", 1)]
    );
    const ticket = store.beginRead("session");

    expect(
      store.finishRead(
        "session",
        ticket,
        result([], [], 1, 1, {
          changeCursor: 7,
          deletedEventIds: ["event-to-delete"],
          deletedRawOutputIds: ["raw-to-delete"]
        })
      )
    ).toBe(true);
    expect(store.getSnapshot("session")).toEqual({ events: [], rawOutputs: [] });
    expect(store.beginRead("session").changeCursor).toBe(7);
  });

  it("keeps content visible during invalidation and replaces it on recovery", () => {
    const store = new SessionTimelines();
    const oldEvent = event("session", "old", 1);
    store.merge([oldEvent], [rawOutput("session", "old-raw", 1)]);

    store.invalidate();
    expect(store.getSnapshot("session").events).toEqual([oldEvent]);
    const ticket = store.beginRead("session");
    expect(ticket).toMatchObject({
      eventCursor: null,
      rawOutputCursor: null,
      changeCursor: null
    });
    const pushed = event("session", "pushed", 3);
    const fetched = event("session", "fetched", 2);
    store.merge([pushed], []);

    store.finishRead(
      "session",
      ticket,
      result([fetched], [], 2, 0, {
        changeCursor: 12,
        resetRequired: true
      })
    );

    expect(store.getSnapshot("session").events.map((item) => item.id)).toEqual([
      "pushed",
      "fetched"
    ]);
    expect(store.getSnapshot("session").rawOutputs).toEqual([]);
    expect(store.beginRead("session")).toMatchObject({
      eventCursor: 2,
      rawOutputCursor: 0,
      changeCursor: 12
    });
  });

  it("treats the first legacy response after invalidation as authoritative", () => {
    const store = new SessionTimelines();
    store.merge([event("session", "old", 1)], []);
    store.invalidate(["session"]);
    const ticket = store.beginRead("session");

    store.finishRead("session", ticket, result([event("session", "current", 2)], [], 2));

    expect(store.getSnapshot("session").events.map((item) => item.id)).toEqual([
      "current"
    ]);
  });

  it("does not let an older overlapping revision resurrect a deletion", () => {
    const store = new SessionTimelines();
    const existing = event("session", "existing", 1);
    store.merge([existing], []);
    const older = store.beginRead("session");
    const newer = store.beginRead("session");

    store.finishRead(
      "session",
      newer,
      result([], [], 1, 0, {
        changeCursor: 20,
        deletedEventIds: [existing.id]
      })
    );
    expect(
      store.finishRead(
        "session",
        older,
        result([existing], [], 1, 0, { changeCursor: 10 })
      )
    ).toBe(false);
    expect(store.getSnapshot("session").events).toEqual([]);
  });

  it("accepts an authoritative gap reset that moves a future cursor backward", () => {
    const store = new SessionTimelines();
    const initial = store.beginRead("session");
    store.finishRead(
      "session",
      initial,
      result([], [], 0, 0, { changeCursor: 30, resetRequired: true })
    );
    const gapRead = store.beginRead("session");

    expect(
      store.finishRead(
        "session",
        gapRead,
        result([event("session", "recovered", 1)], [], 1, 0, {
          changeCursor: 20,
          resetRequired: true
        })
      )
    ).toBe(true);
    expect(store.beginRead("session").changeCursor).toBe(20);
  });

  it("keeps a newer authoritative replacement when a legacy overlap finishes", () => {
    const store = new SessionTimelines();
    const old = event("session", "old", 1);
    store.merge([old], []);
    const stale = store.beginRead("session");
    const current = store.beginRead("session");
    const replacement = event("session", "replacement", 2);

    store.finishRead(
      "session",
      current,
      result([replacement], [], 2, 0, { resetRequired: true })
    );
    store.finishRead(
      "session",
      stale,
      result([old], [], 1, 0, { resetRequired: true })
    );

    expect(store.getSnapshot("session").events.map((item) => item.id)).toEqual([
      "replacement"
    ]);
  });

  it("cancels a failed read without changing its transcript or cursors", () => {
    const store = new SessionTimelines();
    const ticket = store.beginRead("session");

    expect(store.cancelRead("session", ticket)).toBe(true);
    expect(store.cancelRead("session", ticket)).toBe(false);
    expect(store.getSnapshot("session")).toEqual({ events: [], rawOutputs: [] });
    expect(store.beginRead("session").eventCursor).toBeNull();
  });

  it("bounds stalled reads and rejects tickets displaced by newer reads", () => {
    const store = new SessionTimelines();
    const oldest = store.beginRead("session");
    for (let index = 0; index < 64; index += 1) {
      store.beginRead("session");
    }

    expect(store.finishRead("session", oldest, result([], [], 1, 1))).toBe(false);
  });

  it("invalidates a stalled read before its update journal can grow without bound", () => {
    const store = new SessionTimelines();
    const stalled = store.beginRead("session");
    const outputs = Array.from({ length: 10_001 }, (_, index) =>
      rawOutput("session", `output-${index}`, index + 1)
    );

    store.merge([], outputs);

    expect(store.getSnapshot("session").rawOutputs).toHaveLength(100);
    expect(store.finishRead("session", stalled, result([], [], 1, 1))).toBe(false);
  });

  it("does not resurrect a row replaced by a pushed trace tombstone", () => {
    const store = new SessionTimelines();
    const synthetic = event("session", "synthetic", 1);
    store.merge([synthetic], []);
    const ticket = store.beginRead("session");
    store.merge(
      [
        event("session", "synthetic", 1, {
          payload: { traceSyntheticSuperseded: true, traceSupersededBy: "real" }
        })
      ],
      []
    );

    store.finishRead("session", ticket, result([synthetic], [], 1));

    expect(store.getSnapshot("session").events).toEqual([]);
  });

  it("rejects cross-session rows returned by a cursored session read", () => {
    const store = new SessionTimelines();
    const ticket = store.beginRead("requested");
    const requestedEvent = event("requested", "requested-event", 1);
    const requestedRaw = rawOutput("requested", "requested-raw", 1);

    store.finishRead(
      "requested",
      ticket,
      result(
        [requestedEvent, event("other", "other-event", 2)],
        [requestedRaw, rawOutput("other", "other-raw", 2)],
        2,
        2
      )
    );

    expect(store.getSnapshot("requested")).toEqual({
      events: [requestedEvent],
      rawOutputs: [requestedRaw]
    });
    expect(store.getSnapshot("other")).toEqual({ events: [], rawOutputs: [] });
  });

  it("merges an agent tail into its parent bucket without advancing cursors", () => {
    const store = new SessionTimelines();
    const ticket = store.beginRead("parent");
    const childRow = event("child", "child-event", 20);

    expect(store.mergeAgentTail("parent", result([childRow], [], 20), ticket)).toBe(
      true
    );
    expect(store.getSnapshot("parent").events).toEqual([childRow]);
    expect(store.getSnapshot("child").events).toEqual([]);
    expect(store.beginRead("parent").eventCursor).toBeNull();
  });

  it("keeps a pushed parent row when an older agent-tail read finishes", () => {
    const store = new SessionTimelines();
    const initial = event("parent", "same-id", 1, { message: "initial" });
    store.merge([initial], []);
    const ticket = store.beginRead("parent");
    store.merge([event("parent", "same-id", 1, { message: "pushed" })], []);

    expect(
      store.mergeAgentTail(
        "parent",
        result([event("child", "same-id", 1, { message: "stale agent read" })]),
        ticket
      )
    ).toBe(true);
    expect(store.getSnapshot("parent").events[0]?.message).toBe("pushed");
  });

  it("rejects an agent tail after its parent bucket is reset", () => {
    const store = new SessionTimelines();
    const ticket = store.beginRead("parent");
    store.reset(["parent"]);

    expect(
      store.mergeAgentTail(
        "parent",
        result([event("parent", "agent-late", 1)], [], 1),
        ticket
      )
    ).toBe(false);
    expect(store.getSnapshot("parent").events).toEqual([]);
  });

  it("drops cursors when an inactive session is evicted and reloaded", () => {
    const store = new SessionTimelines();
    const ticket = store.beginRead("old");
    store.finishRead("old", ticket, result([], [], 42, 24));
    expect(store.beginRead("old")).toMatchObject({
      eventCursor: 42,
      rawOutputCursor: 24
    });

    for (let index = 0; index < 13; index += 1) {
      visit(store, `new-${index}`);
    }

    expect(store.beginRead("old")).toMatchObject({
      eventCursor: null,
      rawOutputCursor: null
    });
  });
});
