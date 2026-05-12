import type { Learning } from "../../shared/types.js";

const TOP_K = 5;
// Rough cap on the preamble: ~500 tokens ≈ ~2000 chars at the usual ratio.
const MAX_PREAMBLE_CHARS = 2000;

const PREAMBLE_HEADER =
  "Project knowledge — facts captured from prior sessions in this project. Apply where relevant; ignore if not.\n";

export interface LearningInjectorDeps {
  listLearnings: (projectId: string, limit?: number) => readonly Learning[];
}

export interface InjectionResult {
  /** The original prompt with the preamble prepended, or the original prompt unchanged if no learnings exist. */
  augmentedPrompt: string;
  /** Learnings actually included in the preamble — useful for bumping `hits`. */
  injectedIds: string[];
}

export function composeLearningPreamble(
  deps: LearningInjectorDeps,
  projectId: string,
  originalPrompt: string
): InjectionResult {
  const learnings = deps.listLearnings(projectId, TOP_K);
  if (learnings.length === 0) {
    return { augmentedPrompt: originalPrompt, injectedIds: [] };
  }
  const lines: string[] = [];
  const injectedIds: string[] = [];
  let consumed = PREAMBLE_HEADER.length + 2; // trailing "\n\n"
  for (const learning of learnings) {
    const bullet = `- (${learning.kind}) ${learning.summary}\n`;
    if (consumed + bullet.length > MAX_PREAMBLE_CHARS) break;
    lines.push(bullet);
    injectedIds.push(learning.id);
    consumed += bullet.length;
  }
  if (lines.length === 0) {
    return { augmentedPrompt: originalPrompt, injectedIds: [] };
  }
  const augmented = `${PREAMBLE_HEADER}${lines.join("")}\n${originalPrompt}`;
  return { augmentedPrompt: augmented, injectedIds };
}
