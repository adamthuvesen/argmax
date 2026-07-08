import {
  buildToolCallGroup,
  isBashLikeTool,
  isAgentToolName,
  type ToolCall,
  type ToolCallGroup,
  type TurnToolItem
} from "./toolCalls.js";

function allTools(toolItems: readonly TurnToolItem[]): ToolCall[] {
  const out: ToolCall[] = [];
  for (const item of toolItems) {
    if (item.kind === "tool") {
      out.push(item.tool);
      continue;
    }
    out.push(...item.group.tools);
  }
  return out;
}

function attachAgentChildren(toolItems: readonly TurnToolItem[]): TurnToolItem[] {
  const tools = allTools(toolItems);
  const agentToolUseIds = new Set(
    tools.filter((tool) => isAgentToolName(tool.name)).map((tool) => tool.toolUseId)
  );
  if (agentToolUseIds.size === 0) return [...toolItems];

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
  if (childIds.size === 0) return [...toolItems];

  const withChildren = (tool: ToolCall): TurnToolItem => {
    const children = childrenByParent.get(tool.toolUseId);
    return children && children.length > 0 ? { kind: "tool", tool, children } : { kind: "tool", tool };
  };

  const nested: TurnToolItem[] = [];
  for (const item of toolItems) {
    if (item.kind === "tool") {
      if (!childIds.has(item.tool.id)) nested.push(withChildren(item.tool));
      continue;
    }
    const visibleTools = item.group.tools.filter((tool) => !childIds.has(tool.id));
    if (visibleTools.length === 0) continue;
    if (visibleTools.length === 1) {
      const [tool] = visibleTools;
      if (tool) nested.push(withChildren(tool));
      continue;
    }
    nested.push({ kind: "tool-group", group: buildToolCallGroup(visibleTools) });
  }
  return nested;
}

export function foldTurnToolItems(toolItems: readonly TurnToolItem[]): TurnToolItem[] {
  const nestedItems = attachAgentChildren(toolItems);
  const folded: TurnToolItem[] = [];
  let commandRun: ToolCall[] = [];

  const flushCommandRun = (): void => {
    if (commandRun.length === 0) return;
    folded.push({ kind: "tool-group", group: buildToolCallGroup(commandRun) });
    commandRun = [];
  };

  for (const item of nestedItems) {
    if (item.kind === "tool-group") {
      flushCommandRun();
      folded.push(item);
      continue;
    }
    if (isBashLikeTool(item.tool.name)) {
      commandRun.push(item.tool);
      continue;
    }
    flushCommandRun();
    folded.push(item);
  }

  flushCommandRun();
  return folded;
}

function toolGroupWithoutHiddenTools(
  group: ToolCallGroup,
  hiddenToolIds: ReadonlySet<string>
): ToolCallGroup | null {
  const visibleTools = group.tools.filter((tool) => !hiddenToolIds.has(tool.id));
  if (visibleTools.length === 0) return null;
  if (visibleTools.length === group.tools.length) return group;
  return { ...buildToolCallGroup(visibleTools), id: group.id };
}

export function visibleTurnToolItem(
  item: TurnToolItem,
  hiddenToolIds: ReadonlySet<string>
): TurnToolItem | null {
  if (item.kind === "tool") {
    if (hiddenToolIds.has(item.tool.id)) return null;
    const children = (item.children ?? []).filter((tool) => !hiddenToolIds.has(tool.id));
    if (children.length === (item.children ?? []).length) return item;
    return children.length > 0 ? { ...item, children } : { kind: "tool", tool: item.tool };
  }
  const filteredGroup = toolGroupWithoutHiddenTools(item.group, hiddenToolIds);
  if (!filteredGroup) return null;
  if (filteredGroup.tools.length === 1) {
    if (item.group.tools.length === 1) return { kind: "tool-group", group: filteredGroup };
    const [tool] = filteredGroup.tools;
    return tool ? { kind: "tool", tool } : null;
  }
  return { kind: "tool-group", group: filteredGroup };
}
