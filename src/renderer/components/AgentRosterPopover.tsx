import { ChevronDown } from "lucide-react";
import { Fragment, useCallback, useId, useMemo, useRef, useState, type JSX, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPopover } from "../hooks/useAnchoredPopover.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { useTypeToFilter } from "../hooks/useTypeToFilter.js";
import type { AgentRosterEntry, AgentRosterStatus } from "../lib/agentRoster.js";
import { newestAgentFirst } from "../lib/agentRoster.js";
import { AgentEmblem } from "./AgentEmblem.js";
import { PickerFilterRow } from "./PickerFilterRow.js";
import { WorkingNest } from "./WorkingNest.js";

const GROUPS: ReadonlyArray<{ status: AgentRosterStatus; label: string }> = [
  { status: "running", label: "Running" },
  { status: "error", label: "Failed" },
  { status: "done", label: "Completed" }
];

function orderedEntries(entries: readonly AgentRosterEntry[]): AgentRosterEntry[] {
  return GROUPS.flatMap(({ status }) =>
    entries.filter((entry) => entry.status === status).sort(newestAgentFirst)
  );
}

export function AgentRosterPopover({
  activeOverflow,
  activeTabId,
  entries,
  onSelect
}: {
  activeOverflow: number;
  activeTabId: string | null;
  entries: readonly AgentRosterEntry[];
  onSelect: (id: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const popoverId = useId();
  const listRef = useRef<HTMLUListElement | null>(null);
  const popover = useAnchoredPopover({ open, placement: "bottom-end", capHeight: true });
  const close = useCallback(() => setOpen(false), []);
  useDismissOnOutsideOrEscape(popover.anchorRef, open, close, popover.popoverRef);
  const ordered = useMemo(() => orderedEntries(entries), [entries]);
  const select = useCallback((entry: AgentRosterEntry): void => {
    onSelect(entry.id);
    setOpen(false);
  }, [onSelect]);
  const filter = useTypeToFilter({
    open,
    items: ordered,
    toLabel: (entry) => `${entry.title} ${entry.codename}`,
    listRef,
    initialIndex: Math.max(0, ordered.findIndex((entry) => entry.id === activeTabId)),
    onPick: select
  });
  const openFrom = (event: MouseEvent<HTMLButtonElement>): void => {
    if (open) {
      setOpen(false);
      return;
    }
    popover.setAnchor(event.currentTarget);
    setOpen(true);
  };

  return (
    <div className="agent-roster-controls">
      {activeOverflow > 0 ? (
        <button
          type="button"
          className="agent-roster-trigger agent-roster-overflow"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={popoverId}
          onClick={openFrom}
        >
          +{activeOverflow} active
        </button>
      ) : null}
      <button
        type="button"
        className="agent-roster-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={popoverId}
        onClick={openFrom}
      >
        <span>All agents {entries.length}</span>
        <ChevronDown size={11} aria-hidden="true" />
      </button>
      {open && typeof document !== "undefined" ? createPortal(
        <ul
          ref={(node) => {
            listRef.current = node;
            popover.setPopover(node);
          }}
          className="project-picker-popover agent-roster-popover"
          id={popoverId}
          role="listbox"
          aria-label="All agents"
          tabIndex={-1}
          style={popover.floatingStyles}
          onKeyDown={filter.onKeyDown}
        >
          <PickerFilterRow
            query={filter.query}
            matchCount={filter.matches.length}
            totalCount={ordered.length}
          />
          {GROUPS.map((group) => {
            const matches = filter.matches.filter((entry) => entry.status === group.status);
            if (matches.length === 0) return null;
            return (
              <Fragment key={group.status}>
                <li className="agent-roster-group" role="presentation">
                  <span>{group.label}</span>
                  <span>{matches.length}</span>
                </li>
                {matches.map((entry) => (
                  <li
                    role="option"
                    aria-selected={entry.id === activeTabId}
                    data-active={filter.matches[filter.activeIndex]?.id === entry.id ? "true" : undefined}
                    key={entry.id}
                  >
                    <button
                      type="button"
                      className="agent-roster-item"
                      onClick={() => select(entry)}
                    >
                      <span className="agent-roster-mark agent-emblem-tint" data-hue={entry.emblem.hue} aria-hidden="true">
                        {entry.status === "running" ? (
                          <WorkingNest active size={12} phaseKey={entry.id} />
                        ) : (
                          <AgentEmblem
                            shape={entry.emblem.shape}
                            hue={entry.emblem.hue}
                            size={14}
                            status={entry.status === "error" ? "error" : "done"}
                          />
                        )}
                      </span>
                      <span className="agent-roster-copy">
                        <span className="agent-roster-title">{entry.title}</span>
                        <span className="agent-roster-meta">{entry.codename}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </Fragment>
            );
          })}
          {filter.matches.length === 0 ? (
            <li className="agent-roster-empty" role="presentation">No agents match</li>
          ) : null}
        </ul>,
        document.body
      ) : null}
    </div>
  );
}
