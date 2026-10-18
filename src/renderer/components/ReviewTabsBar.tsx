import { ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpToLine, Bot, Folder, Globe, MessageSquarePlus, Plus, RotateCcw, Shapes, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { FileIcon } from "@react-symbols/icons/utils";
import { useAnchoredPopover, type AnchorPoint } from "../hooks/useAnchoredPopover.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { SPECIAL_FILE_ICONS } from "../lib/specialFileIcons.js";
import { ChangesIcon, TerminalIcon } from "./ReviewModeIcons.js";
import { WorkingNest } from "./WorkingNest.js";
import "../styles/review-tabs.css";

export interface ReviewTabItem {
  id: string;
  label: string;
  title?: string;
  kind: "changes" | "files" | "agents" | "browser" | "file" | "terminal" | "new" | "side-chat";
  dirty?: boolean;
  loading?: boolean;
}

export interface ReviewTabsBarProps {
  items: ReviewTabItem[];
  activeId: string | null;
  visibleIds: string[];
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onMove: (id: string, toIndex: number) => void;
  onSplit: (id: string, position: "top" | "bottom") => void;
  onOpen: (kind: "changes" | "files" | "agents" | "browser" | "terminal" | "artifacts") => void;
  onNewTab?: () => void;
  onReopen: () => void;
  canReopen: boolean;
  hasAgents: boolean;
  hasBrowser: boolean;
  hasTerminal: boolean;
  artifactsEnabled: boolean;
}

type TabMenu = { kind: "new" } | { kind: "tab"; id: string; point: AnchorPoint };
const TAB_DRAG_TYPE = "application/x-argmax-review-tab";

function TabIcon({ item }: { item: ReviewTabItem }): JSX.Element {
  if (item.loading) return <WorkingNest active size={14} phaseKey={item.id} />;
  switch (item.kind) {
    case "new": return <Plus size={14} aria-hidden="true" />;
    case "side-chat": return <MessageSquarePlus size={14} aria-hidden="true" />;
    case "changes": return <ChangesIcon />;
    case "files": return <Folder size={14} aria-hidden="true" />;
    case "agents": return <Bot size={14} aria-hidden="true" />;
    case "browser": return item.title?.startsWith("https://claude.ai/artifacts")
      ? <Shapes size={14} aria-hidden="true" />
      : <Globe size={14} aria-hidden="true" />;
    case "terminal": return <TerminalIcon />;
    case "file": return <FileIcon fileName={item.label} autoAssign editFileNameData={SPECIAL_FILE_ICONS} width={14} height={14} />;
  }
}

export function ReviewTabsBar({
  items, activeId, visibleIds, onSelect, onClose, onMove, onSplit, onOpen, onReopen, onNewTab,
  canReopen, hasAgents, hasBrowser, hasTerminal, artifactsEnabled
}: ReviewTabsBarProps): JSX.Element {
  const [menu, setMenu] = useState<TabMenu | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const tabButtons = useRef(new Map<string, HTMLButtonElement>());
  const addButton = useRef<HTMLButtonElement | null>(null);
  const draggedId = useRef<string | null>(null);
  const popover = useAnchoredPopover({ open: menu !== null, placement: "bottom-end", capHeight: true });
  const { anchorToPoint, setAnchor, popoverRef, anchorRef } = popover;

  const closeMenu = useCallback(() => {
    if (popoverRef.current?.contains(document.activeElement)) {
      if (menu?.kind === "tab") tabButtons.current.get(menu.id)?.focus();
      else addButton.current?.focus();
    }
    setMenu(null);
  }, [menu, popoverRef]);
  useDismissOnOutsideOrEscape(popoverRef, menu !== null, closeMenu, anchorRef);

  useEffect(() => {
    if (menu?.kind === "tab") anchorToPoint(menu.point);
    else setAnchor(addButton.current);
    if (menu) popoverRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [menu, anchorToPoint, setAnchor, popoverRef]);

  useEffect(() => {
    if (activeId) tabButtons.current.get(activeId)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  useEffect(() => {
    if (menu?.kind === "tab" && !items.some((item) => item.id === menu.id)) closeMenu();
  }, [items, menu, closeMenu]);

  const focusTab = (id: string): void => {
    onSelect(id);
    tabButtons.current.get(id)?.focus();
  };

  const openTabMenu = (id: string, point: AnchorPoint): void => setMenu({ kind: "tab", id, point });
  const handleTabKey = (id: string, event: KeyboardEvent<HTMLButtonElement>): void => {
    const index = items.findIndex((item) => item.id === id);
    if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      event.stopPropagation();
      const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
      const nextItem = items[nextIndex];
      if (nextItem) focusTab(nextItem.id);
    } else if (event.key === "Delete") {
      event.preventDefault();
      event.stopPropagation();
      const next = items[index + 1] ?? items[index - 1];
      onClose(id);
      if (next) tabButtons.current.get(next.id)?.focus();
      else addButton.current?.focus();
    } else if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
      event.preventDefault();
      event.stopPropagation();
      const bounds = event.currentTarget.getBoundingClientRect();
      openTabMenu(id, { x: bounds.left, y: bounds.bottom });
    }
  };

  const handleMenuKey = (event: KeyboardEvent<HTMLUListElement>): void => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
    const currentIndex = buttons.findIndex((button) => button === document.activeElement);
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[nextIndex]?.focus();
  };

  const menuAction = (action: () => void): void => {
    closeMenu();
    action();
  };
  const selectedItem = menu?.kind === "tab" ? items.find((item) => item.id === menu.id) : null;
  const selectedIndex = selectedItem ? items.indexOf(selectedItem) : -1;
  const openItems: Array<{ kind: Parameters<ReviewTabsBarProps["onOpen"]>[0]; label: string; icon: JSX.Element }> = [
    { kind: "changes", label: "Changes", icon: <ChangesIcon /> },
    { kind: "files", label: "Files", icon: <Folder size={14} aria-hidden="true" /> },
    ...(hasAgents ? [{ kind: "agents" as const, label: "Agents", icon: <Bot size={14} aria-hidden="true" /> }] : []),
    ...(hasBrowser ? [{ kind: "browser" as const, label: "Browser tab", icon: <Globe size={14} aria-hidden="true" /> }] : []),
    ...(hasBrowser && artifactsEnabled ? [{ kind: "artifacts" as const, label: "Claude artifacts", icon: <Shapes size={14} aria-hidden="true" /> }] : []),
    ...(hasTerminal ? [{ kind: "terminal" as const, label: "Terminal", icon: <TerminalIcon /> }] : [])
  ];

  return (
    <div className="review-tabs-bar">
      <div className="review-resource-tabs" role="tablist" aria-label="Workspace tabs">
        {items.map((item, index) => (
          <div
            key={item.id}
            className="review-resource-tab"
            role="presentation"
            data-active={item.id === activeId}
            data-visible={visibleIds.includes(item.id)}
            data-drop-target={dragOverId === item.id}
            data-drop-side={draggedId.current && items.findIndex((candidate) => candidate.id === draggedId.current) < index ? "after" : "before"}
            draggable
            onDragStart={(event) => {
              event.stopPropagation();
              draggedId.current = item.id;
              event.dataTransfer.setData(TAB_DRAG_TYPE, item.id);
              event.dataTransfer.effectAllowed = "move";
              closeMenu();
            }}
            onDragOver={(event) => {
              if (!draggedId.current || draggedId.current === item.id) return;
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = "move";
              setDragOverId(item.id);
            }}
            onDrop={(event) => {
              if (!draggedId.current) return;
              event.preventDefault();
              event.stopPropagation();
              if (draggedId.current !== item.id) onMove(draggedId.current, index);
              draggedId.current = null;
              setDragOverId(null);
            }}
            onDragEnd={(event) => {
              event.stopPropagation();
              draggedId.current = null;
              setDragOverId(null);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openTabMenu(item.id, { x: event.clientX, y: event.clientY });
            }}
          >
            <button
              ref={(node) => { if (node) tabButtons.current.set(item.id, node); else tabButtons.current.delete(item.id); }}
              className="review-resource-tab-select"
              type="button"
              role="tab"
              aria-label={item.title ?? item.label}
              aria-description={item.dirty ? "Unsaved changes" : undefined}
              aria-selected={item.id === activeId}
              tabIndex={item.id === activeId || (!activeId && index === 0) ? 0 : -1}
              title={item.title ?? item.label}
              onClick={() => onSelect(item.id)}
              onKeyDown={(event) => handleTabKey(item.id, event)}
              onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); onClose(item.id); } }}
            >
              <span className="review-resource-tab-icon" aria-hidden="true"><TabIcon item={item} /></span>
              <span className="review-resource-tab-label">{item.label}</span>
              {item.dirty ? <span className="review-resource-tab-dirty" aria-label="Unsaved changes" title="Unsaved changes" /> : null}
            </button>
            <button
              className="review-resource-tab-close"
              type="button"
              tabIndex={-1}
              aria-label={`Close ${item.title ?? item.label}`}
              title={`Close ${item.label}`}
              onClick={(event) => { event.stopPropagation(); onClose(item.id); }}
            ><X size={12} aria-hidden="true" /></button>
          </div>
        ))}
      </div>
      <button
        ref={addButton}
        className="review-tab-add"
        type="button"
        aria-label="New workspace tab"
        title="New workspace tab"
        aria-haspopup="menu"
        aria-expanded={menu?.kind === "new"}
        onClick={() => onNewTab ? onNewTab() : setMenu(menu?.kind === "new" ? null : { kind: "new" })}
        onContextMenu={(event) => { event.preventDefault(); setMenu({ kind: "new" }); }}
      ><Plus size={16} aria-hidden="true" /></button>
      {menu && (menu.kind === "new" || selectedItem) ? createPortal(
        <ul
          ref={popover.setPopover}
          className="project-picker-popover review-resource-tab-menu"
          style={popover.floatingStyles}
          role="menu"
          aria-label={menu.kind === "new" ? "Open workspace tab" : `${selectedItem?.label} tab actions`}
          data-browser-overlay="true"
          onKeyDown={handleMenuKey}
        >
          {menu.kind === "new" ? <>
            <li className="project-picker-group-label" role="presentation">Open in workspace</li>
            {openItems.map((item) => <li key={item.kind} role="none"><button type="button" role="menuitem" className="project-picker-item" onClick={() => menuAction(() => onOpen(item.kind))}>{item.icon}{item.label}</button></li>)}
          </> : selectedItem ? <>
            <li role="none"><button type="button" role="menuitem" className="project-picker-item" disabled={items.length < 2} onClick={() => menuAction(() => onSplit(selectedItem.id, "top"))}><ArrowUpToLine size={14} aria-hidden="true" />Show above</button></li>
            <li role="none"><button type="button" role="menuitem" className="project-picker-item" disabled={items.length < 2} onClick={() => menuAction(() => onSplit(selectedItem.id, "bottom"))}><ArrowDownToLine size={14} aria-hidden="true" />Show below</button></li>
            <li role="none"><button type="button" role="menuitem" className="project-picker-item" disabled={selectedIndex === 0} onClick={() => menuAction(() => onMove(selectedItem.id, selectedIndex - 1))}><ArrowLeft size={14} aria-hidden="true" />Move left</button></li>
            <li role="none"><button type="button" role="menuitem" className="project-picker-item" disabled={selectedIndex === items.length - 1} onClick={() => menuAction(() => onMove(selectedItem.id, selectedIndex + 1))}><ArrowRight size={14} aria-hidden="true" />Move right</button></li>
            <li className="project-picker-divider" role="separator" />
            <li role="none"><button type="button" role="menuitem" className="project-picker-item" onClick={() => menuAction(() => onClose(selectedItem.id))}><X size={14} aria-hidden="true" />Close tab</button></li>
          </> : null}
          <li className="project-picker-divider" role="separator" />
          <li role="none"><button type="button" role="menuitem" className="project-picker-item" disabled={!canReopen} onClick={() => menuAction(onReopen)}><RotateCcw size={14} aria-hidden="true" />Reopen closed tab</button></li>
        </ul>, document.body
      ) : null}
    </div>
  );
}
