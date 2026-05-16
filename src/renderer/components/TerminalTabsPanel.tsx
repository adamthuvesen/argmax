import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { TerminalInstance } from "./TerminalPanel.js";

interface TerminalTab {
  id: string;
  label: string;
}

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
function nextLabel(existing: TerminalTab[], base: string): string {
  const taken = new Set(existing.map((t) => t.label));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} ${existing.length + 1}`;
}

let nextTabIdSeq = 0;
function freshTabId(): string {
  nextTabIdSeq += 1;
  return `tab-${nextTabIdSeq}-${Date.now().toString(36)}`;
}

/**
 * Multi-tab integrated terminal. Owns its own tab list + active tab; each
 * tab mounts one `TerminalInstance` that spawns its own PTY. Inactive tabs
 * stay mounted (`display: none`) so long-running processes survive switching
 * between tabs and ⌘J collapse.
 *
 * Tabs are per-workspace: the parent should `key={workspaceId}` this
 * component so changing workspaces remounts and tears down old PTYs.
 *
 * Two close paths:
 * - `onCollapse` — header × (or any "hide panel" affordance). PTYs stay
 *   alive; the parent should hide the panel via CSS.
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
  const [tabs, setTabs] = useState<TerminalTab[]>(() => [
    { id: freshTabId(), label: shellLabel }
  ]);
  const [activeTabId, setActiveTabId] = useState<string>(() => tabs[0]?.id ?? "");

  // Keep activeTabId valid; ask parent to fully close when the last tab goes.
  useEffect(() => {
    if (tabs.length === 0) {
      onRequestClose();
      return;
    }
    if (!tabs.some((t) => t.id === activeTabId)) {
      setActiveTabId(tabs[tabs.length - 1].id);
    }
  }, [tabs, activeTabId, onRequestClose]);

  const addTab = useCallback(() => {
    setTabs((prev) => {
      const tab = { id: freshTabId(), label: nextLabel(prev, shellLabel) };
      setActiveTabId(tab.id);
      return [...prev, tab];
    });
  }, [shellLabel]);

  const closeTab = useCallback((tabId: string) => {
    setTabs((prev) => prev.filter((t) => t.id !== tabId));
  }, []);

  return (
    <>
      <div className="terminal-panel-header">
        <div
          className="terminal-tab-bar"
          role="tablist"
          aria-label="Terminal tabs"
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
                  type="button"
                  className="terminal-tab-label"
                  role="tab"
                  aria-selected={isActive}
                  aria-controls={`terminal-tabpanel-${tab.id}`}
                  id={`terminal-tab-${tab.id}`}
                  onClick={() => setActiveTabId(tab.id)}
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
                instanceKey={tab.id}
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
