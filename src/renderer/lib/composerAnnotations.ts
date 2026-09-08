import type { ParsedDiffLine } from "./diff.js";

/** Annotations the user attached to the composer: transcript excerpts picked
 *  via the selection toolbar, and diff notes left on the review panel's
 *  diffs. Annotations are renderer-side state only: at send time they are
 *  serialized into the prompt text (see `prependAnnotationsToPrompt`), so the
 *  IPC payload and providers never see a structured annotation type. */
export type ComposerAnnotation =
  | { id: string; kind: "excerpt"; excerpt: string }
  | {
      id: string;
      kind: "diff-note";
      filePath: string;
      line: number | null;
      endLine?: number;
      side: DiffNoteSide;
      endSide?: DiffNoteSide;
      lineText: string;
      comment: string;
      base: string;
    };

/** Which side of the diff the noted line sits on. A `deletion` line's number
 *  belongs to the pre-change file and is not in the file on disk. */
export type DiffNoteSide = ParsedDiffLine["kind"];

/**
 * A note the user wrote on a diff line or range in the review panel. Not a GitHub
 * review comment: it never leaves this machine, and the agent addresses it by
 * editing the worktree. `base` names the comparison the diff was taken
 * against, because that is the tree the line number belongs to.
 */
export interface DiffNoteInput {
  filePath: string;
  line: number | null;
  endLine?: number;
  side: DiffNoteSide;
  endSide?: DiffNoteSide;
  lineText: string;
  comment: string;
  base: string;
}

/** What the diff view knows on its own, before the review panel names the
 *  comparison the diff was taken against. */
export type DiffNoteAnchor = Omit<DiffNoteInput, "base">;

let annotationSeq = 0;

function nextAnnotationId(): string {
  annotationSeq += 1;
  return `annotation-${annotationSeq}`;
}

export function createAnnotation(excerpt: string): ComposerAnnotation {
  return { id: nextAnnotationId(), kind: "excerpt", excerpt };
}

export function createDiffNoteAnnotation(input: DiffNoteInput): ComposerAnnotation {
  return { id: nextAnnotationId(), kind: "diff-note", ...input };
}

type DiffNoteAnnotation = Extract<ComposerAnnotation, { kind: "diff-note" }>;

function diffNoteLocation(annotation: DiffNoteAnnotation): string {
  if (annotation.line === null) return annotation.filePath;
  if (annotation.endLine === undefined) return `${annotation.filePath}:${annotation.line}`;

  const endSide = annotation.endSide ?? annotation.side;
  const crossesCoordinateSpaces =
    (annotation.side === "deletion") !== (endSide === "deletion");
  if (!crossesCoordinateSpaces) {
    return `${annotation.filePath}:${annotation.line}-${annotation.endLine}`;
  }

  const startLabel = SIDE_WORDS[annotation.side];
  const endLabel = SIDE_WORDS[endSide];
  return `${annotation.filePath}:${annotation.line} (${startLabel})-${annotation.endLine} (${endLabel})`;
}

/** Short text for the annotation chip above the composer. Named so the user
 *  reads the same provenance the agent is sent. */
export function annotationChipLabel(annotation: ComposerAnnotation): string {
  return annotation.kind === "excerpt"
    ? annotation.excerpt
    : `Diff note · ${diffNoteLocation(annotation)} — ${annotation.comment}`;
}

function quoteBlock(excerpt: string): string {
  return excerpt
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

const SIDE_WORDS: Record<DiffNoteSide, string> = {
  addition: "added",
  deletion: "removed",
  context: "unchanged"
};

/**
 * A diff note as a tagged block. The tag carries the provenance the prose
 * header states once: an agent that meets this line deep in a long context
 * still reads `argmax-diff-note` and not "review comment", which is the word
 * that sends it off to look for a pull request that may not exist.
 */
function diffNoteBlock(annotation: DiffNoteAnnotation): string {
  const attributes = [
    `file="${annotation.filePath}"`,
    annotation.line === null ? null : `line="${annotation.line}"`,
    annotation.endLine === undefined ? null : `end-line="${annotation.endLine}"`,
    `side="${SIDE_WORDS[annotation.side]}"`,
    annotation.endSide === undefined ? null : `end-side="${SIDE_WORDS[annotation.endSide]}"`,
    `base="${annotation.base}"`
  ]
    .filter((attribute): attribute is string => attribute !== null)
    .join(" ");
  return `<argmax-diff-note ${attributes}>\n${quoteBlock(annotation.lineText)}\n${annotation.comment}\n</argmax-diff-note>`;
}

/** Said once above the notes, so the tags below need only carry the anchors. */
const DIFF_NOTE_HEADERS = {
  one:
    "A note the user left on a diff line in Argmax's review panel. It is about the local " +
    "changes in this worktree, not a comment on a GitHub pull request — address it here; " +
    "there is nothing to reply to on GitHub. The quoted line is the anchor: line numbers " +
    "move as you edit.",
  many:
    "Notes the user left on diff lines in Argmax's review panel. They are about the local " +
    "changes in this worktree, not comments on a GitHub pull request — address them here; " +
    "there is nothing to reply to on GitHub. The quoted line is each note's anchor: line " +
    "numbers move as you edit."
} as const;

const DIFF_NOTE_RANGE_HEADERS = {
  one:
    "A note the user left on a diff range in Argmax's review panel. It is about the local " +
    "changes in this worktree. Address it here. There is nothing to reply to on GitHub. " +
    "The quoted range includes diff markers and is the anchor: line numbers " +
    "move as you edit.",
  many:
    "Notes the user left on diff lines or ranges in Argmax's review panel. They are about the local " +
    "changes in this worktree. Address them here. There is nothing to reply to on GitHub. " +
    "Quoted ranges include diff markers. The quoted code is each note's anchor: line " +
    "numbers move as you edit."
} as const;

/**
 * Serializes attached annotations ahead of the typed message, so the agent
 * reads the quoted excerpts and diff notes first and the instruction that
 * refers to them second. No-op without annotations. An empty `prompt` is
 * expected: annotations can be sent on their own, and then they are the whole
 * message.
 */
export function prependAnnotationsToPrompt(
  prompt: string,
  annotations: readonly ComposerAnnotation[]
): string {
  if (annotations.length === 0) return prompt;
  const excerpts = annotations.filter((a) => a.kind === "excerpt");
  const notes = annotations.filter((a): a is DiffNoteAnnotation => a.kind === "diff-note");
  const sections: string[] = [];
  if (excerpts.length > 0) {
    const header =
      excerpts.length === 1
        ? "Regarding this excerpt from our conversation above:"
        : "Regarding these excerpts from our conversation above:";
    sections.push(`${header}\n\n${excerpts.map((a) => quoteBlock(a.excerpt)).join("\n\n")}`);
  }
  if (notes.length > 0) {
    const includesRange = notes.some((note) => note.endLine !== undefined);
    const headers = includesRange ? DIFF_NOTE_RANGE_HEADERS : DIFF_NOTE_HEADERS;
    const header = notes.length === 1 ? headers.one : headers.many;
    sections.push(`${header}\n\n${notes.map(diffNoteBlock).join("\n\n")}`);
  }
  const attached = sections.join("\n\n");
  return prompt.length === 0 ? attached : `${attached}\n\n${prompt}`;
}
