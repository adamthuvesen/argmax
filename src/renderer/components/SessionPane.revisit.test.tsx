import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary, WorkspaceSummary } from "../../shared/types.js";
import { FIXED_NOW_MS, isoAgo } from "../../test/fixedClock.js";
import { baseSession, project, workspace } from "../../test/sessionConversationTestHarness.js";
import { SessionPane } from "./SessionPane.js";

/** The pane's mount reads that docs/performance.md#chat-switch keeps across a switch. */
const RETAINED_READS = [
  "checkpoints.list",
  "goals.get",
  "session.forkLineage",
  "projects.getFolders",
  "providers.discover",
  "review.listChangedFiles",
];

/** Records every `window.argmax` call by path. Subscriptions return an unsubscribe. */
function recordingBridge(replies: Record<string, unknown>): string[] {
  const calls: string[] = [];
  const at = (path: string): unknown =>
    new Proxy(() => {}, {
      get: (_target, name) =>
        typeof name === "string" ? at(path ? `${path}.${name}` : name) : undefined,
      apply: () => {
        calls.push(path);
        if (/^on[A-Z]/.test(path.slice(path.lastIndexOf(".") + 1))) return () => {};
        return Promise.resolve(path in replies ? replies[path] : null);
      },
    });
  Object.defineProperty(window, "argmax", { configurable: true, writable: true, value: at("") });
  return calls;
}

function pane(session: SessionSummary, checkout: WorkspaceSummary) {
  return (
    <SessionPane
      approvals={[]}
      onLoadSessionEvents={vi.fn().mockResolvedValue(undefined)}
      onResolveApproval={vi.fn().mockResolvedValue(undefined)}
      onSendSessionInput={vi.fn().mockResolvedValue(undefined)}
      onCancelQueuedMessage={vi.fn().mockResolvedValue(undefined)}
      onSendQueuedMessageNow={vi.fn().mockResolvedValue(undefined)}
      onTerminateSession={vi.fn().mockResolvedValue(undefined)}
      onClearSession={vi.fn().mockResolvedValue(undefined)}
      project={project}
      session={session}
      workspace={checkout}
    />
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
  });
}

const reads = (calls: readonly string[]) => calls.filter((path) => RETAINED_READS.includes(path));

describe("SessionPane revisit", () => {
  let calls: string[];
  const session = baseSession({ lastActivityAt: isoAgo(60_000) });
  const checkout = { ...workspace, lastActivityAt: isoAgo(60_000) };

  beforeEach(() => {
    vi.setSystemTime(FIXED_NOW_MS);
    calls = recordingBridge({
      "checkpoints.list": [],
      "review.listChangedFiles": [],
      "providers.discover": [],
      "projects.getFolders": [],
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    delete (window as unknown as { argmax?: unknown }).argmax;
  });

  async function visit(visited: SessionSummary, visitedCheckout: WorkspaceSummary) {
    const view = render(pane(visited, visitedCheckout));
    await waitFor(() => expect(new Set(reads(calls))).toEqual(new Set(RETAINED_READS)));
    await settle();
    view.unmount();
    calls.length = 0;
  }

  it("revisiting an unchanged chat issues none of the reads it kept", async () => {
    await visit(session, checkout);

    render(pane(session, checkout));
    await settle();

    expect(reads(calls)).toEqual([]);
  });

  it("revisiting after a turn moved the freshness keys rereads only what those keys cover", async () => {
    await visit(session, checkout);

    const now = isoAgo(0);
    render(
      pane(
        { ...session, state: "running", lastActivityAt: now },
        { ...checkout, lastActivityAt: now },
      ),
    );
    await settle();

    expect(reads(calls).sort()).toEqual(["checkpoints.list", "review.listChangedFiles"]);
  });
});
