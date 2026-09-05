import { useSyncExternalStore } from "react";
import type { ToastMessage } from "../lib/withToast.js";

// The shell's single transient message.
//
// Every failing action in the app wants to say so, and threading `setToast`
// down to each one is what made the shell own code that has nothing to do with
// layout. The message is app-wide and there is only ever one, so it lives here
// and the shell subscribes to render it. Auto-dismissal for info toasts stays
// in the shell: it is a rendering concern with a timer, not state.

let toast: ToastMessage | null = null;
const listeners = new Set<() => void>();

function publish(next: ToastMessage | null): void {
  if (next === toast) return;
  toast = next;
  for (const listener of listeners) listener();
}

export function showToast(message: ToastMessage): void {
  publish(message);
}

export function showErrorToast(message: string): void {
  publish({ kind: "error", message });
}

export function showInfoToast(message: string): void {
  publish({ kind: "info", message });
}

export function dismissToast(): void {
  publish(null);
}

export function subscribeToast(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable between publishes, so `useSyncExternalStore` does not loop. */
export function toastSnapshot(): ToastMessage | null {
  return toast;
}

export function useToast(): ToastMessage | null {
  return useSyncExternalStore(subscribeToast, toastSnapshot, toastSnapshot);
}

export function resetToastForTests(): void {
  publish(null);
}
