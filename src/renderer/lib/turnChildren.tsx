import { Fragment, type ReactNode } from "react";
import type { ToolCall } from "./toolCalls.js";

/** One rendered row of a turn body: assistant prose, or a tool call. */
export type TurnBodyChild = {
  kind: "assistant" | "tool";
  id: string;
  node: ReactNode;
};

/**
 * Wrap each run of consecutive tool children in a single `.turn-block-tools`
 * element so adjacent tools share the tight 8px gap, while assistant text and
 * tool runs keep the looser 18px body gap.
 *
 * Shared by the chat transcript ([TurnBlock](../components/TurnBlock.tsx)) and
 * the agent activity pane, which render the same shape and must group it
 * identically — the two had drifted into near-copies of this loop.
 */
export function groupToolRuns(children: TurnBodyChild[]): ReactNode {
  const fragments: ReactNode[] = [];
  let toolRun: TurnBodyChild[] = [];
  const flushTools = (): void => {
    const first = toolRun[0];
    if (!first) return;
    fragments.push(
      <div key={`tools-${first.id}`} className="turn-block-tools">
        {toolRun.map((child) => (
          <Fragment key={child.id}>{child.node}</Fragment>
        ))}
      </div>
    );
    toolRun = [];
  };
  for (const child of children) {
    if (child.kind === "tool") {
      toolRun.push(child);
    } else {
      flushTools();
      fragments.push(<Fragment key={child.id}>{child.node}</Fragment>);
    }
  }
  flushTools();
  return fragments;
}

/**
 * Minimal verbosity: collapse every consecutive run of tool children into a
 * single child rendered by `renderRun`. Anything that is not a tool run —
 * assistant prose, an agent launch, a card — passes through untouched and ends
 * the run, so one line summarizes exactly the work between two things the
 * reader reads.
 *
 * The merged child anchors on the run's first tool id so the line mutates in
 * place ("Read 1 file" → "Read 2 files, edited 1 file") as the run grows,
 * instead of appending a second line under the first.
 *
 * Shared by the chat transcript and the agent activity pane, which collapse
 * the same shape and must summarize it identically.
 */
export function foldToolRunsToSummaries<T extends TurnBodyChild & { runTools?: ToolCall[] }>(
  children: readonly T[],
  renderRun: (tools: ToolCall[]) => ReactNode
): T[] {
  const folded: T[] = [];
  let run: { tools: ToolCall[]; anchor: T } | null = null;
  const flushRun = (): void => {
    if (!run) return;
    const { tools, anchor } = run;
    run = null;
    const first = tools[0];
    folded.push({
      ...anchor,
      kind: "tool",
      id: first ? `activity-${first.id}` : anchor.id,
      node: renderRun(tools)
    });
  };
  for (const child of children) {
    if (child.kind === "tool" && child.runTools && child.runTools.length > 0) {
      if (run) run.tools.push(...child.runTools);
      else run = { tools: [...child.runTools], anchor: child };
      continue;
    }
    flushRun();
    folded.push(child);
  }
  flushRun();
  return folded;
}
