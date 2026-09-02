import { Plus, SquareTerminal, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import { TerminalInstance } from "./TerminalInstance.js";
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
 * The review panel's Terminal view. Tab state and the xterm/PTY runtimes live
 * in `terminalTabs.ts` / `terminalRuntime.ts` keyed by workspace, so this
 * component can unmount freely (another panel mode, a closed panel, a session
 * switch) and remount to the same terminals with scrollback and running
 * processes intact. Inactive tabs stay mounted (`display: none`) so switching
 * tabs is instant.
 *
 * Chrome matches Files and Agents — the same tab strip and the same status
 * strip — so switching modes moves content, not furniture. Hiding the
 * terminal is the panel's own close button; there is no second × here.
 */
export function TerminalTabsPanel({
  workspaceId,
  visible,
  cwdLabel
}: {
  workspaceId: string;
  visible: boolean;
  /** Shown in the status strip: where these shells are running. */
  cwdLabel?: string | null;
}): JSX.Element {
  const shellLabel = useMemo(() => defaultShellLabel(), []);
  const { tabs, activeTabId } = useSyncExternalStore(subscribeTerminalTabs, () =>
    getWorkspaceTerminalState(workspaceId)
  );

  // Protect this workspace's terminals from LRU eviction while its panel is
  // mounted anywhere.
  useEffect(() => markTerminalWorkspaceAttached(workspaceId), [workspaceId]);

  // Seed one tab on first mount of an empty workspace; after that, an empty
  // tab list means the user closed the last tab, and the view rests on its
  // empty state until they ask for another. Re-check the store before
  // seeding: StrictMode re-runs this effect with a stale empty-tabs closure
  // right after the first run already seeded.
  const seededRef = useRef(false);
  useEffect(() => {
    if (tabs.length > 0) {
      seededRef.current = true;
      return;
    }
    if (seededRef.current) return;
    seededRef.current = true;
    if (getWorkspaceTerminalState(workspaceId).tabs.length > 0) return;
    addTerminalTab(workspaceId, shellLabel);
  }, [tabs, workspaceId, shellLabel]);

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

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;

  // No tabs left (the reader closed the last one): the empty state carries the
  // only action, so the strip would be a lone + over nothing.
  if (tabs.length === 0) {
    return (
      <div className="review-terminal">
        <p className="review-empty">
          <span className="review-empty-mark" aria-hidden="true">∅</span>
          <span>No terminal open.</span>
          <button type="button" className="review-empty-action" onClick={addTab}>
            New terminal
          </button>
        </p>
      </div>
    );
  }

  return (
    <div className="review-terminal">
      <div className="file-tabs-shell">
        <div className="file-tabs" role="tablist" aria-label="Terminal tabs" aria-orientation="horizontal">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            return (
              <div className="file-tab" data-active={isActive ? "true" : "false"} key={tab.id}>
                <button
                  ref={setTabButtonRef(tab.id)}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  aria-controls={`terminal-tabpanel-${tab.id}`}
                  id={`terminal-tab-${tab.id}`}
                  tabIndex={isActive ? 0 : -1}
                  title={tab.label}
                  onClick={() => activateTab(tab.id)}
                  onKeyDown={handleTabKeyDown(tab.id)}
                >
                  <span className="file-tab-icon" aria-hidden="true">
                    <SquareTerminal size={13} />
                  </span>
                  <span className="file-tab-name">{tab.label}</span>
                </button>
                <button
                  type="button"
                  className="file-tab-close"
                  aria-label={`Close ${tab.label}`}
                  title={`Close ${tab.label}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTab(tab.id);
                  }}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          className="file-tab-add"
          aria-label="New terminal"
          title="New terminal"
          onClick={addTab}
        >
          <Plus size={13} aria-hidden="true" />
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
              <TerminalInstance tabId={tab.id} workspaceId={workspaceId} visible={visible && isActive} />
            </div>
          );
        })}
      </div>

      <footer className="review-status-bar" aria-label="Terminal status">
        <span className="review-status-path" title={cwdLabel ?? undefined}>
          {cwdLabel ?? ""}
        </span>
        <span className="review-status-meta">
          {activeTab ? <span>{activeTab.label}</span> : null}
          {tabs.length > 1 ? <span>{tabs.length} terminals</span> : null}
        </span>
      </footer>
    </div>
  );
}
