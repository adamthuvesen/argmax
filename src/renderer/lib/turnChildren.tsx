import { Fragment, type ReactNode } from "react";

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
