import { useEffect, useRef, type JSX } from "react";
import { tryFit } from "../lib/xtermFit.js";
import {
  attachTerminalTab,
  detachTerminalTab,
  syncTerminalSize,
  type TerminalTabRuntime
} from "../lib/terminalRuntime.js";

/**
 * One mounted view of a persistent terminal tab. The xterm instance and PTY
 * live in `terminalRuntime.ts` keyed by `tabId`; this component only
 * reparents the terminal's host element into its container on mount and
 * detaches it on unmount. Unmounting (tab switch, panel close, session
 * switch) never terminates the PTY — only closing the tab does, via the
 * store's disposer.
 */
export function TerminalInstance({
  tabId,
  workspaceId,
  visible
}: {
  tabId: string;
  workspaceId: string;
  visible: boolean;
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<TerminalTabRuntime | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !window.argmax) return;

    const runtime = attachTerminalTab(tabId, workspaceId, container);
    runtimeRef.current = runtime;

    const ro = new ResizeObserver(() => {
      if (!tryFit(runtime.fit)) return;
      syncTerminalSize(runtime);
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      detachTerminalTab(tabId);
      runtimeRef.current = null;
    };
  }, [tabId, workspaceId]);

  // When the panel becomes visible after being hidden (collapsed via ⌘J or
  // because another tab was active), xterm's renderer can be out of sync
  // with the container size. Re-fit + focus on visibility flips.
  useEffect(() => {
    if (!visible) return;
    const runtime = runtimeRef.current;
    if (!runtime) return;
    if (!tryFit(runtime.fit)) return;
    syncTerminalSize(runtime);
    runtime.term.focus();
  }, [visible]);

  return (
    <div
      ref={containerRef}
      className="terminal-panel-surface"
      role="region"
      aria-label="Integrated terminal"
    />
  );
}
