import { getToolTypeBucket, type ToolCall } from "./toolCalls.js";
import { stableHash32 } from "./stableHash.js";
import type { AgentReference } from "../../shared/types.js";
import agentCodenames from "../../shared/agentCodenames.json";

/**
 * Deterministic codenames for spawned subagents: 100 physicists,
 * mathematicians and computer scientists, one surname each. Names are assigned
 * by hashing each spawn's toolUseId and linear-probing past names already taken
 * in the same parent session, so a session can name up to 100 distinct agents
 * before any reuse.
 *
 * The list is ordered by recognisability. The first `HEADLINE_COUNT` entries
 * are the household names, and a session's first spawn always draws from them
 * so the codename people see most often is one they know.
 */
export const SCIENTIST_NAMES: readonly string[] = agentCodenames;

/** How many leading entries of `SCIENTIST_NAMES` a session's first spawn draws from. */
export const HEADLINE_COUNT = 10;

/** The first launch owns identity for a native child. Continuations point back
 * to it, so discovering the provider's child id never renames or remounts the
 * tab that was opened while the launch was still streaming. */
export function agentRootToolUseId(tool: ToolCall): string {
  return tool.agentRootToolUseId
    ?? (tool.providerChildSessionId && tool.parentToolUseId ? tool.parentToolUseId : tool.toolUseId);
}

export function agentCodenameKey(tool: ToolCall): string {
  const root = agentRootToolUseId(tool);
  return tool.providerParentConversationId && tool.providerChildSessionId
    ? `${root}\u0000${tool.providerParentConversationId}\u0000${tool.providerChildSessionId}`
    : root;
}

/**
 * The name a spawn falls back to before the session's events have loaded and a
 * full assignment map exists. May collide across agents — the map is the source
 * of truth for uniqueness.
 */
export function fallbackCodename(toolUseId: string): string {
  return SCIENTIST_NAMES[stableHash32(toolUseId) % SCIENTIST_NAMES.length];
}

/**
 * Assign a distinct scientist name to every agent spawn in `tools`, keyed by
 * toolUseId. `tools` must be in timeline order (which `buildSessionToolCalls`
 * already guarantees), so an earlier agent's name never shifts when a later one
 * spawns — the probe only ever steps over names already claimed by earlier ids.
 * The first spawn probes from a headline slot, every later one from anywhere in
 * the list. Once all 100 names are taken, later spawns reuse
 * `SCIENTIST_NAMES[hash % 100]`.
 *
 * Takes the already-built tool list rather than raw events: every caller has one
 * to hand, and rebuilding it here repeated the whole tool-call reconstruction
 * once more per render.
 */
export function assignAgentCodenames(tools: readonly ToolCall[]): Map<string, string> {
  const assignments = new Map<string, string>();
  const taken = new Set<string>();
  const agentTools = tools.filter((tool) => getToolTypeBucket(tool.name) === "agent");
  for (const tool of agentTools) {
    const key = agentCodenameKey(tool);
    if (assignments.has(key) || !tool.agentCodename) continue;
    assignments.set(key, tool.agentCodename);
    taken.add(tool.agentCodename);
  }
  const agentToolUseIds = agentTools.map(agentCodenameKey);

  for (const toolUseId of agentToolUseIds) {
    if (assignments.has(toolUseId)) continue;
    const hash = stableHash32(toolUseId);
    if (taken.size >= SCIENTIST_NAMES.length) {
      assignments.set(toolUseId, SCIENTIST_NAMES[hash % SCIENTIST_NAMES.length]);
      continue;
    }
    const start = hash % (taken.size === 0 ? HEADLINE_COUNT : SCIENTIST_NAMES.length);
    for (let step = 0; step < SCIENTIST_NAMES.length; step++) {
      const name = SCIENTIST_NAMES[(start + step) % SCIENTIST_NAMES.length];
      if (!taken.has(name)) {
        taken.add(name);
        assignments.set(toolUseId, name);
        break;
      }
    }
  }
  return assignments;
}

/** References the parent can safely use when asking Claude to continue one of
 * its own native children. Unsupported providers never acquire these fields,
 * so this returns no speculative references for them. */
export function claudeAgentReferences(
  tools: readonly ToolCall[],
  codenames: ReadonlyMap<string, string>,
  providerParentConversationId: string | null
): AgentReference[] {
  if (!providerParentConversationId) return [];
  const references = new Map<string, AgentReference>();
  for (const tool of tools) {
    const providerChildSessionId = tool.providerChildSessionId;
    if (
      !providerChildSessionId ||
      tool.providerParentConversationId !== providerParentConversationId ||
      references.has(providerChildSessionId)
    ) continue;
    const name = codenames.get(agentCodenameKey(tool));
    if (!name) continue;
    references.set(providerChildSessionId, {
      name,
      providerChildSessionId,
      providerParentConversationId
    });
  }
  return [...references.values()];
}

/**
 * Resolve the codename to show for a tool row: the assigned name for agent
 * spawns (falling back to the hash-only name if events aren't loaded yet), or
 * undefined for any non-agent tool.
 */
export function codenameForTool(
  tool: ToolCall,
  codenames?: Map<string, string>
): string | undefined {
  if (getToolTypeBucket(tool.name) !== "agent") return undefined;
  const key = agentCodenameKey(tool);
  return codenames?.get(key) ?? fallbackCodename(key);
}
