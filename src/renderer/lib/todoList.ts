import { isPlainObject } from "../../shared/typeGuards.js";
import type { TimelineEvent } from "../../shared/types.js";

/**
 * The agent's own plan, folded out of `todo.updated` events.
 *
 * The normalizer resolves every provider dialect into one shape, so nothing
 * here knows which CLI produced the list. What it does know is that three of
 * the five providers send deltas: a `merge` carries only what changed, and may
 * carry a status against an id whose text arrived in an earlier snapshot. That
 * is why this is a fold over the persisted sequence rather than a read of the
 * latest event — and why it lives here rather than in Rust, where the
 * normalizer's memory is thrown away at the end of every provider invocation.
 */

export type TodoStatus = "pending" | "active" | "done" | "cancelled" | "removed";

export type TodoItem = {
  /** Null for OpenCode, which numbers nothing. */
  id: string | null;
  /** Null until a snapshot names it; Grok sends status-only deltas. */
  text: string | null;
  status: TodoStatus;
};

export type TodoList = {
  items: TodoItem[];
  /** When the last event folded into this list arrived. */
  updatedAt: string;
  doneCount: number;
  /** The item the agent says it is working on, if it named one. */
  active: TodoItem | null;
};

const STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "active",
  "done",
  "cancelled",
  "removed"
]);

function readItem(raw: unknown): TodoItem | null {
  if (!isPlainObject(raw)) return null;
  const status = raw.status;
  if (typeof status !== "string" || !STATUSES.has(status)) return null;
  return {
    id: typeof raw.id === "string" && raw.id !== "" ? raw.id : null,
    text: typeof raw.text === "string" && raw.text !== "" ? raw.text : null,
    status: status as TodoStatus
  };
}

/**
 * Merge one item onto the list. An id that is already present updates in
 * place and keeps its text when the delta carries none; an unknown id appends,
 * which is what a status-only delta arriving before any snapshot looks like —
 * a labelled row would be wrong, an absent row would lose the agent's own
 * count, so the row stands with no label.
 */
function mergeItem(items: TodoItem[], incoming: TodoItem): TodoItem[] {
  if (incoming.status === "removed") {
    return incoming.id === null ? items : items.filter((item) => item.id !== incoming.id);
  }
  if (incoming.id === null) return [...items, incoming];
  const index = items.findIndex((item) => item.id === incoming.id);
  if (index === -1) return [...items, incoming];
  const next = items.slice();
  next[index] = { ...incoming, text: incoming.text ?? items[index].text };
  return next;
}

/**
 * Fold every `todo.updated` in order. Snapshots replace outright, so a fresh
 * plan mid-session cannot leave rows from the old one behind.
 */
export function foldTodoEvents(events: readonly TimelineEvent[]): TodoList | null {
  let items: TodoItem[] = [];
  let updatedAt: string | null = null;

  for (const event of events) {
    if (event.type !== "todo.updated" || !isPlainObject(event.payload)) continue;
    const payload = event.payload;
    const rawItems = Array.isArray(payload.items) ? payload.items : [];
    const incoming = rawItems.map(readItem).filter((item): item is TodoItem => item !== null);
    if (incoming.length === 0) continue;

    if (payload.mode === "snapshot") {
      items = incoming.filter((item) => item.status !== "removed");
    } else {
      for (const item of incoming) items = mergeItem(items, item);
    }
    updatedAt = event.createdAt;
  }

  if (updatedAt === null || items.length === 0) return null;
  return {
    items,
    updatedAt,
    doneCount: items.filter((item) => item.status === "done").length,
    active: items.find((item) => item.status === "active") ?? null
  };
}

export type TurnBound = {
  id: string;
  /** When this turn's first content arrived. */
  from: string;
  /** When the next turn starts, or null for the newest turn. */
  to: string | null;
};

/**
 * One card per turn that touched the plan, showing the plan as it stood at the
 * end of that turn.
 *
 * Scrolling back is the reason: a single card pinned to the newest turn would
 * rewrite history every time the agent ticked something off, so a turn read a
 * week later would describe work it had not done yet. Each turn keeps the fold
 * up to its own last update; turns that never touched the plan show no card.
 */
export function todoListsByTurn(
  events: readonly TimelineEvent[],
  turns: readonly TurnBound[]
): Map<string, TodoList> {
  const updates = events
    .filter((event) => event.type === "todo.updated")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const byTurn = new Map<string, TodoList>();
  if (updates.length === 0) return byTurn;

  const folded: TimelineEvent[] = [];
  let cursor = 0;
  for (const turn of turns) {
    let touched = false;
    while (
      cursor < updates.length &&
      (turn.to === null || updates[cursor].createdAt.localeCompare(turn.to) < 0)
    ) {
      // Updates older than this turn still build the list — they just do not
      // give this turn a card of its own.
      if (updates[cursor].createdAt.localeCompare(turn.from) >= 0) touched = true;
      folded.push(updates[cursor]);
      cursor += 1;
    }
    if (!touched) continue;
    const list = foldTodoEvents(folded);
    if (list) byTurn.set(turn.id, list);
  }
  return byTurn;
}

/**
 * The `toolUseId` of every tool row that carried a todo update, so the rows can
 * be hidden the way ExitPlanMode's are — the card is the readable version of
 * what they say.
 */
export function todoToolUseIds(events: readonly TimelineEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.type !== "todo.updated" || !isPlainObject(event.payload)) continue;
    const id = event.payload.toolUseId;
    if (typeof id === "string" && id !== "") ids.add(id);
  }
  return ids;
}
