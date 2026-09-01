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

/** Badge on a skill row, saying where the skill was discovered. */
export const SKILL_SOURCE_LABELS: Record<SkillSource, string> = {
  user: "User",
  workspace: "Project",
  "codex-prompt": "Prompt",
  plugin: "Plugin",
  system: "System"
};
