import type { TimelineEvent } from "../../shared/types.js";
import { decodeTimelineEvent } from "./canonicalTimeline.js";
import { parseQuestionsFromToolInput, type Question } from "./questions.js";
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
  delivery?: "async" | "blocking";
  requestId?: string;
};

function normalizedInteractiveToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isExitPlanModeToolName(name: string): boolean {
  return normalizedInteractiveToolName(name) === "exitplanmode";
}

export function isAskUserQuestionToolName(name: string): boolean {
  const normalized = normalizedInteractiveToolName(name);
  return (
    normalized === "askuserquestion" ||
    normalized === "askquestiontoolcall" ||
    normalized === "sendusermessage"
  );
}

function toolsMatching(
  toolItems: readonly TurnToolItem[],
  predicate: (tool: ToolCall) => boolean
): ToolCall[] {
  const matches: ToolCall[] = [];
  for (const item of toolItems) {
    for (const tool of [item.tool, ...(item.children ?? [])]) {
      if (predicate(tool)) matches.push(tool);
    }
  }
  return matches;
}

export function collectExitPlanState(toolItems: readonly TurnToolItem[]): {
  tool: ResolvedExitPlanTool | null;
  hiddenToolIds: Set<string>;
} {
  const hiddenToolIds = new Set<string>();
  let tool: ResolvedExitPlanTool | null = null;
  for (const candidate of toolsMatching(toolItems, (tool) => isExitPlanModeToolName(tool.name))) {
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

export function collectAskUserQuestionState(toolItems: readonly TurnToolItem[]): {
  tool: ResolvedAskUserQuestionTool | null;
  hiddenToolIds: Set<string>;
} {
  const candidateIds = new Set<string>();
  let tool: ResolvedAskUserQuestionTool | null = null;
  for (const candidate of toolsMatching(toolItems, (tool) => isAskUserQuestionToolName(tool.name))) {
    candidateIds.add(candidate.id);
    const questions = parseQuestionsFromToolInput(candidate);
    if (!questions) continue;
    const delivery = candidate.inputFull?.delivery;
    // Blocking Codex requests stay as a running tool until the open RPC is
    // answered. Its completion row is the durable signal that the dock is no
    // longer actionable. Legacy denied tool calls still render after error.
    if (delivery === "blocking" && candidate.status !== "running") continue;
    if (!tool) {
      tool = {
        id: candidate.id,
        createdAt: candidate.createdAt,
        questions,
        ...(delivery === "async" || delivery === "blocking" ? { delivery } : {}),
        ...(typeof candidate.inputFull?.requestId === "string"
          ? { requestId: candidate.inputFull.requestId }
          : {})
      };
    }
  }
  return { tool, hiddenToolIds: candidateIds };
}

// Async questions remain answerable in the dock while progress cues continue.
export function hasOutstandingCardAsk(events: TimelineEvent[], toolCalls: ToolCall[]): boolean {
  let lastUserMessageTime = "";
  for (const event of events) {
    const decoded = decodeTimelineEvent(event);
    if (decoded.kind === "message" && decoded.role === "user" && event.createdAt > lastUserMessageTime) {
      lastUserMessageTime = event.createdAt;
    }
  }
  return toolCalls.some(
    (tool) =>
      ((isAskUserQuestionToolName(tool.name) &&
        tool.inputFull?.delivery !== "async" &&
        (tool.inputFull?.delivery !== "blocking" || tool.status === "running") &&
        parseQuestionsFromToolInput(tool)) ||
        isExitPlanModeToolName(tool.name)) &&
      tool.createdAt > lastUserMessageTime
  );
}
