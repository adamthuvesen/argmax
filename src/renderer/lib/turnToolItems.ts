import { isAgentToolName, type ToolCall, type TurnToolItem } from "./toolCalls.js";
export type { TurnToolItem } from "./toolCalls.js";

export function latestToolCreatedAt(toolItems: readonly TurnToolItem[]): string | null {
  let latest: string | null = null;
  for (const tool of allTools(toolItems)) {
    if (latest === null || tool.createdAt > latest) latest = tool.createdAt;
  }
  return latest;
}

function allTools(toolItems: readonly TurnToolItem[]): ToolCall[] {
  return toolItems.map((item) => item.tool);
}

function attachAgentChildren(toolItems: readonly TurnToolItem[]): TurnToolItem[] {
  const tools = allTools(toolItems);
  const agentToolUseIds = new Set(
    tools.filter((tool) => isAgentToolName(tool.name)).map((tool) => tool.toolUseId)
  );

  const childIds = new Set<string>();
  const childrenByParent = new Map<string, ToolCall[]>();
  for (const tool of tools) {
    const parent = tool.parentToolUseId;
    if (!parent || parent === tool.toolUseId || !agentToolUseIds.has(parent)) continue;
    childIds.add(tool.id);
    const children = childrenByParent.get(parent) ?? [];
    children.push(tool);
    childrenByParent.set(parent, children);
  }

  const withChildren = (tool: ToolCall): TurnToolItem => {
    const children = childrenByParent.get(tool.toolUseId);
    return children && children.length > 0 ? { kind: "tool", tool, children } : { kind: "tool", tool };
  };

  const nested: TurnToolItem[] = [];
  for (const item of toolItems) {
    if (!childIds.has(item.tool.id)) nested.push(withChildren(item.tool));
  }
  return nested;
}

// Keep individual timestamps until tools are interleaved with visible prose.
// Grouping here would merge commands across messages that live in another list.
export function foldTurnToolItems(toolItems: readonly TurnToolItem[]): TurnToolItem[] {
  return attachAgentChildren(toolItems);
}

export function visibleTurnToolItem(
  item: TurnToolItem,
  hiddenToolIds: ReadonlySet<string>
): TurnToolItem | null {
  if (hiddenToolIds.has(item.tool.id)) return null;
  const children = (item.children ?? []).filter((tool) => !hiddenToolIds.has(tool.id));
  if (children.length === (item.children ?? []).length) return item;
  return children.length > 0 ? { ...item, children } : { kind: "tool", tool: item.tool };
}
