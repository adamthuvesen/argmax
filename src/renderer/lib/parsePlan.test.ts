import { describe, expect, it } from "vitest";
import { parsePlan } from "./parsePlan.js";

describe("parsePlan", () => {
  it("parses a complete plan with explicit action block", () => {
    const md = [
      "# Plan: Refactor onboarding",
      "",
      "Tighten the onboarding flow and remove the duplicate consent step.",
      "",
      "## Key Changes",
      "",
      "- Restructure `App.tsx` for clarity",
      "  - extract `<OnboardingRoot>`",
      "  - move feature flags into context",
      "- Add `docs/onboarding.md`",
      "",
      "## Action",
      "",
      "Proceed with this refactor?",
      "",
      "- Yes, do it",
      "- No, hold off"
    ].join("\n");

    const plan = parsePlan(md);
    expect(plan).not.toBeNull();
    if (!plan) return;
    expect(plan.title).toBe("Plan: Refactor onboarding");
    expect(plan.summary).toHaveLength(1);
    expect(plan.summary[0]).toMatch(/Tighten the onboarding flow/);
    expect(plan.sections).toHaveLength(1);
    expect(plan.sections[0]?.label).toBe("Key Changes");
    expect(plan.sections[0]?.items).toHaveLength(2);
    expect(plan.sections[0]?.items[0]?.title).toBe("Restructure `App.tsx` for clarity");
    expect(plan.sections[0]?.items[0]?.children).toHaveLength(2);
    expect(plan.sections[0]?.items[0]?.children?.[0]?.title).toBe("extract `<OnboardingRoot>`");
    expect(plan.action.question).toBe("Proceed with this refactor?");
    expect(plan.action.options).toEqual([{ label: "Yes, do it" }, { label: "No, hold off" }]);
  });

  it("synthesizes a default action when none is provided", () => {
    const md = [
      "# Plan: Tidy chat header",
      "",
      "One paragraph of summary.",
      "",
      "## Key Changes",
      "",
      "- Update the badge color"
    ].join("\n");

    const plan = parsePlan(md);
    expect(plan).not.toBeNull();
    if (!plan) return;
    expect(plan.action.question).toBe("Implement this plan?");
    expect(plan.action.options).toHaveLength(2);
    expect(plan.action.options[0]?.label).toMatch(/yes/i);
    expect(plan.action.options[1]?.label).toMatch(/no/i);
  });

  it("returns null when there is no h1 title", () => {
    const md = [
      "## Key Changes",
      "",
      "- Update the badge color"
    ].join("\n");
    expect(parsePlan(md)).toBeNull();
  });

  it("returns null when there are no sections", () => {
    const md = ["# Plan: Standalone", "", "Just a paragraph with no headings."].join("\n");
    expect(parsePlan(md)).toBeNull();
  });

  it("returns null on empty input", () => {
    expect(parsePlan("")).toBeNull();
    expect(parsePlan("   \n\n\t ")).toBeNull();
  });

  it("preserves inline code in titles and items", () => {
    const md = [
      "# Plan: Add `docs/onboarding.md`",
      "",
      "## Key Changes",
      "",
      "- Touch `package.json`",
      "- Wire `<FileChip />` into bullets"
    ].join("\n");

    const plan = parsePlan(md);
    expect(plan).not.toBeNull();
    if (!plan) return;
    expect(plan.title).toContain("`docs/onboarding.md`");
    expect(plan.sections[0]?.items[0]?.title).toContain("`package.json`");
    expect(plan.sections[0]?.items[1]?.title).toContain("`<FileChip />`");
  });

  it("treats ## Decide and ## Next as action headings too", () => {
    const baseSection = ["## Key Changes", "", "- Single item"].join("\n");
    const decide = ["# Plan: Pick a path", "", baseSection, "", "## Decide", "", "Which option?", "", "- One", "- Two"].join("\n");
    const next = ["# Plan: Pick a path", "", baseSection, "", "## Next", "", "Which option?", "", "- One", "- Two"].join("\n");

    const planDecide = parsePlan(decide);
    expect(planDecide?.action.question).toBe("Which option?");
    expect(planDecide?.action.options).toEqual([{ label: "One" }, { label: "Two" }]);

    const planNext = parsePlan(next);
    expect(planNext?.action.question).toBe("Which option?");
  });

  it("keeps a section that has only a paragraph as a labeled note", () => {
    const md = [
      "# Plan: Mixed content",
      "",
      "Summary line.",
      "",
      "## Notes",
      "",
      "Just a paragraph here, no list.",
      "",
      "## Key Changes",
      "",
      "- Real change"
    ].join("\n");
    const plan = parsePlan(md);
    expect(plan).not.toBeNull();
    expect(plan?.sections).toHaveLength(2);
    expect(plan?.sections[0]?.label).toBe("Notes");
    expect(plan?.sections[0]?.note).toBe("Just a paragraph here, no list.");
    expect(plan?.sections[0]?.items).toHaveLength(0);
    expect(plan?.sections[1]?.label).toBe("Key Changes");
    expect(plan?.sections[1]?.items).toHaveLength(1);
  });

  it("parses a real Claude Code plan (h2 title, bold-label sections, trailing question)", () => {
    const md = [
      "## Plan Complete",
      "",
      "I've written your plan to `/Users/x/plans/foo.md`. Here's the summary:",
      "",
      "**What you're updating:**",
      "",
      "- **program.md:** Adding \"Hyperparameter Search\" section with guidance on Bayesian search (Optuna).",
      "- **guidelines.md:** Adding guideline #10 to enforce hyperparameter search constraints.",
      "",
      "**The approach:**",
      "",
      "1. **Verify:** Final read-through to catch any formatting issues",
      "2. **Commit:** One atomic commit with a clear message about preventing tuning bias",
      "3. **Optional validation:** Check recent experiment journals",
      "",
      "**Why this matters:** The changes are tightly coordinated — `program.md` tells researchers *how* to do hyperparameter search, and `guidelines.md` tells them *what must be true*.",
      "",
      "Does this plan look good? Any clarifications or changes before we implement?"
    ].join("\n");

    const plan = parsePlan(md);
    expect(plan).not.toBeNull();
    if (!plan) return;
    expect(plan.title).toBe("Plan Complete");
    expect(plan.summary.length).toBeGreaterThanOrEqual(1);
    expect(plan.summary[0]).toMatch(/I've written your plan/);
    expect(plan.sections.map((s) => s.label)).toEqual([
      "What you're updating",
      "The approach",
      "Why this matters"
    ]);
    expect(plan.sections[0]?.items).toHaveLength(2);
    expect(plan.sections[0]?.items[0]?.title).toMatch(/\*\*program\.md:\*\*/);
    expect(plan.sections[1]?.items).toHaveLength(3);
    expect(plan.sections[2]?.items).toHaveLength(0);
    expect(plan.sections[2]?.note).toMatch(/tightly coordinated/);
    expect(plan.action.question).toMatch(/^Does this plan look good\?/);
    // No explicit option list in the source, so defaults kick in.
    expect(plan.action.options).toHaveLength(2);
    expect(plan.action.options[0]?.label).toMatch(/yes/i);
  });

  it("accepts multiple summary paragraphs before the first section", () => {
    const md = [
      "# Plan: Long intro",
      "",
      "First paragraph of intent.",
      "",
      "Second paragraph adding detail.",
      "",
      "## Key Changes",
      "",
      "- A change"
    ].join("\n");
    const plan = parsePlan(md);
    expect(plan?.summary).toHaveLength(2);
    expect(plan?.summary[1]).toMatch(/Second paragraph/);
  });

  it("parses multi-phase plans with nested sub-sections (Deliverable, Files, Work, Success check)", () => {
    const md = [
      "# Plan: Make the Argmax README great",
      "",
      "## Scope",
      "Rewrite only `README.md` for two audiences:",
      "1. Users deciding whether Argmax fits their workflow",
      "2. Contributors setting up the project locally",
      "",
      "## Phase 1: Establish the README's story",
      "",
      "### Deliverable",
      "A sharper opening that explains Argmax's purpose.",
      "",
      "### Files",
      "`README.md`",
      "",
      "### Work",
      "1. Keep existing branding.",
      "2. Replace generic opening.",
      "",
      "### Success check",
      "A new reader can understand what Argmax is.",
      "",
      "## Phase 2: Add feature overview",
      "",
      "### Deliverable",
      "A clear feature map.",
      "",
      "Proceed with this plan?"
    ].join("\n");

    const plan = parsePlan(md);
    expect(plan).not.toBeNull();
    if (!plan) return;
    expect(plan.title).toBe("Plan: Make the Argmax README great");
    expect(plan.sections).toHaveLength(3);

    // Scope
    expect(plan.sections[0]?.label).toBe("Scope");
    expect(plan.sections[0]?.note).toMatch(/Rewrite only/);
    expect(plan.sections[0]?.items).toHaveLength(2);

    // Phase 1
    expect(plan.sections[1]?.badge).toBe("Phase 1");
    expect(plan.sections[1]?.title).toBe("Establish the README's story");
    expect(plan.sections[1]?.subsections).toHaveLength(4);
    expect(plan.sections[1]?.subsections?.[0]?.kind).toBe("deliverable");
    expect(plan.sections[1]?.subsections?.[0]?.note).toMatch(/sharper opening/);
    expect(plan.sections[1]?.subsections?.[1]?.kind).toBe("files");
    expect(plan.sections[1]?.subsections?.[1]?.note).toBe("`README.md`");
    expect(plan.sections[1]?.subsections?.[2]?.kind).toBe("work");
    expect(plan.sections[1]?.subsections?.[2]?.items).toHaveLength(2);
    expect(plan.sections[1]?.subsections?.[3]?.kind).toBe("check");
    expect(plan.sections[1]?.subsections?.[3]?.note).toMatch(/new reader/);

    // Phase 2
    expect(plan.sections[2]?.badge).toBe("Phase 2");
    expect(plan.sections[2]?.title).toBe("Add feature overview");
    expect(plan.sections[2]?.subsections).toHaveLength(1);
    expect(plan.sections[2]?.subsections?.[0]?.kind).toBe("deliverable");
  });
});
