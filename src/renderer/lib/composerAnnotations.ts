/** Annotations the user attached to the composer: transcript excerpts picked
 *  via the selection toolbar, and line comments left on the review panel's
 *  diffs. Annotations are renderer-side state only: at send time they are
 *  serialized into the prompt text (see `prependAnnotationsToPrompt`), so the
 *  IPC payload and providers never see a structured annotation type. */
export type ComposerAnnotation =
  | { id: string; kind: "excerpt"; excerpt: string }
  | {
      id: string;
      kind: "review-comment";
      filePath: string;
      line: number | null;
      lineText: string;
      comment: string;
    };

/** A line comment authored in the review panel's diff view. */
export interface ReviewCommentInput {
  filePath: string;
  line: number | null;
  lineText: string;
  comment: string;
}

let annotationSeq = 0;

function nextAnnotationId(): string {
  annotationSeq += 1;
  return `annotation-${annotationSeq}`;
}

export function createAnnotation(excerpt: string): ComposerAnnotation {
  return { id: nextAnnotationId(), kind: "excerpt", excerpt };
}

export function createReviewCommentAnnotation(input: ReviewCommentInput): ComposerAnnotation {
  return { id: nextAnnotationId(), kind: "review-comment", ...input };
}

function reviewCommentLocation(annotation: Extract<ComposerAnnotation, { kind: "review-comment" }>): string {
  return annotation.line === null ? annotation.filePath : `${annotation.filePath}:${annotation.line}`;
}

/** Short text for the annotation chip above the composer. */
export function annotationChipLabel(annotation: ComposerAnnotation): string {
  return annotation.kind === "excerpt"
    ? annotation.excerpt
    : `${reviewCommentLocation(annotation)} — ${annotation.comment}`;
}

function quoteBlock(excerpt: string): string {
  return excerpt
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/**
 * Serializes attached annotations ahead of the typed message, so the agent
 * reads the quoted excerpts and review comments first and the instruction
 * that refers to them second. No-op without annotations. The composer's send
 * gate requires typed text, so `prompt` is never empty here.
 */
export function prependAnnotationsToPrompt(
  prompt: string,
  annotations: readonly ComposerAnnotation[]
): string {
  if (annotations.length === 0) return prompt;
  const excerpts = annotations.filter((a) => a.kind === "excerpt");
  const comments = annotations.filter((a) => a.kind === "review-comment");
  const sections: string[] = [];
  if (excerpts.length > 0) {
    const header =
      excerpts.length === 1
        ? "Regarding this excerpt from our conversation above:"
        : "Regarding these excerpts from our conversation above:";
    sections.push(`${header}\n\n${excerpts.map((a) => quoteBlock(a.excerpt)).join("\n\n")}`);
  }
  if (comments.length > 0) {
    const header =
      comments.length === 1
        ? "Please address this review comment on the changes:"
        : "Please address these review comments on the changes:";
    const blocks = comments.map(
      (a) => `\`${reviewCommentLocation(a)}\`\n${quoteBlock(a.lineText)}\n${a.comment}`
    );
    sections.push(`${header}\n\n${blocks.join("\n\n")}`);
  }
  return `${sections.join("\n\n")}\n\n${prompt}`;
}
