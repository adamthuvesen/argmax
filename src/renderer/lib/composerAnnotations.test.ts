import { describe, expect, it } from "vitest";
import {
  annotationChipLabel,
  createAnnotation,
  createReviewCommentAnnotation,
  prependAnnotationsToPrompt
} from "./composerAnnotations.js";

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

  it("assigns each annotation a distinct id", () => {
    const a = createAnnotation("x");
    const b = createAnnotation("x");
    expect(a.id).not.toBe(b.id);
  });

  it("serializes a review comment with its location, quoted line, and note", () => {
    const annotation = createReviewCommentAnnotation({
      filePath: "src/x.ts",
      line: 12,
      lineText: "const x = 42;",
      comment: "use a named constant"
    });
    expect(prependAnnotationsToPrompt("then rerun tests", [annotation])).toBe(
      "Please address this review comment on the changes:\n\n" +
        "`src/x.ts:12`\n> const x = 42;\nuse a named constant\n\n" +
        "then rerun tests"
    );
  });

  it("orders excerpts before review comments when both are attached", () => {
    const annotations = [
      createReviewCommentAnnotation({
        filePath: "src/x.ts",
        line: 3,
        lineText: "let y = 0;",
        comment: "why mutable?"
      }),
      createAnnotation("the plan above")
    ];
    const prompt = prependAnnotationsToPrompt("go", annotations);
    expect(prompt.indexOf("Regarding this excerpt")).toBeLessThan(
      prompt.indexOf("Please address this review comment")
    );
    expect(prompt.endsWith("go")).toBe(true);
  });
});

describe("annotationChipLabel", () => {
  it("labels excerpts with their text and comments with location plus note", () => {
    expect(annotationChipLabel(createAnnotation("plain excerpt"))).toBe("plain excerpt");
    expect(
      annotationChipLabel(
        createReviewCommentAnnotation({
          filePath: "src/x.ts",
          line: 7,
          lineText: "irrelevant",
          comment: "tighten this"
        })
      )
    ).toBe("src/x.ts:7 — tighten this");
  });
});
