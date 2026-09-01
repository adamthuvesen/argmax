/**
 * Review-panel file-tab close bus. Menu ⌘W and the global keybinding reach
 * App before focus-sensitive handlers inside the tree can run, so the focused
 * pane's ReviewPanel registers a close handler while Files mode has an open tab.
 */

let closeActiveTab: (() => void) | null = null;

export function registerReviewFileTabCloseHandler(handler: (() => void) | null): void {
  closeActiveTab = handler;
}

/** Close the active review file tab when a handler is registered. */
export function requestCloseActiveReviewFileTab(): boolean {
  if (!closeActiveTab) return false;
  closeActiveTab();
  return true;
}
