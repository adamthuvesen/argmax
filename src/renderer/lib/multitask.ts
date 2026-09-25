import type { ApprovalRequest, SessionSummary, TimelineEvent, WorkspaceSummary } from "../../shared/types.js";
import { decodeTimelineEvent } from "./canonicalTimeline.js";

/**
 * A multitask as the parent chat sees it. `state` is null while it is still
 * running: the launch row is written at dispatch and the finish row arrives
 * later, so the card fills in rather than being replaced.
 */
export interface MultitaskNotice {
  childSessionId: string | null;
  taskLabel: string;
  prompt: string | null;
  worktree: boolean;
  state: string | null;
  answer: string | null;
  /** When it was dispatched. Composer rows keep this launch order even when a
   *  finish event arrives during a later turn. */
  createdAt: string;
}

export type MultitaskDisplayStatus = "running" | "done" | "needs-you" | "failed" | "stopped";

/** The session is authoritative when available; attention can require a reply mid-turn. */
export function multitaskDisplayStatus(
  state: string | null,
  attention?: SessionSummary["attention"] | null
): MultitaskDisplayStatus {
  if (state === "failed") return "failed";
  if (state === "cancelled") return "stopped";
  if (state === "blocked" || attention === "approval-needed" || attention === "question-asked" || attention === "blocked") {
    return "needs-you";
  }
  if (state === "complete") return "done";
  return "running";
}

/** Row status in the three words a launch row knows, from a chat state. */
export function multitaskRowStatus(state: string | null): "running" | "done" | "error" {
  if (state === "failed" || state === "cancelled") return "error";
  if (state === "complete") return "done";
  return "running";
}

export function multitaskNoticeFor(event: TimelineEvent): MultitaskNotice {
  const canonical = decodeTimelineEvent(event);
  if (canonical.kind !== "multitask") {
    return {
      childSessionId: null,
      taskLabel: event.message,
      prompt: null,
      worktree: false,
      state: null,
      answer: null,
      createdAt: event.createdAt
    };
  }
  return {
    childSessionId: canonical.childSessionId,
    taskLabel: canonical.taskLabel,
    prompt: canonical.prompt,
    worktree: canonical.worktree,
    state: canonical.state,
    answer: canonical.answer,
    createdAt: event.createdAt
  };
}

/**
 * Fold a later row of the same multitask into the card already on screen. The
 * launch row is written at dispatch and the finish row lands minutes later, so
 * the card completes in place instead of the chat growing a second, orphaned
 * marker. Later rows carry only what they know, so a null must not erase what
 * the launch row already said.
 */
export function mergeMultitaskNotice(
  existing: MultitaskNotice,
  incoming: MultitaskNotice
): MultitaskNotice {
  return {
    childSessionId: incoming.childSessionId ?? existing.childSessionId,
    taskLabel: incoming.taskLabel || existing.taskLabel,
    prompt: incoming.prompt ?? existing.prompt,
    worktree: incoming.worktree || existing.worktree,
    state: incoming.state ?? existing.state,
    answer: incoming.answer ?? existing.answer,
    // The dispatch is where the row belongs, and it is the earlier of the two.
    createdAt:
      incoming.createdAt && incoming.createdAt < existing.createdAt
        ? incoming.createdAt
        : existing.createdAt
  };
}

/**
 * `/multitask <prompt>` typed into the composer. Returns the prompt, or null
 * when the draft is not the command. The bare command with nothing after it
 * returns null too: there is nothing to dispatch, so it stays an ordinary
 * draft the person is still typing.
 */
export function multitaskCommandPrompt(input: string): string | null {
  const match = /^\/multitask\s+([\s\S]+)$/i.exec(input.trim());
  return match?.[1]?.trim() || null;
}

/** `sessions.launch_kind` for a chat dispatched from inside another chat. */
const MULTITASK_LAUNCH_KIND = "multitask";

export function isMultitaskSession(session: SessionSummary): boolean {
  return session.launchKind === MULTITASK_LAUNCH_KIND;
}

/**
 * A multitask belongs to the chat that dispatched it, which shows it as a tab
 * in its subagent dock — so it is not a sidebar row of its own.
 *
 * An orphan is the exception: with its launching chat gone from the snapshot
 * there is nowhere left to reach it from, so it comes back to the sidebar
 * rather than disappearing with its uncommitted work.
 */
export function hiddenMultitaskWorkspaceIds(
  sessions: readonly SessionSummary[]
): Set<string> {
  const sessionIds = new Set(sessions.map((session) => session.id));
  const hidden = new Set<string>();
  for (const session of sessions) {
    if (!isMultitaskSession(session)) continue;
    const launcher = session.launchedBySessionId;
    if (launcher && sessionIds.has(launcher)) hidden.add(session.workspaceId);
  }
  return hidden;
}

/**
 * The workspaces of chats that dispatched a multitask still mid-turn.
 *
 * A multitask has no row of its own, so the only place its work can show is
 * the row of the chat that started it. Without this the sidebar goes calm the
 * moment the parent's own turn ends, while a sibling agent is still writing to
 * the same checkout — the row reads finished when it is not.
 *
 * An orphan is left out for the same reason it gets its row back: with its
 * launcher gone from the snapshot it speaks for itself.
 */
export function workspacesWithRunningMultitask(
  sessions: readonly SessionSummary[]
): Set<string> {
  const workspaceBySession = new Map(sessions.map((session) => [session.id, session.workspaceId]));
  const working = new Set<string>();
  for (const session of sessions) {
    if (!isMultitaskSession(session) || session.state !== "running") continue;
    const launcher = session.launchedBySessionId;
    const workspaceId = launcher ? workspaceBySession.get(launcher) : undefined;
    if (workspaceId) working.add(workspaceId);
  }
  return working;
}

/** A multitask of `sessionId`, paired with the workspace it runs in and the
 *  approval it is stopped on, if any: the row in the dispatching chat says
 *  what the chat wants to run, not only that it is waiting. */
export interface MultitaskChild {
  session: SessionSummary;
  workspace: WorkspaceSummary | null;
  pendingApproval: ApprovalRequest | null;
}

/**
 * Every multitask, grouped by the session that dispatched it. Built once per
 * snapshot rather than per pane, so a pane reads its own entry rather than
 * scanning every session. The map and its arrays are rebuilt whenever the
 * snapshot's session or workspace array changes identity, so a consumer that
 * feeds a memoized component keys on the values it needs, not on this array.
 */
export function multitasksByParentSession(
  sessions: readonly SessionSummary[],
  workspaces: readonly WorkspaceSummary[],
  approvals: readonly ApprovalRequest[] = []
): Map<string, MultitaskChild[]> {
  const byParent = new Map<string, MultitaskChild[]>();
  for (const session of sessions) {
    const launcher = session.launchedBySessionId;
    if (!isMultitaskSession(session) || !launcher) continue;
    const child: MultitaskChild = {
      session,
      workspace: workspaces.find((workspace) => workspace.id === session.workspaceId) ?? null,
      pendingApproval:
        approvals.find((approval) => approval.sessionId === session.id && approval.status === "pending") ?? null
    };
    const existing = byParent.get(launcher);
    if (existing) existing.push(child);
    else byParent.set(launcher, [child]);
  }
  return byParent;
}
