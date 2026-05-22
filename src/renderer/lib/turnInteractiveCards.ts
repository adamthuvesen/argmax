import type { TimelineEvent } from "../../shared/types.js";
import { parseQuestionsFromToolInput, type Question } from "./questions.js";
import { toolsNamed } from "./turnToolItems.js";
import type { ToolCall, TurnToolItem } from "./toolCalls.js";

export type ResolvedExitPlanTool = {
  id: string;
  createdAt: string;
  markdown: string;
};

export type ResolvedAskUserQuestionTool = {
  id: string;
  createdAt: string;
  questions: Question[];
};

export function collectExitPlanState(toolItems: TurnToolItem[]): {
  tool: ResolvedExitPlanTool | null;
  hiddenToolIds: Set<string>;
} {
  const hiddenToolIds = new Set<string>();
  let tool: ResolvedExitPlanTool | null = null;
  for (const candidate of toolsNamed(toolItems, "ExitPlanMode")) {
    hiddenToolIds.add(candidate.id);
    if (candidate.status === "running") continue;
    const planArg = candidate.inputFull?.plan;
    if (typeof planArg !== "string" || planArg.trim().length === 0) continue;
    if (!tool) {
      tool = { id: candidate.id, createdAt: candidate.createdAt, markdown: planArg };
    }
  }
  return { tool, hiddenToolIds };
}

export function collectAskUserQuestionState(toolItems: TurnToolItem[]): {
  tool: ResolvedAskUserQuestionTool | null;
  hiddenToolIds: Set<string>;
} {
  const candidateIds = new Set<string>();
  let tool: ResolvedAskUserQuestionTool | null = null;
  for (const candidate of toolsNamed(toolItems, "AskUserQuestion")) {
    candidateIds.add(candidate.id);
    const questions = parseQuestionsFromToolInput(candidate);
    if (!questions) continue;
    if (!tool) {
      tool = { id: candidate.id, createdAt: candidate.createdAt, questions };
    }
  }
  const hiddenToolIds = tool ? candidateIds : new Set<string>();
  return { tool, hiddenToolIds };
}

export function hasOutstandingCardAsk(events: TimelineEvent[], toolCalls: ToolCall[]): boolean {
  let lastUserMessageTime = "";
  for (const event of events) {
    if (event.type === "user.message" && event.createdAt > lastUserMessageTime) {
      lastUserMessageTime = event.createdAt;
    }
  }
  return toolCalls.some(
    (tool) =>
      ((tool.name === "AskUserQuestion" && parseQuestionsFromToolInput(tool)) ||
        tool.name === "ExitPlanMode") &&
      tool.createdAt > lastUserMessageTime
  );
}
