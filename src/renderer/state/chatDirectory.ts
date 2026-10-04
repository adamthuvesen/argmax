import { useSyncExternalStore } from "react";
import {
  SCRATCH_PROJECT_ID,
  type DashboardSnapshot
} from "../../shared/types.js";
import { titleFromPrompt } from "../lib/projects.js";

// The chats a prompt can name, and the way to open one.
//
// A composer sits several components below the dashboard snapshot, and the
// chat reference menu and the chip's click need only two things from it: the
// list of chats and "open this one". The shell publishes both here, the way
// it publishes the launcher surface, so neither has to be threaded through
// every pane and cell between them. A host with no dashboard (the browser
// preview) never publishes, and the composer simply offers no chats.

export interface ChatDirectoryEntry {
  sessionId: string;
  workspaceId: string;
  /** The task label shown on the sidebar row. */
  title: string;
  /** Empty for a scratch Chat, which belongs to no repository. */
  projectName: string;
  lastActivityAt: string;
}

const NO_CHATS: readonly ChatDirectoryEntry[] = [];

let entries: readonly ChatDirectoryEntry[] = NO_CHATS;
let opener: ((entry: ChatDirectoryEntry) => void) | null = null;
const listeners = new Set<() => void>();

/** The chats in a snapshot, newest activity first. */
export function chatDirectoryFromSnapshot(
  snapshot: Pick<DashboardSnapshot, "projects" | "workspaces" | "sessions">
): ChatDirectoryEntry[] {
  const workspaceById = new Map(snapshot.workspaces.map((workspace) => [workspace.id, workspace]));
  const projectById = new Map(snapshot.projects.map((project) => [project.id, project]));
  const directory: ChatDirectoryEntry[] = [];
  for (const session of snapshot.sessions) {
    const workspace = workspaceById.get(session.workspaceId);
    if (!workspace) continue;
    const project = projectById.get(workspace.projectId);
    directory.push({
      sessionId: session.id,
      workspaceId: workspace.id,
      title: workspace.taskLabel || titleFromPrompt(session.prompt) || session.modelLabel,
      projectName: project && project.id !== SCRATCH_PROJECT_ID ? project.name : "",
      lastActivityAt: session.lastActivityAt
    });
  }
  return directory.sort((left, right) =>
    left.lastActivityAt === right.lastActivityAt
      ? 0
      : left.lastActivityAt < right.lastActivityAt
        ? 1
        : -1
  );
}

export function publishChatDirectory(next: readonly ChatDirectoryEntry[]): void {
  entries = next;
  for (const listener of listeners) listener();
}

/** Register how a click on a chat chip opens the chat. Returns the unregister. */
export function registerChatOpener(open: (entry: ChatDirectoryEntry) => void): () => void {
  opener = open;
  return () => {
    if (opener === open) opener = null;
  };
}

export function lookUpChat(sessionId: string): ChatDirectoryEntry | null {
  return entries.find((entry) => entry.sessionId === sessionId) ?? null;
}

/** Opens a chat the directory knows. False when it is gone or nothing can open it. */
export function openChat(sessionId: string): boolean {
  const entry = lookUpChat(sessionId);
  if (!entry || !opener) return false;
  opener(entry);
  return true;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useChatDirectory(): readonly ChatDirectoryEntry[] {
  return useSyncExternalStore(subscribe, () => entries, () => entries);
}

/**
 * Chats whose title holds every word of the query, best first: a title that
 * starts with the query, then one with a word that does, then any other hit,
 * newest within each. The directory is already newest first and the sort is
 * stable, so equal ranks keep that order.
 */
export function searchChatTitles(
  directory: readonly ChatDirectoryEntry[],
  query: string,
  limit: number
): ChatDirectoryEntry[] {
  const needles = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (needles.length === 0) return [];
  const phrase = needles.join(" ");
  const ranked: Array<{ entry: ChatDirectoryEntry; rank: number }> = [];
  for (const entry of directory) {
    const title = entry.title.toLowerCase();
    if (!needles.every((needle) => title.includes(needle))) continue;
    const rank = title.startsWith(phrase)
      ? 0
      : title.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(needles[0]))
        ? 1
        : 2;
    ranked.push({ entry, rank });
  }
  return ranked
    .sort((left, right) => left.rank - right.rank)
    .slice(0, limit)
    .map(({ entry }) => entry);
}

export function resetChatDirectoryForTests(): void {
  entries = NO_CHATS;
  opener = null;
  for (const listener of listeners) listener();
}
