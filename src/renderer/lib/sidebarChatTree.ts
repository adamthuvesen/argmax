import type { SessionSummary, WorkspaceSummary } from "../../shared/types.js";
import { sortWorkspaceGroup } from "./projects.js";
import { chatSessionByWorkspace } from "./workspaceChat.js";

export function buildSidebarChatTree(
  workspaces: readonly WorkspaceSummary[],
  sessions: readonly SessionSummary[],
  detachedIds: ReadonlySet<string>,
  nested: boolean
): {
  childrenByWorkspace: Map<string, WorkspaceSummary[]>;
  rootByWorkspace: Map<string, string>;
  parentByWorkspace: Map<string, string>;
} {
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const chats = chatSessionByWorkspace(sessions);
  const parentByWorkspace = new Map<string, string>();
  const childrenByWorkspace = new Map<string, WorkspaceSummary[]>();
  const rootByWorkspace = new Map(workspaces.map((workspace) => [workspace.id, workspace.id]));
  if (!nested) return { childrenByWorkspace, rootByWorkspace, parentByWorkspace };

  for (const workspace of workspaces) {
    if (workspace.pinned || detachedIds.has(workspace.id)) continue;
    const parentSessionId = chats.get(workspace.id)?.launchedBySessionId;
    const parentId = parentSessionId ? sessionById.get(parentSessionId)?.workspaceId : undefined;
    if (parentId && parentId !== workspace.id && workspaceById.has(parentId)) {
      parentByWorkspace.set(workspace.id, parentId);
    }
  }

  const visited = new Set<string>();
  for (const workspaceId of parentByWorkspace.keys()) {
    const path: string[] = [];
    const position = new Map<string, number>();
    let current: string | undefined = workspaceId;
    while (current && !visited.has(current)) {
      const cycleStart = position.get(current);
      if (cycleStart !== undefined) {
        for (const cycleId of path.slice(cycleStart)) parentByWorkspace.delete(cycleId);
        break;
      }
      position.set(current, path.length);
      path.push(current);
      current = parentByWorkspace.get(current);
    }
    for (const id of path) visited.add(id);
  }

  for (const workspace of workspaces) {
    const parentId = parentByWorkspace.get(workspace.id);
    if (!parentId) continue;
    const children = childrenByWorkspace.get(parentId) ?? [];
    children.push(workspace);
    childrenByWorkspace.set(parentId, children);
    let rootId = parentId;
    while (parentByWorkspace.has(rootId)) rootId = parentByWorkspace.get(rootId)!;
    rootByWorkspace.set(workspace.id, rootId);
  }
  for (const [id, children] of childrenByWorkspace) {
    childrenByWorkspace.set(id, sortWorkspaceGroup(children, []));
  }
  return { childrenByWorkspace, rootByWorkspace, parentByWorkspace };
}
