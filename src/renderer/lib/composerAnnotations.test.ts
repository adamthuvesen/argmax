import { describe, expect, it } from "vitest";
import {
  annotationChipLabel,
  createAnnotation,
  createDiffNoteAnnotation,
  prependAnnotationsToPrompt,
  type DiffNoteInput
} from "./composerAnnotations.js";

function diffNote(overrides: Partial<DiffNoteInput> = {}): DiffNoteInput {
  return {
    filePath: "src/x.ts",
    line: 12,
    side: "addition",
    lineText: "const x = 42;",
    comment: "use a named constant",
    base: "working tree vs HEAD",
    ...overrides
  };
}

describe("prependAnnotationsToPrompt", () => {
  it("returns the prompt untouched without annotations", () => {
    expect(prependAnnotationsToPrompt("ship it", [])).toBe("ship it");
  });

  it("quotes a single excerpt ahead of the typed message", () => {
    const annotation = createAnnotation("Day two looks boring.");
    expect(prependAnnotationsToPrompt("why boring?", [annotation])).toBe(
      "Regarding this excerpt from our conversation above:\n\n> Day two looks boring.\n\nwhy boring?"
    );
  });

  it("keeps multi-line excerpts as one quote block per annotation", () => {
    const annotations = [
      createAnnotation("first line\nsecond line"),
      createAnnotation("another excerpt")
    ];
    expect(prependAnnotationsToPrompt("compare these", annotations)).toBe(
      "Regarding these excerpts from our conversation above:\n\n" +
        "> first line\n> second line\n\n" +
        "> another excerpt\n\n" +
        "compare these"
    );
  });

  it("is the whole message when nothing was typed", () => {
    const prompt = prependAnnotationsToPrompt("", [createDiffNoteAnnotation(diffNote())]);
    expect(prompt).toBe(
      "A note the user left on a diff line in Argmax's review panel. It is about the local " +
        "changes in this worktree, not a comment on a GitHub pull request — address it here; " +
        "there is nothing to reply to on GitHub. The quoted line is the anchor: line numbers " +
        "move as you edit.\n\n" +
        '<argmax-diff-note file="src/x.ts" line="12" side="added" base="working tree vs HEAD">\n' +
        "> const x = 42;\nuse a named constant\n</argmax-diff-note>"
    );
  });

  it("assigns each annotation a distinct id", () => {
    const a = createAnnotation("x");
    const b = createAnnotation("x");
    expect(a.id).not.toBe(b.id);
  });

  it("keeps the typed message after the notes", () => {
    const prompt = prependAnnotationsToPrompt("then rerun tests", [
      createDiffNoteAnnotation(diffNote())
    ]);
    expect(prompt.endsWith("</argmax-diff-note>\n\nthen rerun tests")).toBe(true);
  });

  it("serializes and quotes a diff range", () => {
    const prompt = prependAnnotationsToPrompt("", [
      createDiffNoteAnnotation(
        diffNote({
          line: 8,
          endLine: 11,
          side: "deletion",
          endSide: "addition",
          lineText: "-const oldValue = 1;\n unchanged();\n+const newValue = 2;",
          comment: "keep the old name"
        })
      )
    ]);
    expect(prompt).toBe(
      "A note the user left on a diff range in Argmax's review panel. It is about the local " +
        "changes in this worktree. Address it here. There is nothing to reply to on GitHub. " +
        "The quoted range includes diff markers and is the anchor: line numbers " +
        "move as you edit.\n\n" +
        '<argmax-diff-note file="src/x.ts" line="8" end-line="11" side="removed" end-side="added" base="working tree vs HEAD">\n' +
        "> -const oldValue = 1;\n>  unchanged();\n> +const newValue = 2;\nkeep the old name\n</argmax-diff-note>"
    );
  });

  it("omits end-side when a range stays on one diff side", () => {
    const prompt = prependAnnotationsToPrompt("", [
      createDiffNoteAnnotation(diffNote({ endLine: 15, lineText: "+first\n+second" }))
    ]);
    expect(prompt).toContain('line="12" end-line="15" side="added" base=');
    expect(prompt).not.toContain("end-side=");
  });

  it("names the comparison the line number belongs to", () => {
    const prompt = prependAnnotationsToPrompt("", [
      createDiffNoteAnnotation(diffNote({ base: "the whole branch vs origin/main" }))
    ]);
    expect(prompt).toContain('base="the whole branch vs origin/main"');
  });

  it("marks a deleted line as removed, since its number is the pre-change one", () => {
    const prompt = prependAnnotationsToPrompt("", [
      createDiffNoteAnnotation(diffNote({ side: "deletion", lineText: "let y = 0;" }))
    ]);
    expect(prompt).toContain('side="removed"');
  });

  it("drops the line attribute from a file-level note", () => {
    const prompt = prependAnnotationsToPrompt("", [createDiffNoteAnnotation(diffNote({ line: null }))]);
    expect(prompt).toContain('<argmax-diff-note file="src/x.ts" side="added"');
  });

  it("says once, in the plural, that the notes are not GitHub review comments", () => {
    const prompt = prependAnnotationsToPrompt("", [
      createDiffNoteAnnotation(diffNote()),
      createDiffNoteAnnotation(diffNote({ line: 3, comment: "why mutable?" }))
    ]);
    expect(prompt).toContain("not comments on a GitHub pull request");
    expect(prompt.split("<argmax-diff-note").length - 1).toBe(2);
    expect(prompt.split("review panel").length - 1).toBe(1);
  });

  it("orders excerpts before diff notes when both are attached", () => {
    const annotations = [
      createDiffNoteAnnotation(diffNote({ line: 3, comment: "why mutable?" })),
      createAnnotation("the plan above")
    ];
    const prompt = prependAnnotationsToPrompt("go", annotations);
    expect(prompt.indexOf("Regarding this excerpt")).toBeLessThan(
      prompt.indexOf("<argmax-diff-note")
    );
    expect(prompt.endsWith("go")).toBe(true);
  });
});

