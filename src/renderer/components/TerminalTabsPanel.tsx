import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import { TerminalInstance } from "./TerminalPanel.js";
import {
  addTerminalTab,
  closeTerminalTab,
  getWorkspaceTerminalState,
  markTerminalWorkspaceAttached,
  setActiveTerminalTab,
  subscribeTerminalTabs,
  type TerminalTabMeta
} from "../lib/terminalTabs.js";

/**
 * Cosmetic label only — actual shell selection happens in the main process.
 * The renderer has no access to `$SHELL`, so we pick a sensible default per
 * platform. Users primarily care that tabs are distinguishable, not strictly
 * accurate.
 */
function defaultShellLabel(): string {
  const raw = typeof navigator !== "undefined" ? navigator.platform : "";
  return raw.toLowerCase().includes("win") ? "powershell" : "zsh";
}

/**
 * Pick the lowest free label of form `${base}` / `${base} 2` / `${base} 3`
 * so closing a middle tab and opening a new one fills the gap.
 */
function nextLabel(existing: readonly TerminalTabMeta[], base: string): string {
  const taken = new Set(existing.map((t) => t.label));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} ${existing.length + 1}`;
}

/**
 * Multi-tab integrated terminal. Tab state and the xterm/PTY runtimes live in
 * `terminalTabs.ts` / `terminalRuntime.ts` keyed by workspace, so this
 * component can unmount freely (tab switch, ⌘J collapse, session switch) and
 * remount to the same terminals with scrollback and running processes intact.
 * Inactive tabs stay mounted (`display: none`) so switching tabs is instant.
 *
 * Two close paths:
 * - `onCollapse` — header × (or any "hide panel" affordance). PTYs stay
 *   alive; the parent hides the panel.
 * - `onRequestClose` — last tab was closed via its inline ×. PTYs are gone;
 *   the parent should unmount the panel entirely.
 */
export function TerminalTabsPanel({
  workspaceId,
  visible,
  onCollapse,
  onRequestClose
}: {
  workspaceId: string;
  visible: boolean;
  onCollapse: () => void;
  onRequestClose: () => void;
}): JSX.Element {
  const shellLabel = useMemo(() => defaultShellLabel(), []);
  const { tabs, activeTabId } = useSyncExternalStore(subscribeTerminalTabs, () =>
    getWorkspaceTerminalState(workspaceId)
  );

  // Protect this workspace's terminals from LRU eviction while its panel is
  // mounted anywhere.
  useEffect(() => markTerminalWorkspaceAttached(workspaceId), [workspaceId]);

  // Seed one tab on first mount of an empty workspace; after that, an empty
  // tab list means the user closed the last tab — hand control back to the
  // parent so it unmounts the panel. Re-check the store before seeding or
  // closing: StrictMode re-runs this effect with a stale empty-tabs closure
  // right after the first run already seeded.
  const seededRef = useRef(false);
  useEffect(() => {
    if (tabs.length > 0) {
      seededRef.current = true;
      return;
    }
    if (getWorkspaceTerminalState(workspaceId).tabs.length > 0) return;
    if (!seededRef.current) {
      seededRef.current = true;
      addTerminalTab(workspaceId, shellLabel);
      return;
    }
    onRequestClose();
  }, [tabs, workspaceId, shellLabel, onRequestClose]);

  const addTab = useCallback(() => {
    addTerminalTab(workspaceId, nextLabel(getWorkspaceTerminalState(workspaceId).tabs, shellLabel));
  }, [shellLabel, workspaceId]);

  const closeTab = useCallback(
    (tabId: string) => {
      closeTerminalTab(workspaceId, tabId);
    },
    [workspaceId]
  );

  const activateTab = useCallback(
    (tabId: string) => {
      setActiveTerminalTab(workspaceId, tabId);
    },
    [workspaceId]
  );

  // Refs to each tab's label button so keyboard nav can move focus along with
  // the active tab. WAI-ARIA tabs pattern: ←/→ moves between tabs, Home/End
  // jumps to first/last, Delete closes the focused tab.
  const tabButtonRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const setTabButtonRef = useCallback(
    (tabId: string) =>
      (node: HTMLButtonElement | null): void => {
        if (node === null) {
          tabButtonRefs.current.delete(tabId);
        } else {
          tabButtonRefs.current.set(tabId, node);
        }
      },
    []
  );

  const focusTab = useCallback((tabId: string): void => {
    const button = tabButtonRefs.current.get(tabId);
    button?.focus();
  }, []);

  const handleTabKeyDown = useCallback(
    (tabId: string) =>
      (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
        const currentIndex = tabs.findIndex((t) => t.id === tabId);
        if (currentIndex === -1) return;
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          const delta = event.key === "ArrowLeft" ? -1 : 1;
          const nextIndex = (currentIndex + delta + tabs.length) % tabs.length;
          const next = tabs[nextIndex];
          if (!next) return;
          activateTab(next.id);
          focusTab(next.id);
          return;
        }
        if (event.key === "Home") {
          event.preventDefault();
          const first = tabs[0];
          if (!first) return;
          activateTab(first.id);
          focusTab(first.id);
          return;
        }
        if (event.key === "End") {
          event.preventDefault();
          const last = tabs[tabs.length - 1];
          if (!last) return;
          activateTab(last.id);
          focusTab(last.id);
          return;
        }
        if (event.key === "Delete" || event.key === "Backspace") {
          event.preventDefault();
          closeTab(tabId);
        }
      },
    [activateTab, closeTab, focusTab, tabs]
  );

  return (
    <>
      <div className="terminal-panel-header">
        <div
          className="terminal-tab-bar"
          role="tablist"
          aria-label="Terminal tabs"
          aria-orientation="horizontal"
        >
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                className="terminal-tab"
                data-active={isActive}
              >
                <button
                  ref={setTabButtonRef(tab.id)}
                  type="button"
                  className="terminal-tab-label"
                  role="tab"
                  aria-selected={isActive}
                  aria-controls={`terminal-tabpanel-${tab.id}`}
                  id={`terminal-tab-${tab.id}`}
                  tabIndex={isActive ? 0 : -1}
                  onClick={() => activateTab(tab.id)}
                  onKeyDown={handleTabKeyDown(tab.id)}
                  title={tab.label}
                >
                  {tab.label}
                </button>
                <button
                  type="button"
                  className="terminal-tab-close"
                  aria-label={`Close ${tab.label}`}
                  title={`Close ${tab.label}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTab(tab.id);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="terminal-tab-add"
            aria-label="New terminal"
            title="New terminal"
            onClick={addTab}
          >
            +
          </button>
        </div>
        <button
          type="button"
          className="terminal-panel-close"
          aria-label="Hide terminal"
          title="Hide terminal (⌘J)"
          onClick={onCollapse}
        >
          ×
        </button>
      </div>
      <div className="terminal-tab-bodies">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              className="terminal-instance"
              data-active={isActive}
              role="tabpanel"
              id={`terminal-tabpanel-${tab.id}`}
              aria-labelledby={`terminal-tab-${tab.id}`}
              aria-hidden={!isActive}
            >
              <TerminalInstance
                tabId={tab.id}
                workspaceId={workspaceId}
                visible={visible && isActive}
              />
            </div>
          );
        })}
      </div>
    </>
  );
}
