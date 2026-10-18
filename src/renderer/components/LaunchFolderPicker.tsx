import { Folder } from "lucide-react";
import { useCallback, useRef, type JSX, type ReactNode } from "react";
import type { ProjectFolder } from "../../shared/types.js";
import { useAnchoredPopover, PICKER_MENU_EDGE_PADDING_PX, PICKER_MENU_MAX_HEIGHT_PX } from "../hooks/useAnchoredPopover.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { useTypeToFilter } from "../hooks/useTypeToFilter.js";
import { repoNameFromPath } from "../lib/projects.js";
import { collapseHome } from "../lib/pathDisplay.js";
import { PickerFilterRow } from "./PickerFilterRow.js";
import { PickerLead } from "./PickerLead.js";

export function LaunchFolderPicker({ folders, selected, open, onOpenChange, onPick, children }: {
  children: ReactNode;
  folders: ProjectFolder[];
  selected: ProjectFolder | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (folder: ProjectFolder) => void;
}): JSX.Element {
  const { setAnchor, setPopover, anchorRef, floatingStyles } = useAnchoredPopover({
    open, placement: "bottom-start", flip: false, strategy: "absolute", capHeight: true,
    edgePadding: PICKER_MENU_EDGE_PADDING_PX, maxHeight: PICKER_MENU_MAX_HEIGHT_PX
  });
  useDismissOnOutsideOrEscape(anchorRef, open, () => onOpenChange(false));
  const listRef = useRef<HTMLUListElement | null>(null);
  const setList = useCallback((node: HTMLUListElement | null) => {
    listRef.current = node;
    setPopover(node);
  }, [setPopover]);
  const pick = (folder: ProjectFolder): void => { onPick(folder); onOpenChange(false); };
  const folderLabel = (folder: ProjectFolder): string => repoNameFromPath(folder.rootPath) ?? folder.name;
  const filter = useTypeToFilter({ open, items: folders, toLabel: folderLabel,
    listRef, initialIndex: folders.findIndex((folder) => folder.id === selected?.id), onPick: pick });
  return <div className="project-picker-anchor" ref={setAnchor}>
    {children}
    {open ? <ul className="project-picker-popover launch-folder-menu" data-type-scale="chrome" role="listbox"
      aria-label="Work in" tabIndex={-1} ref={setList} style={floatingStyles} onKeyDown={filter.onKeyDown}>
      <li className="launch-folder-menu-heading" role="presentation">Work in</li>
      <PickerFilterRow query={filter.query} matchCount={filter.matches.length} totalCount={folders.length} />
      {filter.matches.map((folder, index) => <li key={folder.id} role="option" aria-selected={folder.id === selected?.id}
        data-active={index === filter.activeIndex ? "true" : undefined}>
        <button type="button" className="project-picker-item" onClick={() => pick(folder)} title={folder.rootPath}>
          <PickerLead selected={folder.id === selected?.id}><Folder size={13} /></PickerLead>
          <span className="launch-folder-menu-label"><span className="picker-label">{folderLabel(folder)}</span>
            {folders.some((other) => other.id !== folder.id && folderLabel(other) === folderLabel(folder))
              ? <span className="picker-meta">{collapseHome(folder.rootPath)}</span> : null}
          </span>
          {folder.isPrimary ? <span className="picker-meta">Primary</span> : null}
        </button>
      </li>)}
      {filter.matches.length === 0 ? <li role="presentation" className="project-picker-empty">No folders match</li> : null}
    </ul> : null}
  </div>;
}
