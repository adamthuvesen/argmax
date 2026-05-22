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
