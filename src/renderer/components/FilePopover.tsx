import { FileText, Folder } from "lucide-react";
import { useEffect, useRef, type JSX, type RefObject } from "react";
import type { FileAutocompleteState } from "../hooks/useFileAutocomplete.js";

export function FilePopover({
  state,
  inputRef
}: {
  state: FileAutocompleteState;
  inputRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
}): JSX.Element | null {
  const selectedOptionRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    if (!state.popoverOpen) {
      return;
    }
    selectedOptionRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [state.popoverOpen, state.selectionIndex]);

  if (!state.popoverOpen) {
    return null;
  }
  if (state.filteredEntries.length === 0) {
    return (
      <ul
        className="file-popover"
        id="file-popover"
        role="listbox"
        aria-label="File suggestions"
        onWheel={(event) => event.stopPropagation()}
      >
        <li className="file-popover-empty">No matches</li>
      </ul>
    );
  }
  return (
    <ul
      className="file-popover"
      id="file-popover"
      role="listbox"
      aria-label="File suggestions"
      onWheel={(event) => event.stopPropagation()}
    >
      {state.filteredEntries.map((entry, index) => {
        const Icon = entry.kind === "dir" ? Folder : FileText;
        const display = entry.kind === "dir" ? `${entry.path}/` : entry.path;
        const key = `${entry.kind}:${entry.path}`;
        return (
          <li
            key={key}
            ref={index === state.selectionIndex ? selectedOptionRef : undefined}
            role="option"
            aria-selected={index === state.selectionIndex}
            className={`file-popover-item${index === state.selectionIndex ? " is-selected" : ""}`}
            onMouseDown={(event) => {
              event.preventDefault();
              state.setSelectionIndex(index);
              state.selectEntry(entry);
              inputRef.current?.focus();
            }}
          >
            <Icon className="file-popover-icon" size={13} aria-hidden="true" />
            <span className="file-popover-path">{display}</span>
          </li>
        );
      })}
    </ul>
  );
}
