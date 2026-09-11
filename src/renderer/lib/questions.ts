import type { ToolCall } from "./toolCalls.js";

export type QuestionOption = {
  label: string;
  description?: string;
};

export type Question = {
  /** Stable provider identity used when a blocking question resumes in-place. */
  id?: string;
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
  /** Whether the provider accepts a free-form answer. Legacy cards default to true. */
  isOther?: boolean;
  /** Free-form text must be masked and must never be copied into transcript prose. */
  isSecret?: boolean;
};

export type QuestionAnswers = Record<string, string[]>;

export function hasOtherOption(question: Question): boolean {
  return question.isOther !== false;
}

/// Every question also takes an answer in the reader's own words. It is picked
/// like any option, at the index one past the last listed one, and carries the
/// typed text alongside the picks.
export function otherOptionIndex(question: Question): number {
  return question.options.length;
}

/// The labels the reader picked, in the order the question listed them, with
/// the typed answer last when "Other" is among the picks.
export function pickedLabels(question: Question, picks: number[], otherText = ""): string[] {
  const labels = picks
    .map((index) => question.options[index]?.label)
    .filter((label): label is string => typeof label === "string" && label.length > 0);
  const typed = otherText.trim();
  if (picks.includes(otherOptionIndex(question)) && typed) labels.push(typed);
  return labels;
}

/** Provider-native response keyed by the stable question ids from the request. */
export function structuredAnswers(
  questions: Question[],
  selected: number[][],
  otherText: string[] = []
): QuestionAnswers {
  const answers: QuestionAnswers = {};
  questions.forEach((question, index) => {
    if (!question.id) return;
    const picks = selected[index] ?? [];
    const values = picks
      .map((picked) => question.options[picked]?.label)
      .filter((label): label is string => typeof label === "string" && label.length > 0);
    const typed = otherText[index]?.trim() ?? "";
    if (hasOtherOption(question) && picks.includes(otherOptionIndex(question)) && typed) {
      values.push(`user_note: ${typed}`);
    }
    answers[question.id] = values;
  });
  return answers;
}

/// The answer as it is sent back to the agent: one `Header: choices` line per
/// question. A typed answer goes in as plain text on that line, the same as a
/// listed one, so the agent reads it without knowing which it was. No markdown:
/// this lands in the transcript as a user message, which is drawn verbatim, so
/// bold markers would read as literal asterisks there.
export function formatAnswer(questions: Question[], selected: number[][], otherText: string[] = []): string {
  return questions
    .map((question, index) => {
      const labels = pickedLabels(question, selected[index] ?? [], otherText[index] ?? "");
      const header = question.header || question.question;
      const value = question.isSecret
        ? "(secret provided)"
        : labels.length > 0 ? labels.join(", ") : "(no selection)";
      return `${header}: ${value}`;
    })
    .join("\n");
}

export function parseQuestionsFromToolInput(tool: ToolCall): Question[] | null {
  const raw = tool.inputFull?.questions;
  if (!Array.isArray(raw)) return null;
  const questions: Question[] = [];
  for (const q of raw) {
    if (!q || typeof q !== "object") continue;
    const qq = q as Record<string, unknown>;
    const questionText = typeof qq.question === "string" ? qq.question : "";
    if (!questionText) continue;
    const header = typeof qq.header === "string" ? qq.header : "";
    const optionsRaw = Array.isArray(qq.options) ? qq.options : [];
    if (optionsRaw.length > 4) return null;
    const options = optionsRaw
      .map((o) => (o && typeof o === "object" ? (o as Record<string, unknown>) : null))
      .filter((o): o is Record<string, unknown> => o !== null)
      .map((o) => ({
        label: typeof o.label === "string" ? o.label : "",
        ...(typeof o.description === "string" ? { description: o.description } : {})
      }))
      .filter((o) => o.label.length > 0);
    // Codex permits free-form-only questions with the default isOther:false.
    // That flag controls the extra choice when options exist.
    const isOther = tool.inputFull?.delivery === "blocking" && options.length === 0
      ? true
      : typeof qq.isOther === "boolean" ? qq.isOther : undefined;
    if (options.length === 0 && isOther !== true) continue;
    questions.push({
      ...(typeof qq.id === "string" && qq.id.length > 0 ? { id: qq.id } : {}),
      question: questionText,
      header,
      options,
      multiSelect: qq.multiSelect === true,
      ...(isOther !== undefined ? { isOther } : {}),
      ...(qq.isSecret === true ? { isSecret: true } : {})
    });
  }
  return questions.length > 0 ? questions : null;
}
