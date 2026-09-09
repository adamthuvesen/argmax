import { ChevronRight } from "lucide-react";
import { useState, type JSX } from "react";
import type { TodoItem, TodoList, TodoStatus } from "../lib/todoList.js";
import { WorkingNest } from "./WorkingNest.js";

export type TodoCardProps = {
  list: TodoList;
  /** The turn that owns this card is still running. */
  running: boolean;
};

/** Every status that draws a row. `removed` means the agent took the item off
 *  its own list, so it draws nothing. */
type ShownStatus = Exclude<TodoStatus, "removed">;

/// The status as words. Colour carries it for a sighted reader; this is what a
/// screen reader gets, and what a test asserts on.
const STATUS_LABEL: Record<ShownStatus, string> = {
  done: "Done",
  active: "In progress",
  pending: "Pending",
  cancelled: "Cancelled"
};

/// What the headline says once the list is folded away. Collapsed, it has to
/// carry the one thing you would have expanded for.
function collapsedTail(list: TodoList): string | null {
  const activeText = list.active?.text;
  if (activeText != null) return `· ${activeText}`;
  if (list.doneCount === list.items.length) return "· all done";
  if (list.doneCount === 0) return "· not started";
  return null;
}

/// Grok addresses an item by id before it has ever sent the text, so a row can
/// stand for a step nothing has named yet. It still gets a label: an empty row
/// would be a hole in the agent's own count.
function itemLabel(item: TodoItem): string {
  if (item.text !== null) return item.text;
  return item.id !== null ? `Task ${item.id}` : "Untitled task";
}

function TodoMark({ status, running }: { status: ShownStatus; running: boolean }): JSX.Element {
  return (
    <span className="todo-card-mark" role="img" aria-label={STATUS_LABEL[status]}>
      {markGlyph(status, running)}
    </span>
  );
}

function markGlyph(status: ShownStatus, running: boolean): JSX.Element {
  if (status === "done") {
    return (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.9}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
      </svg>
    );
  }
  // The app's one running mark, not a spinner invented for this surface. It
  // stops when the turn does: an item left `active` by an ended turn is a
  // record, not live work.
  if (status === "active") return <WorkingNest active={running} size={12} />;
  if (status === "cancelled") {
    return (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
      >
        <path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5" />
      </svg>
    );
  }
  // Drawn in CSS rather than as a glyph so the ring keeps its weight at every
  // step of the type scale.
  return <i className="todo-card-ring" />;
}

/**
 * The agent's plan, as a checklist in the transcript's own grammar.
 *
 * No fill, no border, no radius: a plan in progress is a beat in the
 * conversation rather than a document, the same reading QuestionCard takes.
 * The lead column is the tool row's chevron column, so an item's mark lands
 * where every disclosure chevron lands and its label lands on the verb column.
 * Mockups and the decision: `docs/design/todo-list`.
 */
export function TodoCard({ list, running }: TodoCardProps): JSX.Element {
  // Expanded while the turn runs, collapsed once it ends — but only until the
  // user says otherwise. A turn ending must not slam open a card they just
  // closed, and must still collapse one they never touched.
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const expanded = userExpanded ?? running;
  const tail = expanded ? null : collapsedTail(list);
  const shown = list.items.filter((item): item is TodoItem & { status: ShownStatus } =>
    item.status !== "removed"
  );

  return (
    <div
      className="todo-card"
      data-expanded={expanded ? "true" : "false"}
      role="group"
      aria-label="Plan"
    >
      <button
        type="button"
        className="todo-card-head"
        aria-expanded={expanded}
        onClick={() => setUserExpanded(!expanded)}
      >
        <ChevronRight size={12} className="todo-card-head-chevron" aria-hidden="true" />
        <span className="todo-card-head-verb">Plan</span>
        <span className="todo-card-head-count">
          {list.doneCount} of {list.items.length}
        </span>
        {tail === null ? null : <span className="todo-card-head-now">{tail}</span>}
      </button>
      <ul className="todo-card-list">
        {shown.map((item, index) => (
          <li className="todo-card-item" data-state={item.status} key={item.id ?? `row-${index}`}>
            <TodoMark status={item.status} running={running} />
            <span
              className="todo-card-label"
              data-unnamed={item.text === null ? "true" : undefined}
            >
              {itemLabel(item)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
