import { useSyncExternalStore } from "react";

export const SIDEBAR_CHAT_NESTING_STORAGE_KEY = "argmax.sidebar.chatNesting";

interface SidebarChatNesting {
  nested: boolean;
  detachedIds: ReadonlySet<string>;
}

function storedSidebarChatNesting(): SidebarChatNesting {
  if (typeof window !== "undefined") {
    try {
      const raw = window.localStorage.getItem(SIDEBAR_CHAT_NESTING_STORAGE_KEY);
      const stored: unknown = raw === null ? null : JSON.parse(raw);
      if (stored && typeof stored === "object" && "nested" in stored && "detachedIds" in stored &&
        typeof stored.nested === "boolean" && Array.isArray(stored.detachedIds) &&
        stored.detachedIds.every((id): id is string => typeof id === "string" && id.length > 0)) {
        return { nested: stored.nested, detachedIds: new Set(stored.detachedIds) };
      }
    } catch {
      // A blocked or invalid preference uses the default for this session.
    }
  }
  return { nested: true, detachedIds: new Set() };
}

let state: SidebarChatNesting | null = null;
const listeners = new Set<() => void>();

function sidebarChatNestingSnapshot(): SidebarChatNesting {
  state ??= storedSidebarChatNesting();
  return state;
}

function publishSidebarChatNesting(next: SidebarChatNesting): void {
  state = next;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(SIDEBAR_CHAT_NESTING_STORAGE_KEY, JSON.stringify({
        nested: next.nested,
        detachedIds: [...next.detachedIds]
      }));
    } catch {
      // The choice still applies when storage is unavailable.
    }
  }
  for (const listener of listeners) listener();
}

export function setSidebarChatsNested(nested: boolean): void {
  const current = sidebarChatNestingSnapshot();
  if (current.nested === nested) return;
  publishSidebarChatNesting({ ...current, nested });
}

export function detachSidebarChat(workspaceId: string): void {
  const current = sidebarChatNestingSnapshot();
  if (current.detachedIds.has(workspaceId)) return;
  publishSidebarChatNesting({ ...current, detachedIds: new Set([...current.detachedIds, workspaceId]) });
}

function subscribeSidebarChatNesting(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useSidebarChatNesting(): SidebarChatNesting {
  return useSyncExternalStore(subscribeSidebarChatNesting, sidebarChatNestingSnapshot, sidebarChatNestingSnapshot);
}

export function resetSidebarChatNestingForTests(): void {
  state = null;
  for (const listener of listeners) listener();
}
