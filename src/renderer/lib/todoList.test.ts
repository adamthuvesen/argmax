import { describe, expect, it } from "vitest";

import { foldTodoEvents, todoListsByTurn, todoToolUseIds } from "./todoList.js";
import type { TimelineEvent } from "../../shared/types.js";

let clock = 0;
function todoEvent(
  mode: "snapshot" | "merge",
  items: { id?: string; text?: string; status: string }[],
  toolUseId: string | null = null
): TimelineEvent {
  clock += 1;
  return {
    id: `event-${clock}`,
    sessionId: "session-1",
    type: "todo.updated",
    message: "todo",
    payload: {
      mode,
      toolUseId,
      items: items.map((item) => ({
        id: item.id ?? null,
        text: item.text ?? null,
        status: item.status
      }))
    },
    createdAt: `2026-01-01T00:00:${String(clock).padStart(2, "0")}.000Z`
  };
}

const other = (type: string): TimelineEvent => ({
  id: "noise",
  sessionId: "session-1",
  type,
  message: "",
  payload: {},
  createdAt: "2026-01-01T00:00:00.000Z"
});

describe("foldTodoEvents", () => {
  it("returns nothing when no todo event has arrived", () => {
    expect(foldTodoEvents([other("command.started"), other("message.completed")])).toBeNull();
  });

  it("takes the whole list from a snapshot, the way Codex and OpenCode send it", () => {
    const list = foldTodoEvents([
      todoEvent("snapshot", [
        { text: "Read the normalizers", status: "done" },
        { text: "Write the projection", status: "active" },
        { text: "Verify with checks", status: "pending" }
      ])
    ]);
    expect(list?.items.map((item) => item.text)).toEqual([
      "Read the normalizers",
      "Write the projection",
      "Verify with checks"
    ]);
    expect(list?.doneCount).toBe(1);
    expect(list?.active?.text).toBe("Write the projection");
  });

  it("keeps text from an earlier snapshot when a merge carries only a status", () => {
    const list = foldTodoEvents([
      todoEvent("snapshot", [
        { id: "1", text: "Prove the address bar path", status: "done" },
        { id: "2", text: "Handle Enter in the address bar", status: "active" },
        { id: "3", text: "Add regression tests", status: "pending" }
      ]),
      todoEvent("merge", [
        { id: "2", status: "done" },
        { id: "3", status: "active" }
      ])
    ]);
    expect(list?.items[1]).toEqual({
      id: "2",
      text: "Handle Enter in the address bar",
      status: "done"
    });
    expect(list?.active?.text).toBe("Add regression tests");
    expect(list?.doneCount).toBe(2);
  });

  // Grok resumes a session and sends a status against an id whose snapshot has
  // scrolled out of the fold. Dropping the row would lose the agent's own
  // count, so it stands with no label and the card writes "Task 7".
  it("keeps an id-only row that arrives before any snapshot", () => {
    const list = foldTodoEvents([todoEvent("merge", [{ id: "7", status: "active" }])]);
    expect(list?.items).toEqual([{ id: "7", text: null, status: "active" }]);
  });

  it("replaces the whole list when a new snapshot arrives", () => {
    const list = foldTodoEvents([
      todoEvent("snapshot", [{ id: "1", text: "Old plan", status: "done" }]),
      todoEvent("snapshot", [{ id: "9", text: "New plan", status: "pending" }])
    ]);
    expect(list?.items).toEqual([{ id: "9", text: "New plan", status: "pending" }]);
  });

  it("drops an item Claude reports as deleted", () => {
    const list = foldTodoEvents([
      todoEvent("snapshot", [
        { id: "1", text: "Keep", status: "pending" },
        { id: "2", text: "Drop", status: "pending" }
      ]),
      todoEvent("merge", [{ id: "2", status: "removed" }])
    ]);
    expect(list?.items.map((item) => item.text)).toEqual(["Keep"]);
  });

  it("builds a Claude list one create and update at a time", () => {
    const list = foldTodoEvents([
      todoEvent("merge", [{ id: "5", text: "Wire up the projection", status: "pending" }]),
      todoEvent("merge", [{ id: "6", text: "Verify with checks", status: "pending" }]),
      todoEvent("merge", [{ id: "5", status: "active" }])
    ]);
    expect(list?.items).toEqual([
      { id: "5", text: "Wire up the projection", status: "active" },
      { id: "6", text: "Verify with checks", status: "pending" }
    ]);
  });

  it("ignores an event whose items are missing or malformed", () => {
    const malformed = todoEvent("snapshot", []);
    malformed.payload.items = [{ status: "not-a-status" }, 7];
    const list = foldTodoEvents([
      todoEvent("snapshot", [{ id: "1", text: "Survives", status: "pending" }]),
      malformed
    ]);
    expect(list?.items).toEqual([{ id: "1", text: "Survives", status: "pending" }]);
  });

  it("reports the timestamp of the last event it folded", () => {
    const first = todoEvent("snapshot", [{ id: "1", text: "One", status: "pending" }]);
    const second = todoEvent("merge", [{ id: "1", status: "done" }]);
    expect(foldTodoEvents([first, second])?.updatedAt).toBe(second.createdAt);
  });
});

describe("todoToolUseIds", () => {
  it("collects the rows the card speaks for", () => {
    const ids = todoToolUseIds([
      todoEvent("snapshot", [{ id: "1", text: "One", status: "pending" }], "call-1"),
      todoEvent("merge", [{ id: "1", status: "done" }], "call-2"),
      todoEvent("merge", [{ id: "1", status: "done" }], null)
    ]);
    expect([...ids].sort()).toEqual(["call-1", "call-2"]);
  });
});

describe("todoListsByTurn", () => {
  const at = (createdAt: string, event: TimelineEvent): TimelineEvent => ({
    ...event,
    createdAt
  });

  it("gives each turn the plan as it stood when that turn ended", () => {
    const events = [
      at(
        "2026-03-01T00:00:01.000Z",
        todoEvent("snapshot", [
          { id: "1", text: "One", status: "pending" },
          { id: "2", text: "Two", status: "pending" }
        ])
      ),
      at("2026-03-01T00:00:02.000Z", todoEvent("merge", [{ id: "1", status: "done" }])),
      at("2026-03-01T00:00:04.000Z", todoEvent("merge", [{ id: "2", status: "active" }]))
    ];
    const byTurn = todoListsByTurn(events, [
      { id: "turn-1", from: "2026-03-01T00:00:00.000Z", to: "2026-03-01T00:00:03.000Z" },
      { id: "turn-2", from: "2026-03-01T00:00:03.000Z", to: null }
    ]);
    // The first turn ended with one item done and nothing running.
    expect(byTurn.get("turn-1")?.doneCount).toBe(1);
    expect(byTurn.get("turn-1")?.active).toBeNull();
    // The second turn's card carries the first turn's progress forward.
    expect(byTurn.get("turn-2")?.doneCount).toBe(1);
    expect(byTurn.get("turn-2")?.active?.text).toBe("Two");
  });

  it("gives no card to a turn that never touched the plan", () => {
    const events = [
      at(
        "2026-03-01T00:00:01.000Z",
        todoEvent("snapshot", [{ id: "1", text: "One", status: "pending" }])
      )
    ];
    const byTurn = todoListsByTurn(events, [
      { id: "turn-1", from: "2026-03-01T00:00:00.000Z", to: "2026-03-01T00:00:09.000Z" },
      { id: "turn-2", from: "2026-03-01T00:00:09.000Z", to: null }
    ]);
    expect(byTurn.has("turn-1")).toBe(true);
    expect(byTurn.has("turn-2")).toBe(false);
  });
});
