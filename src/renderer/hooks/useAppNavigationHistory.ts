import { useEffect, useRef } from "react";
import type { SettingsGroupId } from "../components/settings/settingsMeta.js";
import type { GridState } from "../lib/gridState.js";

export type AppNavigationDestination =
  | { kind: "grid"; grid: GridState }
  | { kind: "launcher"; sideChatMode: boolean; projectId: string | null }
  | { kind: "settings"; group: SettingsGroupId }
  | { kind: "schedule" }
  | { kind: "usage" }
  | { kind: "activity" }
  | { kind: "arc"; arcId: string }
  | { kind: "browser" };

interface UseAppNavigationHistoryOptions {
  destination: AppNavigationDestination;
  enabled?: boolean;
  canRestore: (destination: AppNavigationDestination) => boolean;
  restore: (destination: AppNavigationDestination) => void;
}

interface NavigationHistory {
  entries: AppNavigationDestination[];
  index: number;
}

const MAX_HISTORY_ENTRIES = 50;

function cloneDestination(destination: AppNavigationDestination): AppNavigationDestination {
  if (destination.kind !== "grid") return { ...destination };
  return {
    kind: "grid",
    grid: {
      rows: destination.grid.rows.map((row) => row.map((cell) => ({ ...cell }))),
      focused: destination.grid.focused ? { ...destination.grid.focused } : null
    }
  };
}

function destinationKey(destination: AppNavigationDestination): string {
  if (destination.kind !== "grid") {
    if (destination.kind === "settings") return `settings:${destination.group}`;
    if (destination.kind === "arc") return `arc:${destination.arcId}`;
    if (destination.kind === "launcher") {
      return `launcher:${destination.sideChatMode ? "side" : "project"}:${destination.projectId ?? ""}`;
    }
    return destination.kind;
  }
  return `grid:${JSON.stringify(destination.grid)}`;
}

function belongsToBrowserPanel(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".browser-panel") !== null;
}

/**
 * Keeps window-local app destinations behind the mouse's back and forward
 * buttons. Browser panels own the same buttons inside their chrome and native
 * pages handle them in their own webview, so those gestures never reach this
 * history.
 */
export function useAppNavigationHistory({
  destination,
  enabled = true,
  canRestore,
  restore
}: UseAppNavigationHistoryOptions): void {
  const historyRef = useRef<NavigationHistory | null>(null);
  const replayTargetRef = useRef<string | null>(null);
  const pressedButtonRef = useRef<number | null>(null);
  const canRestoreRef = useRef(canRestore);
  const restoreRef = useRef(restore);
  canRestoreRef.current = canRestore;
  restoreRef.current = restore;

  useEffect(() => {
    if (!enabled) return;
    const key = destinationKey(destination);
    const replayTarget = replayTargetRef.current;
    if (replayTarget !== null) {
      if (key === replayTarget) replayTargetRef.current = null;
      return;
    }

    const next = cloneDestination(destination);
    const history = historyRef.current;
    if (!history) {
      historyRef.current = { entries: [next], index: 0 };
      return;
    }
    const current = history.entries[history.index];
    if (!current) {
      historyRef.current = { entries: [next], index: 0 };
      return;
    }
    if (destinationKey(current) === key) return;

    // Snapshot pruning can replace a chat after it was archived. That is a
    // repair of the current destination, not a user navigation.
    if (!canRestoreRef.current(current)) {
      const previous = history.entries[history.index - 1];
      if (previous && destinationKey(previous) === key) {
        history.entries.splice(history.index, 1);
        history.index -= 1;
        return;
      }
      history.entries[history.index] = next;
      return;
    }

    const entries = [...history.entries.slice(0, history.index + 1), next];
    if (entries.length > MAX_HISTORY_ENTRIES) entries.splice(0, entries.length - MAX_HISTORY_ENTRIES);
    historyRef.current = { entries, index: entries.length - 1 };
  }, [destination, enabled]);

  useEffect(() => {
    if (!enabled) return undefined;

    const navigate = (step: -1 | 1): void => {
      const history = historyRef.current;
      if (!history) return;
      let index = history.index + step;
      while (index >= 0 && index < history.entries.length) {
        const candidate = history.entries[index];
        if (!candidate) return;
        if (canRestoreRef.current(candidate)) {
          history.index = index;
          replayTargetRef.current = destinationKey(candidate);
          restoreRef.current(cloneDestination(candidate));
          return;
        }
        index += step;
      }
    };

    const onMouseDown = (event: MouseEvent): void => {
      if (event.button !== 3 && event.button !== 4) return;
      if (belongsToBrowserPanel(event.target)) return;
      event.preventDefault();
      pressedButtonRef.current = event.button;
    };
    const onMouseUp = (event: MouseEvent): void => {
      if (event.button !== 3 && event.button !== 4) return;
      if (belongsToBrowserPanel(event.target)) {
        pressedButtonRef.current = null;
        return;
      }
      event.preventDefault();
      if (pressedButtonRef.current !== event.button) return;
      pressedButtonRef.current = null;
      navigate(event.button === 3 ? -1 : 1);
    };
    const onAuxClick = (event: MouseEvent): void => {
      if (event.button !== 3 && event.button !== 4) return;
      if (belongsToBrowserPanel(event.target)) return;
      event.preventDefault();
    };

    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("mouseup", onMouseUp, true);
    document.addEventListener("auxclick", onAuxClick, true);
    return () => {
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("mouseup", onMouseUp, true);
      document.removeEventListener("auxclick", onAuxClick, true);
    };
  }, [enabled]);
}
