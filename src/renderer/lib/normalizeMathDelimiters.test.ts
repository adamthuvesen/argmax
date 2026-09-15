import { describe, expect, it } from "vitest";
import { normalizeMathDelimiters } from "./normalizeMathDelimiters.js";

describe("normalizeMathDelimiters", () => {
  it.each([
    ["$2x + 1$", "$2x + 1$"],
    ["\\(2x + 1\\)", "$2x + 1$"],
    ["Costs $50 and $100, with $2x + 1$.", "Costs \\$50 and \\$100, with $2x + 1$."],
    ["Already escaped \\$50, then $2x$.", "Already escaped \\$50, then $2x$."],
    ["Price $50 and formula $x$.", "Price \\$50 and formula $x$."],
    ["Price $50 ($x$ after adjustment).", "Price \\$50 ($x$ after adjustment)."],
    ["Price $50 ($\\alpha$ after adjustment).", "Price \\$50 ($\\alpha$ after adjustment)."],
    ["Price $50 ($ x = \\alpha $ after adjustment).", "Price \\$50 ($ x = \\alpha $ after adjustment)."],
    ["Price $50 ($-x$ after adjustment).", "Price \\$50 ($-x$ after adjustment)."],
    ["$2x$, then $y$", "$2x$, then $y$"],
    ["$x$meters", "$x$meters"],
    ["$5,$10", "\\$5,\\$10"],
    ["$2 + 1$ and $3y$", "$2 + 1$ and $3y$"],
    ["$ x = \\alpha $", "$ x = \\alpha $"],
    ["$2$", "$2$"]
  ])("preserves numeric math alongside currency: %s", (input, expected) => {
    expect(normalizeMathDelimiters(input)).toBe(expected);
  });

  it.each([
    ["Standard pricing is $1.25/1M in and $4.25/1M out.", "Standard pricing is \\$1.25/1M in and \\$4.25/1M out."],
    ["vs ~$5/$25 for Opus 5.", "vs ~\\$5/\\$25 for Opus 5."],
    ["is $0.10/$0.20 in exchange.", "is \\$0.10/\\$0.20 in exchange."],
    ["Between $5-$10 per seat.", "Between \\$5-\\$10 per seat."],
    ["Tokens: $3/M input, $15/M output.", "Tokens: \\$3/M input, \\$15/M output."],
    ["Raised from $1M to $10M.", "Raised from \\$1M to \\$10M."]
  ])("keeps per-unit prices out of math: %s", (input, expected) => {
    expect(normalizeMathDelimiters(input)).toBe(expected);
  });

  it.each([
    ["Export $PATH and $HOME before running.", "Export \\$PATH and \\$HOME before running."],
    ["The var $foo is set from $bar.", "The var \\$foo is set from \\$bar."]
  ])("does not pair shell variables into math: %s", (input, expected) => {
    expect(normalizeMathDelimiters(input)).toBe(expected);
  });

  it("escapes a dollar sign that never closes a span", () => {
    expect(normalizeMathDelimiters("a $$ b")).toBe("a \\$\\$ b");
    expect(normalizeMathDelimiters("Costs $5 today.")).toBe("Costs \\$5 today.");
  });

  it("converts LaTeX block math \\[ ... \\] to $$ ... $$", () => {
    const input = "\\[ \\text{margin} = P(\\text{best family}) - P(\\text{second-best family}) \\]";
    const output = normalizeMathDelimiters(input);
    expect(output).toContain("$$\n\\text{margin} = P(\\text{best family}) - P(\\text{second-best family})\n$$");
  });

  it("converts LaTeX inline math \\( ... \\) to $ ... $", () => {
    const input = "\\(\\tau\\) (\"tau\") is the abstention threshold.";
    const output = normalizeMathDelimiters(input);
    expect(output).toBe("$\\tau$ (\"tau\") is the abstention threshold.");
  });

  it("preserves standard markdown math $$ and $", () => {
    const input = "$$E = mc^2$$\nwhere $E$ is energy and $m$ is mass.";
    const output = normalizeMathDelimiters(input);
    expect(output).toContain("$$\nE = mc^2\n$$");
    expect(output).toContain("where $E$ is energy and $m$ is mass.");
  });

  it("escapes currency amounts like $50 or $100.00", () => {
    const input = "Prices range from $10 to $20, or $100.50 per year.";
    const output = normalizeMathDelimiters(input);
    expect(output).toBe("Prices range from \\$10 to \\$20, or \\$100.50 per year.");
  });

  it("handles consecutive currency symbols and lists", () => {
    const input = "$5, $10, $15 and $20.00 each";
    const output = normalizeMathDelimiters(input);
    expect(output).toBe("\\$5, \\$10, \\$15 and \\$20.00 each");
  });

  it("does not escape math that starts with a non-digit like $x_1 = 1$", () => {
    const input = "Let $x_1 = 1$ and $y_2 = 2$.";
    const output = normalizeMathDelimiters(input);
    expect(output).toBe("Let $x_1 = 1$ and $y_2 = 2$.");
  });

  it("does not alter code inside fenced code blocks", () => {
    const input = [
      "Here is bash code:",
      "```bash",
      "PRICE=$50",
      "echo \"\\[ escaped \\] and \\( inline \\)\"",
      "```",
      "And math outside: \\(x + y\\)"
    ].join("\n");

    const output = normalizeMathDelimiters(input);
    expect(output).toContain("PRICE=$50");
    expect(output).toContain("echo \"\\[ escaped \\] and \\( inline \\)\"");
    expect(output).toContain("$x + y$");
  });

  it("does not alter inline code spans", () => {
    const input = "Use `PRICE=$50` or `\\[code\\]` in your script, but \\(\\alpha\\) in math.";
    const output = normalizeMathDelimiters(input);
    expect(output).toBe("Use `PRICE=$50` or `\\[code\\]` in your script, but $\\alpha$ in math.");
  });

  it("wraps bare LaTeX environments in $$ blocks", () => {
    const input = [
      "Formula:",
      "\\begin{align}",
      "a &= b + c \\\\",
      "d &= e + f",
      "\\end{align}",
      "Done."
    ].join("\n");

    const output = normalizeMathDelimiters(input);
    expect(output).toContain("$$\n\\begin{align}\na &= b + c \\\\\nd &= e + f\n\\end{align}\n$$");
  });

  it("handles empty or purely textual markdown gracefully", () => {
    expect(normalizeMathDelimiters("")).toBe("");
    expect(normalizeMathDelimiters("Hello world")).toBe("Hello world");
  });

  it("converts bare Greek letter commands in prose to math spans", () => {
    const input = "\\tau (\"tau\") is the threshold. Then \\alpha and \\beta are weights.";
    const output = normalizeMathDelimiters(input);
    expect(output).toBe("$\\tau$ (\"tau\") is the threshold. Then $\\alpha$ and $\\beta$ are weights.");
  });

  it("converts bracketed equations like [ \\text{...} ] to display math", () => {
    const input = "[ \\text{margin} = P(\\text{best family}) - P(\\text{second-best family}) ]";
    const output = normalizeMathDelimiters(input);
    expect(output).toContain("$$\n\\text{margin} = P(\\text{best family}) - P(\\text{second-best family})\n$$");
  });

  it("leaves Greek letters inside existing display math alone", () => {
    expect(normalizeMathDelimiters("$$\n\\alpha + \\beta\n$$")).toBe("$$\n\\alpha + \\beta\n$$");
  });

  it("leaves Greek letters inside existing inline math alone", () => {
    expect(normalizeMathDelimiters("Given $x = \\alpha + 1$ we win.")).toBe(
      "Given $x = \\alpha + 1$ we win."
    );
  });

  it("does not re-wrap Greek letters in math it just converted", () => {
    expect(normalizeMathDelimiters("\\[ \\alpha + \\beta \\]")).toContain("$$\n\\alpha + \\beta\n$$");
  });
});
