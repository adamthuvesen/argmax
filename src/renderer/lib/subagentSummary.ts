import type { ToolCall } from "./toolCalls.js";
import type { MultitaskChild } from "./multitask.js";
import type { Emblem } from "./agentEmblems.js";
import { buildAgentRoster } from "./agentRoster.js";

type SubagentClusterStatus = "running" | "done" | "error";

type SubagentClusterEntry = {
  toolUseId: string;
  codename: string;
  title: string;
  status: SubagentClusterStatus;
  /** Session icon-palette name driving the avatar chip color. */
  iconColor: string;
  /** The mark: a subagent's from its codename, a multitask's from its session
   *  id. Never null — a row with an empty box is the one that looks broken. */
  emblem: Emblem;
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
  const roster = buildAgentRoster(tools, codenames, multitasks);
  if (roster.entries.length === 0) return null;
  const entries: SubagentClusterEntry[] = roster.entries.map((entry) => ({
    toolUseId: entry.multitask ? entry.multitask.session.id : entry.id,
    codename: entry.codename,
    title: entry.title,
    status: entry.status,
    iconColor: entry.emblem.hue,
    emblem: entry.emblem,
    multitask: entry.multitask !== null
  }));
  return {
    entries,
    running: roster.running,
    hasMultitask: entries.some((entry) => entry.multitask)
  };
}
