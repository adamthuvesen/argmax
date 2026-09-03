import { useCallback, useEffect, useState } from "react";
import { isTypingTarget } from "../lib/typingTarget.js";

export interface OverlayState {
  /** Settings panel — typically pinned at right or as a sheet. */
  isSettingsOpen: boolean;
  setIsSettingsOpen: (open: boolean) => void;
  /** Scheduled tasks panel. */
  isScheduledTasksOpen: boolean;
  setIsScheduledTasksOpen: (open: boolean) => void;
  /** Usage page. */
  isUsageOpen: boolean;
  setIsUsageOpen: (open: boolean) => void;
  /** Command palette (Cmd+K). */
  isPaletteOpen: boolean;
  setIsPaletteOpen: (open: boolean) => void;
  /** Keyboard cheat sheet (Cmd+/). */
  isCheatSheetOpen: boolean;
  setIsCheatSheetOpen: (open: boolean) => void;
}

/**
 * App-shell overlay state. Owns the mutually-stackable overlays the app
 * exposes (settings, command palette, cheat sheet) and an Esc handler that
 * closes the topmost open overlay in z-order. Every search chord — ⌘K, ⌘P,
 * ⌘F, ⌘⇧F — opens the palette on a different tab, so search needs no state
 * of its own here.
 *
 * Phase 2.02 extraction: today this is a literal state container so the
 * call-site churn stays minimal. A later iteration can crystallize a
 * smaller open(kind)/close(kind) API once every existing site has been
 * audited for which overlay it intends to mutate.
 */
export function useOverlays(): OverlayState {
  const [isSettingsOpen, setIsSettingsOpenRaw] = useState<boolean>(false);
  const [isScheduledTasksOpen, setIsScheduledTasksOpenRaw] = useState<boolean>(false);
  const [isUsageOpen, setIsUsageOpenRaw] = useState<boolean>(false);
  const [isPaletteOpen, setIsPaletteOpenRaw] = useState<boolean>(false);
  const [isCheatSheetOpen, setIsCheatSheetOpenRaw] = useState<boolean>(false);

  // `useState` setters already have stable identity, but the hook wraps them
  // in `useCallback` indirection so consumers can list them in dep arrays
  // without flagging exhaustive-deps (the lint can't see useState's identity
  // guarantee through the hook boundary).
  // Settings, scheduled tasks, and usage are the full-screen pages, and they
  // occupy the same slot in the workspace column — so they close together.
  // Every navigation site in App already dismisses settings before showing a
  // session, project, or launcher; routing the other two through the same
  // setter means those sites cannot leave a page stranded over the grid.
  const setIsSettingsOpen = useCallback((open: boolean) => {
    setIsSettingsOpenRaw(open);
    setIsScheduledTasksOpenRaw(false);
    setIsUsageOpenRaw(false);
  }, []);
  const setIsScheduledTasksOpen = useCallback((open: boolean) => {
    setIsScheduledTasksOpenRaw(open);
    if (open) {
      setIsSettingsOpenRaw(false);
      setIsUsageOpenRaw(false);
    }
  }, []);
  const setIsUsageOpen = useCallback((open: boolean) => {
    setIsUsageOpenRaw(open);
    if (open) {
      setIsSettingsOpenRaw(false);
      setIsScheduledTasksOpenRaw(false);
    }
  }, []);
  const setIsPaletteOpen = useCallback((open: boolean) => setIsPaletteOpenRaw(open), []);
  const setIsCheatSheetOpen = useCallback((open: boolean) => setIsCheatSheetOpenRaw(open), []);

  // Esc precedence — closes one overlay per press, from topmost to deepest:
  // palette → cheat sheet → settings → scheduled tasks → usage. Typing-target guard
  // means Esc inside contenteditable / textarea / role=textbox stays in the
  // input (e.g. cancels an inline edit) instead of dismissing chrome.
  const handleEscape = useCallback((): boolean => {
    if (isPaletteOpen) {
      setIsPaletteOpenRaw(false);
      return true;
    }
    if (isCheatSheetOpen) {
      setIsCheatSheetOpenRaw(false);
      return true;
    }
    if (isSettingsOpen) {
      setIsSettingsOpenRaw(false);
      return true;
    }
    if (isScheduledTasksOpen) {
      setIsScheduledTasksOpenRaw(false);
      return true;
    }
    if (isUsageOpen) {
      setIsUsageOpenRaw(false);
      return true;
    }
    return false;
  }, [isPaletteOpen, isCheatSheetOpen, isSettingsOpen, isScheduledTasksOpen, isUsageOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (isTypingTarget(event.target)) return;
      if (handleEscape()) {
        event.preventDefault();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [handleEscape]);

  return {
    isSettingsOpen,
    setIsSettingsOpen,
    isScheduledTasksOpen,
    setIsScheduledTasksOpen,
    isUsageOpen,
    setIsUsageOpen,
    isPaletteOpen,
    setIsPaletteOpen,
    isCheatSheetOpen,
    setIsCheatSheetOpen
  };
}
