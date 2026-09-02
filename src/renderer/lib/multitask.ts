import type { EventType, TimelineEvent } from "../../shared/types.js";

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
    answer: nonEmptyString(event.payload.answer)
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
    answer: incoming.answer ?? existing.answer
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
