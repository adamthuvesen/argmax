import type {
  EventType,
  SessionSummary,
  TimelineEvent,
  WorkspaceSummary
} from "../../shared/types.js";

/** Dispatch row, written into the parent chat the moment a multitask starts. */
export const MULTITASK_LAUNCHED: EventType = "multitask.launched";
/** Finish row, written into the parent chat when the multitask's turn ends. */
export const MULTITASK_FINISHED: EventType = "multitask.finished";

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
  /** When it was dispatched. The row sorts by this among the turn's tool rows,
   *  so it sits where the work actually forked. */
  createdAt: string;
}

/** How much of the answer the chat row shows before it is cut. Long enough for
 *  a real sentence, short enough that the row stays one line. */
const ANSWER_PREVIEW_CHARS = 120;

/**
 * The one line of a finished multitask's answer that its chat row carries.
 *
 * The full answer is a whole reply in the dock tab; here it only has to say
 * what happened, so this takes the first line with something in it and unwraps
 * the markdown it was written in — a row is not the place to render a heading
 * or a bullet.
 *
 * Only paired inline markers are unwrapped. Stripping every `_` and backtick
 * turned `Renamed \`user_id\` to \`userId\`` into "Renamed userid to userId",
 * which misreports the one thing the row exists to say.
 */
export function multitaskAnswerPreview(answer: string | null): string | null {
  if (!answer) return null;
  const line = answer
    .split(/\r?\n/)
    .map((raw) =>
      raw
        .replace(/^\s*(?:[#>*+-]+\s+|\d+[.)]\s+)/, "")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/(^|\s)\*([^*]+)\*(?=\s|$)/g, "$1$2")
        .trim()
    )
    .find(isAnswerLine);
  if (!line) return null;
  // Cut by character, not by UTF-16 unit: slicing mid-surrogate leaves a lone
  // half that renders as a replacement glyph.
  const characters = Array.from(line);
  return characters.length > ANSWER_PREVIEW_CHARS
    ? `${characters.slice(0, ANSWER_PREVIEW_CHARS - 1).join("").trimEnd()}…`
    : line;
}

/**
 * A line worth showing. A rule (`---`), a bare heading marker, and the
 * placeholder the backend writes when the multitask produced no message at all
 * are all "it finished" said twice — the status word already says that.
 */
function isAnswerLine(line: string): boolean {
  if (line.length === 0 || line === "(no answer)") return false;
  return /[\p{L}\p{N}]/u.test(line);
}

/** Row status in the three words a launch row knows, from a chat state. */
export function multitaskRowStatus(state: string | null): "running" | "done" | "error" {
  if (state === "failed" || state === "cancelled") return "error";
  if (state === "complete") return "done";
  return "running";
}

export function isMultitaskEvent(event: TimelineEvent): boolean {
  return event.type === MULTITASK_LAUNCHED || event.type === MULTITASK_FINISHED;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function multitaskNoticeFor(event: TimelineEvent): MultitaskNotice {
  return {
    childSessionId: nonEmptyString(event.payload.childSessionId),
    taskLabel: nonEmptyString(event.payload.taskLabel) ?? event.message,
    prompt: nonEmptyString(event.payload.prompt),
    worktree: event.payload.worktree === true,
    state: nonEmptyString(event.payload.state),
    answer: nonEmptyString(event.payload.answer),
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
export const MULTITASK_LAUNCH_KIND = "multitask";

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

/** A multitask of `sessionId`, paired with the workspace it runs in. */
export interface MultitaskChild {
  session: SessionSummary;
  workspace: WorkspaceSummary | null;
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
  workspaces: readonly WorkspaceSummary[]
): Map<string, MultitaskChild[]> {
  const byParent = new Map<string, MultitaskChild[]>();
  for (const session of sessions) {
    const launcher = session.launchedBySessionId;
    if (!isMultitaskSession(session) || !launcher) continue;
    const child: MultitaskChild = {
      session,
      workspace: workspaces.find((workspace) => workspace.id === session.workspaceId) ?? null
    };
    const existing = byParent.get(launcher);
    if (existing) existing.push(child);
    else byParent.set(launcher, [child]);
  }
  return byParent;
}
