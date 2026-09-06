/**
 * The review panel's Agents dock holds two kinds of tab, both of which are
 * work running under the chat beside them: a subagent the provider spawned
 * inside a tool call, and a multitask — a sibling chat dispatched from the
 * composer. They share one tab strip because they are the same thing to the
 * reader ("what else is running for me right now"), so one id space carries
 * both.
 */
export type AgentTab =
  | {
      kind: "subagent";
      toolUseId: string;
      providerParentConversationId: string | null;
      providerChildSessionId: string | null;
    }
  | { kind: "multitask"; sessionId: string };

const MULTITASK_TAB_PREFIX = "multitask:";
const NATIVE_AGENT_TAB_PREFIX = "native-agent:";

export function multitaskTabId(sessionId: string): string {
  return `${MULTITASK_TAB_PREFIX}${sessionId}`;
}

/** A tab id is a provider tool-use id unless it carries the multitask prefix,
 *  which no provider emits. */
export function readAgentTab(tabId: string): AgentTab {
  if (tabId.startsWith(MULTITASK_TAB_PREFIX)) {
    return { kind: "multitask", sessionId: tabId.slice(MULTITASK_TAB_PREFIX.length) };
  }
  if (tabId.startsWith(NATIVE_AGENT_TAB_PREFIX)) {
    const [toolUseId, providerParentConversationId, providerChildSessionId] = tabId
      .slice(NATIVE_AGENT_TAB_PREFIX.length)
      .split(":")
      .map((part) => decodeURIComponent(part));
    if (toolUseId && providerParentConversationId && providerChildSessionId) {
      return { kind: "subagent", toolUseId, providerParentConversationId, providerChildSessionId };
    }
  }
  return {
    kind: "subagent",
    toolUseId: tabId,
    providerParentConversationId: null,
    providerChildSessionId: null
  };
}

/** Native continuations reopen the first launch's tab. Legacy runs keep their
 * invocation id, preserving the existing one-tab-per-launch behavior. */
export function agentTabId(tool: { toolUseId: string; parentToolUseId?: string | null; providerChildSessionId?: string | null; providerParentConversationId?: string | null; agentRootToolUseId?: string | null }): string {
  const rootToolUseId = typeof tool.agentRootToolUseId === "string"
    ? tool.agentRootToolUseId
    : tool.providerChildSessionId && tool.parentToolUseId
    ? tool.parentToolUseId
    : tool.toolUseId;
  const parent = typeof tool.providerParentConversationId === "string"
    ? tool.providerParentConversationId
    : null;
  return tool.providerChildSessionId && parent
    ? `${NATIVE_AGENT_TAB_PREFIX}${[rootToolUseId, parent, tool.providerChildSessionId].map(encodeURIComponent).join(":")}`
    : rootToolUseId;
}
