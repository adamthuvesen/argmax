import type { ToolCall } from "./toolCalls.js";
import { isAgentToolName } from "./toolCalls.js";
import { multitaskRowStatus, type MultitaskChild } from "./multitask.js";
import { stableHash32 } from "./stableHash.js";
import { activityTitle } from "./agentActivity.js";
import { codenameForTool } from "./agentNames.js";
import { SESSION_ICON_COLORS } from "./sessionIcons.js";

export type SubagentClusterStatus = "running" | "done" | "error";

export type SubagentClusterEntry = {
  toolUseId: string;
  codename: string;
  title: string;
  status: SubagentClusterStatus;
  /** Session icon-palette name driving the avatar chip color. */
  iconColor: string;
  /** A multitask is a chat running alongside, not an agent's own subagent. */
  multitask: boolean;
};

export type SubagentCluster = {
  entries: SubagentClusterEntry[];
  running: number;
  done: number;
  failed: number;
  /** True when any entry is a multitask, which the section is named for. */
  hasMultitask: boolean;
};

/**
 * The subagent launches inside a session, in spawn order, with the statuses
 * the agent tabs already show. Built from the pane's own tool list — the same
 * `buildSessionToolCalls` output the tabs pane reads, with its codename
 * assignments — so the card never disagrees with the tabs it sits beside.
 * Null when the session has nothing running alongside it, so the card can
 * drop the section entirely.
 *
 * Multitasks count too: they share the dock's tab strip with the subagents, so
 * a card that left them out disagreed with the tabs it sits beside.
 */
export function buildSubagentCluster(
  tools: readonly ToolCall[],
  codenames: Map<string, string>,
  multitasks: readonly MultitaskChild[] = []
): SubagentCluster | null {
  const spawns = tools.filter((tool) => isAgentToolName(tool.name));
  if (spawns.length === 0 && multitasks.length === 0) return null;
  const entries: SubagentClusterEntry[] = [
    ...spawns.map((tool) => ({
      toolUseId: tool.toolUseId,
      codename: codenameForTool(tool, codenames) ?? "Agent",
      title: activityTitle(tool, tool.toolUseId),
      status: tool.status,
      iconColor: SESSION_ICON_COLORS[stableHash32(tool.toolUseId) % SESSION_ICON_COLORS.length] ?? "blue",
      multitask: false
    })),
    ...multitasks.map((child) => ({
      toolUseId: child.session.id,
      codename: child.workspace?.taskLabel ?? "Multitask",
      title: child.workspace?.taskLabel ?? "Multitask",
      status: multitaskRowStatus(child.session.state),
      iconColor: SESSION_ICON_COLORS[stableHash32(child.session.id) % SESSION_ICON_COLORS.length] ?? "blue",
      multitask: true
    }))
  ];
  return {
    entries,
    running: entries.filter((entry) => entry.status === "running").length,
    done: entries.filter((entry) => entry.status === "done").length,
    failed: entries.filter((entry) => entry.status === "error").length,
    hasMultitask: entries.some((entry) => entry.multitask)
  };
}
