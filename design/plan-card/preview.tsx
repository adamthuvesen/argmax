import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PlanCard } from "../../src/renderer/components/PlanCard.js";
import { parsePlan } from "../../src/renderer/lib/parsePlan.js";
import "../../src/renderer/styles.css";

const realClaudeOutput = [
  "## Plan Complete",
  "",
  "I've written your plan to `/Users/user/.claude/plans/project-knowledge-facts-crispy-hamster.md`. Here's the summary:",
  "",
  "**What you're updating:**",
  "",
  "- **program.md:** Adding \"Hyperparameter Search\" section with guidance on Bayesian search (Optuna), declaring budgets upfront, and recording study outcomes",
  "- **guidelines.md:** Adding guideline #10 to enforce hyperparameter search constraints, then re-numbering guidelines 10–15 → 11–16",
  "",
  "**The approach:**",
  "",
  "1. **Verify:** Final read-through to catch any formatting issues",
  "2. **Commit:** One atomic commit with a clear message about preventing tuning bias",
  "3. **Optional validation:** Check recent experiment journals to confirm they'd follow these guidelines",
  "",
  "**Why this matters:** The changes are tightly coordinated — `program.md` tells researchers *how* to do hyperparameter search, and `guidelines.md` tells them *what must be true* (budgets locked upfront, tune on train-only data, use validation scores not CV scores for final comparison). This prevents selection bias and ensures trustworthy results.",
  "",
  "Does this plan look good? Any clarifications or changes before we implement?"
].join("\n");

const samplePlan = parsePlan(realClaudeOutput);
if (!samplePlan) {
  throw new Error("Preview: expected the real Claude Code sample to parse as a plan");
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <PlanCard
      plan={samplePlan}
      createdAt={new Date().toISOString()}
      rawMarkdown={realClaudeOutput}
      modelLabel="Claude Opus 4.7"
      onAccept={() => console.log("accept")}
      onReject={() => console.log("reject")}
    />
  </StrictMode>
);
