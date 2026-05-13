import { useCallback, useEffect, useState } from "react";
import { isTypingTarget } from "../lib/typingTarget.js";

export interface OverlayState {
  /** Settings panel — typically pinned at right or as a sheet. */
  isSettingsOpen: boolean;
  setIsSettingsOpen: (open: boolean) => void;
  /** Command palette (Cmd+K). */
  isPaletteOpen: boolean;
  setIsPaletteOpen: (open: boolean) => void;
  /** Keyboard cheat sheet (Cmd+/). */
  isCheatSheetOpen: boolean;
  setIsCheatSheetOpen: (open: boolean) => void;
  /** Global search (Cmd+F). */
  isSearchOpen: boolean;
  setIsSearchOpen: (open: boolean) => void;
}

/**
 * App-shell overlay state. Owns the four mutually-stackable overlays the
 * app exposes (settings, command palette, cheat sheet, search) and an Esc
 * handler that closes the topmost open overlay in z-order.
 *
 * Phase 2.02 extraction: today this is a literal state container so the
 * call-site churn stays minimal. A later iteration can crystallize a
 * smaller open(kind)/close(kind) API once every existing site has been
 * audited for which overlay it intends to mutate.
 */
export function useOverlays(): OverlayState {
  const [isSettingsOpen, setIsSettingsOpenRaw] = useState<boolean>(false);
  const [isPaletteOpen, setIsPaletteOpenRaw] = useState<boolean>(false);
  const [isCheatSheetOpen, setIsCheatSheetOpenRaw] = useState<boolean>(false);
  const [isSearchOpen, setIsSearchOpenRaw] = useState<boolean>(false);

  // `useState` setters already have stable identity, but the hook wraps them
  // in `useCallback` indirection so consumers can list them in dep arrays
  // without flagging exhaustive-deps (the lint can't see useState's identity
  // guarantee through the hook boundary).
  const setIsSettingsOpen = useCallback((open: boolean) => setIsSettingsOpenRaw(open), []);
  const setIsPaletteOpen = useCallback((open: boolean) => setIsPaletteOpenRaw(open), []);
  const setIsCheatSheetOpen = useCallback((open: boolean) => setIsCheatSheetOpenRaw(open), []);
  const setIsSearchOpen = useCallback((open: boolean) => setIsSearchOpenRaw(open), []);

  // Esc precedence — closes one overlay per press, from topmost to deepest:
  // palette → search → cheat sheet → settings. Typing-target guard means
  // Esc inside contenteditable / textarea / role=textbox stays in the
  // input (e.g. cancels an inline edit) instead of dismissing chrome.
  const handleEscape = useCallback((): boolean => {
    if (isPaletteOpen) {
      setIsPaletteOpenRaw(false);
      return true;
    }
    if (isSearchOpen) {
      setIsSearchOpenRaw(false);
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
    return false;
  }, [isPaletteOpen, isSearchOpen, isCheatSheetOpen, isSettingsOpen]);

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
    isPaletteOpen,
    setIsPaletteOpen,
    isCheatSheetOpen,
    setIsCheatSheetOpen,
    isSearchOpen,
    setIsSearchOpen
  };
}
