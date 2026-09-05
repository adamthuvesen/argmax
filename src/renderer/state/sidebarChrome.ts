import { useSyncExternalStore } from "react";
import { SIDEBAR_COLLAPSED_KEY, writeBooleanPreference } from "../lib/uiPreferences.js";

// Whether the sidebar is collapsed, and whether it is currently peeking.
//
// Collapsing is persisted; peeking — the hover-out overlay a collapsed sidebar
// slides in — is not. Both the shell (which sizes the grid column and paints
// the toggle) and the sidebar itself read them, and the peek is ended by the
// sidebar's own pointer leaving, so neither owns the pair.

export interface SidebarChromeSnapshot {
  collapsed: boolean;
  peeking: boolean;
}

// Read lazily rather than at import: the module is loaded before a test has
// seeded localStorage, and the app boots long after.
let state: SidebarChromeSnapshot | null = null;
const listeners = new Set<() => void>();

// Local rather than shared with `uiPreferences`, which keeps its reader
// private for the `useBooleanUiPreference` hook.
function storedCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
}

function current(): SidebarChromeSnapshot {
  state ??= { collapsed: storedCollapsed(), peeking: false };
  return state;
}

function publish(next: SidebarChromeSnapshot): void {
  state = next;
  for (const listener of listeners) listener();
}

/** Collapsing also ends any peek, so the sidebar does not slide back in. */
export function toggleSidebarCollapsed(): void {
  const collapsed = !current().collapsed;
  writeBooleanPreference(SIDEBAR_COLLAPSED_KEY, collapsed);
  publish({ collapsed, peeking: false });
}

export function setSidebarPeek(peeking: boolean): void {
  if (current().peeking === peeking) return;
  publish({ ...current(), peeking });
}

export function subscribeSidebarChrome(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable between mutations, so `useSyncExternalStore` does not loop. */
export function sidebarChromeSnapshot(): SidebarChromeSnapshot {
  return current();
}

export function useSidebarChrome(): SidebarChromeSnapshot {
  return useSyncExternalStore(subscribeSidebarChrome, sidebarChromeSnapshot, sidebarChromeSnapshot);
}

/** Re-reads the persisted collapse, so a test can seed it before rendering. */
export function resetSidebarChromeForTests(): void {
  state = null;
  for (const listener of listeners) listener();
}
