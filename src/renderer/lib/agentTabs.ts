/**
 * The review panel's Agents dock holds two kinds of tab, both of which are
 * work running under the chat beside them: a subagent the provider spawned
 * inside a tool call, and a multitask — a sibling chat dispatched from the
 * composer. They share one tab strip because they are the same thing to the
 * reader ("what else is running for me right now"), so one id space carries
 * both.
 */
export type AgentTab =
  | { kind: "subagent"; toolUseId: string }
  | { kind: "multitask"; sessionId: string };

const MULTITASK_TAB_PREFIX = "multitask:";

export function multitaskTabId(sessionId: string): string {
  return `${MULTITASK_TAB_PREFIX}${sessionId}`;
}

/** A tab id is a provider tool-use id unless it carries the multitask prefix,
 *  which no provider emits. */
export function readAgentTab(tabId: string): AgentTab {
  return tabId.startsWith(MULTITASK_TAB_PREFIX)
    ? { kind: "multitask", sessionId: tabId.slice(MULTITASK_TAB_PREFIX.length) }
    : { kind: "subagent", toolUseId: tabId };
}
