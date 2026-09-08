import { FileIcon, FolderIcon } from "@react-symbols/icons/utils";
import { useEffect, useRef, type JSX, type RefObject } from "react";
import type { FileAutocompleteEntry, FileAutocompleteState } from "../hooks/useFileAutocomplete.js";
import { scrollChildIntoNearest } from "../lib/scrollChildIntoNearest.js";
import { SPECIAL_FILE_ICONS } from "../lib/specialFileIcons.js";
import { PickerLead } from "./PickerLead.js";

/** The row's two halves: the entry's own name, and the folder it sits in. */
function splitEntryPath(entry: FileAutocompleteEntry): { name: string; folder: string } {
  const slash = entry.path.lastIndexOf("/");
  return {
    name: entry.path.slice(slash + 1),
    folder: slash < 0 ? "" : entry.path.slice(0, slash)
  };
}

export function FilePopover({
  state,
  inputRef
}: {
  state: FileAutocompleteState;
  inputRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
}): JSX.Element | null {
  const selectedOptionRef = useRef<HTMLLIElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  useEffect(() => {
    if (!state.popoverOpen) {
      return;
    }
    const list = listRef.current;
    const active = selectedOptionRef.current;
    if (list && active) scrollChildIntoNearest(list, active);
  }, [state.popoverOpen, state.selectionIndex]);

  if (!state.popoverOpen) {
    return null;
  }
  if (state.filteredEntries.length === 0) {
    return (
      <ul
        ref={listRef}
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
      ref={listRef}
      className="file-popover"
      id="file-popover"
      role="listbox"
      aria-label="File suggestions"
      onWheel={(event) => event.stopPropagation()}
    >
      {state.filteredEntries.map((entry, index) => {
        const { name, folder } = splitEntryPath(entry);
        const label = entry.kind === "dir" ? `${name}/` : name;
        const key = `${entry.kind}:${entry.path}`;
        return (
          <li
            key={key}
            ref={index === state.selectionIndex ? selectedOptionRef : undefined}
            role="option"
            aria-selected={index === state.selectionIndex}
            // The folder is aria-hidden so the row's visible name stays short;
            // the full path is the accessible name so two `mod.rs` rows differ.
            aria-label={folder ? `${folder}/${label}` : label}
            data-kind={entry.kind}
            className={`file-popover-item${index === state.selectionIndex ? " is-selected" : ""}`}
            // Hover highlights the row by moving the shared selection index, so
            // pointer and arrow-key navigation light up the same row. Use
            // mouseMove, not mouseEnter: arrow-key navigation scrolls the list,
            // and a scroll that slides a new row under a resting pointer fires
            // mouseEnter — which would snatch selection back from the keyboard.
            // mouseMove only fires on real pointer movement.
            onMouseMove={() => {
              if (index !== state.selectionIndex) {
                state.setSelectionIndex(index);
              }
            }}
            onMouseDown={(event) => {
              event.preventDefault();
              state.setSelectionIndex(index);
              state.selectEntry(entry);
              inputRef.current?.focus();
            }}
          >
            <PickerLead>
              {entry.kind === "dir" ? (
                <FolderIcon folderName={name} width={14} height={14} />
              ) : (
                <FileIcon
                  fileName={name}
                  autoAssign
                  editFileNameData={SPECIAL_FILE_ICONS}
                  width={14}
                  height={14}
                />
              )}
            </PickerLead>
            <span className="file-popover-name">{label}</span>
            {folder ? (
              <span className="file-popover-dir" aria-hidden="true">
                {folder}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
