import type { LucideIcon } from "lucide-react";
import type { SkillSource } from "../../shared/types.js";

/**
 * A composer action offered in the `/` menu above the skills list. Commands are
 * supplied by the surface that owns them — the session composer, the launcher —
 * because each one closes over that surface's state; the menu only draws them
 * and calls `run`.
 */
export interface ComposerCommand {
  /** Token typed after `/`. A query prefix-matches this or `label`. */
  name: string;
  label: string;
  /** Muted line trailing the label: what running the command does. */
  hint: string;
  icon: LucideIcon;
  run: () => void;
}

/**
 * The `/name` tokens the session composer acts on itself instead of sending.
 *
 * These mark in the draft the way skills do — the tint means "this line is a
 * command", and which engine runs it is not the reader's problem. A name
 * belongs here only when its own submit branch is live, so a tinted token
 * always dispatches; that is the invariant worth keeping, since a token that
 * looks live and then sends as prose is the confusing outcome.
 */
export function dispatchedCommandNames({
  hasSession,
  canMultitask,
  goalEnabled
}: {
  hasSession: boolean;
  canMultitask: boolean;
  goalEnabled: boolean;
}): Set<string> {
  const names = new Set(["clear"]);
  if (hasSession && canMultitask) names.add("multitask");
  if (hasSession && goalEnabled) names.add("goal");
  return names;
}

/** True when the composer draft is exactly `/clear` (optional trailing space). */
export function isClearCommand(input: string): boolean {
  return /^\/clear\s*$/i.test(input.trim());
}

/** Badge on a skill row, saying where the skill was discovered. */
export const SKILL_SOURCE_LABELS: Record<SkillSource, string> = {
  user: "User",
  workspace: "Project",
  "codex-prompt": "Prompt",
  plugin: "Plugin",
  system: "System"
};
