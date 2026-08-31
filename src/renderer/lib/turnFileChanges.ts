import { interpretFileChange, type FileChange } from "./fileChange.js";
import type { ToolCall, TurnToolItem } from "./toolCalls.js";

/** One file a turn wrote, with the whole turn's line stat for it folded in.
 *  A turn edits the same file three times and the chat shows one row. */
export interface TurnFileChange {
  path: string;
  /** How the turn as a whole left the file. A file created and then edited is
   *  a create; one edited and then deleted is a delete. */
  kind: FileChange["kind"];
  adds: number;
  dels: number;
  /** How many tool calls in this turn touched the file. */
  writes: number;
}

function flattenTurnTools(items: readonly TurnToolItem[]): ToolCall[] {
  const tools: ToolCall[] = [];
  for (const item of items) {
    if (item.kind === "tool") {
      tools.push(item.tool, ...(item.children ?? []));
      continue;
    }
    tools.push(...item.group.tools);
  }
  return tools;
}

/**
 * Every file the turn wrote, in the order the turn first touched them, folded
 * one row per path. Reads the same per-tool input the expanded tool rows and
 * `summarizeToolChangeCounts` read, so the card can never disagree with the
 * activity rows above it.
 */
export function collectTurnFileChanges(items: readonly TurnToolItem[]): TurnFileChange[] {
  const byPath = new Map<string, TurnFileChange>();
  for (const tool of flattenTurnTools(items)) {
    const changes = interpretFileChange(tool.name, tool.inputFull);
    if (!changes) continue;
    for (const change of changes) {
      const existing = byPath.get(change.path);
      const adds = change.kind === "delete" ? 0 : change.addCount;
      const dels = change.kind === "edit" ? change.delCount : 0;
      if (!existing) {
        byPath.set(change.path, { path: change.path, kind: change.kind, adds, dels, writes: 1 });
        continue;
      }
      existing.adds += adds;
      existing.dels += dels;
      existing.writes += 1;
      // The turn's verdict on the file is its last word, except that a create
      // survives later edits: the file is still new to the tree.
      if (change.kind === "delete") existing.kind = "delete";
      else if (existing.kind === "edit") existing.kind = change.kind;
    }
  }
  return [...byPath.values()];
}

/** Roll a turn's per-file rows into the `N files +A −D` the card's header
 *  shows. Deleted files count as files but carry no line stat — their content
 *  never reached us, so a number would be a guess. */
export function summarizeTurnFileChanges(changes: readonly TurnFileChange[]): {
  files: number;
  adds: number;
  dels: number;
} {
  let adds = 0;
  let dels = 0;
  for (const change of changes) {
    adds += change.adds;
    dels += change.dels;
  }
  return { files: changes.length, adds, dels };
}