describe("annotationChipLabel", () => {
  it("labels excerpts with their text and names a diff note as one", () => {
    expect(annotationChipLabel(createAnnotation("plain excerpt"))).toBe("plain excerpt");
    expect(
      annotationChipLabel(
        createDiffNoteAnnotation(diffNote({ line: 7, comment: "tighten this" }))
      )
    ).toBe("Diff note · src/x.ts:7 — tighten this");
  });

  it("shows a compact line span for a range on one diff side", () => {
    expect(
      annotationChipLabel(
        createDiffNoteAnnotation(diffNote({ endLine: 15, comment: "tighten these" }))
      )
    ).toBe("Diff note · src/x.ts:12-15 — tighten these");
    expect(
      annotationChipLabel(
        createDiffNoteAnnotation(
          diffNote({ endLine: 15, endSide: "addition", comment: "tighten these" })
        )
      )
    ).toBe("Diff note · src/x.ts:12-15 — tighten these");
  });

  it("labels endpoints when a range crosses old and new file coordinates", () => {
    expect(
      annotationChipLabel(
        createDiffNoteAnnotation(
          diffNote({
            line: 10,
            endLine: 14,
            side: "deletion",
            endSide: "addition",
            comment: "replace this hunk"
          })
        )
      )
    ).toBe("Diff note · src/x.ts:10 (removed)-14 (added) — replace this hunk");
  });

  it.each([
    ["deletion", "context", "removed", "unchanged"],
    ["context", "deletion", "unchanged", "removed"]
  ] as const)("labels %s to %s endpoints accurately", (side, endSide, startLabel, endLabel) => {
    const annotation = createDiffNoteAnnotation(diffNote({ side, endSide, endLine: 15 }));
    expect(annotationChipLabel(annotation)).toContain(`12 (${startLabel})-15 (${endLabel})`);
  });
});
