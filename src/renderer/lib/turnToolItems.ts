import {
  buildToolCallGroup,
  isBashLikeTool,
  type ToolCall,
  type ToolCallGroup,
  type TurnToolItem
} from "./toolCalls.js";

export function foldTurnToolItems(toolItems: TurnToolItem[]): TurnToolItem[] {
  const folded: TurnToolItem[] = [];
  let commandRun: ToolCall[] = [];

  const flushCommandRun = (): void => {
    if (commandRun.length === 0) return;
    if (commandRun.length === 1) {
      const [tool] = commandRun;
      if (tool) folded.push({ kind: "tool", tool });
    } else {
      folded.push({ kind: "tool-group", group: buildToolCallGroup(commandRun) });
    }
    commandRun = [];
  };

  for (const item of toolItems) {
    const tools = item.kind === "tool" ? [item.tool] : item.group.tools;
    if (tools.every((tool) => isBashLikeTool(tool.name))) {
      commandRun.push(...tools);
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

export function toolsNamed(toolItems: TurnToolItem[], name: string): ToolCall[] {
  const matches: ToolCall[] = [];
  for (const item of toolItems) {
    if (item.kind === "tool") {
      if (item.tool.name === name) matches.push(item.tool);
      continue;
    }
    for (const tool of item.group.tools) {
      if (tool.name === name) matches.push(tool);
    }
  }
  return matches;
}

export function visibleTurnToolItem(
  item: TurnToolItem,
  hiddenToolIds: ReadonlySet<string>
): TurnToolItem | null {
  if (item.kind === "tool") {
    return hiddenToolIds.has(item.tool.id) ? null : item;
  }
  const filteredGroup = toolGroupWithoutHiddenTools(item.group, hiddenToolIds);
  if (!filteredGroup) return null;
  if (filteredGroup.tools.length === 1) {
    const [tool] = filteredGroup.tools;
    return tool ? { kind: "tool", tool } : null;
  }
  return { kind: "tool-group", group: filteredGroup };
}
