import type { ToolCall } from "./toolCalls.js";

export type QuestionOption = {
  label: string;
  description?: string;
};

export type Question = {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
};

/// The labels the reader picked, in the order the question listed them.
export function pickedLabels(question: Question, picks: number[]): string[] {
  return picks
    .map((index) => question.options[index]?.label)
    .filter((label): label is string => typeof label === "string" && label.length > 0);
}

/// The answer as it is sent back to the agent: one `**Header**: choices` line
/// per question. Both the docked panel and the transcript card send this exact
/// shape, so an answer reads the same however it was given.
export function formatAnswer(questions: Question[], selected: number[][]): string {
  return questions
    .map((question, index) => {
      const labels = pickedLabels(question, selected[index] ?? []);
      const header = question.header || question.question;
      const value = labels.length > 0 ? labels.join(", ") : "(no selection)";
      return `**${header}**: ${value}`;
    })
    .join("\n\n");
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
    if (options.length === 0) continue;
    questions.push({
      question: questionText,
      header,
      options,
      multiSelect: qq.multiSelect === true
    });
  }
  return questions.length > 0 ? questions : null;
}
