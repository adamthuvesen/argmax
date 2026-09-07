import type { ToolCall } from "./toolCalls.js";
import { isAgentToolName } from "./toolCalls.js";
import { multitaskRowStatus, type MultitaskChild } from "./multitask.js";
import { stableHash32 } from "./stableHash.js";
import { activityTitle } from "./agentActivity.js";
import { agentCodenameKey, codenameForTool } from "./agentNames.js";
import { agentTabId } from "./agentTabs.js";
import { emblemForCodename, type Emblem } from "./agentEmblems.js";
import { SESSION_ICON_COLORS } from "./sessionIcons.js";

export type SubagentClusterStatus = "running" | "done" | "error";

export type SubagentClusterEntry = {
  toolUseId: string;
  codename: string;
  title: string;
  status: SubagentClusterStatus;
  /** Session icon-palette name driving the avatar chip color. */
  iconColor: string;
  /** The subagent's mark. Null for a multitask, which the Split glyph names. */
  emblem: Emblem | null;
  /** A multitask is a chat running alongside, not an agent's own subagent. */
  multitask: boolean;
};

export type SubagentCluster = {
  entries: SubagentClusterEntry[];
  running: number;
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
  const spawnsByIdentity = new Map<string, { first: ToolCall; latest: ToolCall }>();
  for (const tool of tools) {
    if (!isAgentToolName(tool.name)) continue;
    const identityKey = agentCodenameKey(tool);
    const existing = spawnsByIdentity.get(identityKey);
    if (existing) existing.latest = tool;
    else spawnsByIdentity.set(identityKey, { first: tool, latest: tool });
  }
  const spawns = [...spawnsByIdentity.entries()];
  if (spawns.length === 0 && multitasks.length === 0) return null;
  const entries: SubagentClusterEntry[] = [
    ...spawns.map(([, { first, latest }]) => {
      const codename = codenameForTool(first, codenames) ?? "Agent";
      const emblem = emblemForCodename(codename);
      return {
        toolUseId: agentTabId(first),
        codename,
        title: activityTitle(first, first.toolUseId),
        status: latest.status,
        // The ring wears the emblem's hue, not a second hash: a teal mark on a
        // red chip would read as two identities for one agent.
        iconColor: emblem.hue,
        emblem,
        multitask: false
      };
    }),
    ...multitasks.map((child) => ({
      toolUseId: child.session.id,
      codename: child.workspace?.taskLabel ?? "Multitask",
      title: child.workspace?.taskLabel ?? "Multitask",
      status: multitaskRowStatus(child.session.state),
      iconColor: SESSION_ICON_COLORS[stableHash32(child.session.id) % SESSION_ICON_COLORS.length] ?? "blue",
      emblem: null,
      multitask: true
    }))
  ];
  return {
    entries,
    running: entries.filter((entry) => entry.status === "running").length,
    hasMultitask: entries.some((entry) => entry.multitask)
  };
}
