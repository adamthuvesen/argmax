import type { ToolCall } from "./toolCalls.js";
import { isAgentToolName } from "./toolCalls.js";
import { activityTitle } from "./agentActivity.js";
import { agentCodenameKey, agentRootToolUseId, codenameForTool } from "./agentNames.js";
import { agentTabId, multitaskTabId } from "./agentTabs.js";
import { emblemForCodename, emblemForKey, type Emblem } from "./agentEmblems.js";
import { multitaskRowStatus, type MultitaskChild } from "./multitask.js";

export type AgentRosterStatus = "running" | "done" | "error";

/** One durable entry in the Agents view. A native child's later assignments
 * update this entry rather than creating another tab. */
export interface AgentRosterEntry {
  id: string;
  codename: string;
  title: string;
  status: AgentRosterStatus;
  emblem: Emblem;
  multitask: MultitaskChild | null;
  rootToolUseId: string | null;
  /** The latest assignment start or terminal edge, used to put resumed work
   * back near the front rather than leaving it at its original launch slot. */
  latestTransitionAt: string;
}

export interface AgentRoster {
  entries: AgentRosterEntry[];
  running: number;
  failed: number;
  completed: number;
}

/** Build the single roster shared by the dock, its count, and the workspace
 * summary. Identity comes from the first launch; current state and copy come
 * from the latest assignment for that identity. */
export function buildAgentRoster(
  tools: readonly ToolCall[],
  codenames: Map<string, string>,
  multitasks: readonly MultitaskChild[] = []
): AgentRoster {
  const runsByIdentity = new Map<string, { first: ToolCall; latest: ToolCall }>();
  for (const tool of tools) {
    if (!isAgentToolName(tool.name)) continue;
    const key = agentCodenameKey(tool);
    const existing = runsByIdentity.get(key);
    if (existing) existing.latest = tool;
    else runsByIdentity.set(key, { first: tool, latest: tool });
  }

  const entries: AgentRosterEntry[] = [
    ...[...runsByIdentity.values()].map(({ first, latest }) => {
      const codename = codenameForTool(first, codenames) ?? "Agent";
      return {
        id: agentTabId(first),
        codename,
        title: activityTitle(latest, agentRootToolUseId(first)),
        status: latest.status,
        emblem: emblemForCodename(codename),
        multitask: null,
        rootToolUseId: agentRootToolUseId(first),
        latestTransitionAt: latest.completedAt ?? latest.createdAt
      };
    }),
    ...multitasks.map((child) => ({
      id: multitaskTabId(child.session.id),
      codename: child.workspace?.taskLabel ?? "Multitask",
      title: child.workspace?.taskLabel ?? child.session.prompt ?? "Multitask",
      status: multitaskRowStatus(child.session.state),
      emblem: emblemForKey(child.session.id),
      multitask: child,
      rootToolUseId: null,
      latestTransitionAt: child.session.lastActivityAt
    }))
  ];

  return {
    entries,
    running: entries.filter((entry) => entry.status === "running").length,
    failed: entries.filter((entry) => entry.status === "error").length,
    completed: entries.filter((entry) => entry.status === "done").length
  };
}

export function newestAgentFirst(a: AgentRosterEntry, b: AgentRosterEntry): number {
  return b.latestTransitionAt.localeCompare(a.latestTransitionAt);
}
