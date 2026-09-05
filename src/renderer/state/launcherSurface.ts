import { useSyncExternalStore } from "react";

// The standalone launcher: the full-screen new-chat surface, whether the next
// launch composes a repo-less side chat, and the signal that clears a composed
// draft.
//
// None of it persists — only the user's Settings choice of `full` vs in-grid
// does — but every entry point into a new chat (the sidebar, the Argmax menu,
// a pane menu, an early stop) has to set it, which is why it does not belong
// to any one of them.

export interface LauncherSurfaceSnapshot {
  /** `full` new-session mode hides the grid and renders the launcher instead. */
  fullLauncherOpen: boolean;
  /** Compose a repo-less side chat rather than a project session. */
  sideChatMode: boolean;
  /** Bumped to tell a mounted launcher to drop what the user typed. */
  resetSignal: number;
}

const INITIAL: LauncherSurfaceSnapshot = {
  fullLauncherOpen: false,
  sideChatMode: false,
  resetSignal: 0
};

let state: LauncherSurfaceSnapshot = INITIAL;
const listeners = new Set<() => void>();

function publish(next: LauncherSurfaceSnapshot): void {
  if (
    next.fullLauncherOpen === state.fullLauncherOpen &&
    next.sideChatMode === state.sideChatMode &&
    next.resetSignal === state.resetSignal
  ) {
    return;
  }
  state = next;
  for (const listener of listeners) listener();
}

export function showFullLauncher(): void {
  publish({ ...state, fullLauncherOpen: true });
}

export function hideFullLauncher(): void {
  publish({ ...state, fullLauncherOpen: false });
}

export function setLauncherSideChatMode(sideChat: boolean): void {
  publish({ ...state, sideChatMode: sideChat });
}

/** Tells a mounted launcher to clear its composer before the next entry. */
export function requestLauncherReset(): void {
  publish({ ...state, resetSignal: state.resetSignal + 1 });
}

export function subscribeLauncherSurface(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function launcherSurfaceSnapshot(): LauncherSurfaceSnapshot {
  return state;
}

export function useLauncherSurface(): LauncherSurfaceSnapshot {
  return useSyncExternalStore(subscribeLauncherSurface, launcherSurfaceSnapshot, launcherSurfaceSnapshot);
}

export function resetLauncherSurfaceForTests(): void {
  state = INITIAL;
  for (const listener of listeners) listener();
}
