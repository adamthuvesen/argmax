import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vitest";
import chatDetailTable from "../../../fixtures/parity/chat-detail.json";
import inlineMathTable from "../../../fixtures/parity/inline-math.json";
import workspaceChatTable from "../../../fixtures/parity/workspace-chat.json";
import type { SessionSummary } from "../../shared/types.js";
import { normalizeMathDelimiters } from "./normalizeMathDelimiters.js";
import { isProgressNarration, preToolNarrationGroupIds, type AssistantGroup } from "./sessionTurnView.js";
import { CHAT_VERBOSITY_LABELS, resolveChatVerbosity, type ChatVerbosity } from "./uiPreferences.js";
import { chatSessionByWorkspace, chatSessionFor } from "./workspaceChat.js";

// The desktop half of fixtures/parity. ios/Argmax/Tests/ParityTableTests.swift
// runs the same tables against the phone's functions. A case that differs by
// platform names its reason in the table, under `desktop` or `phone`. The
// tables are imported rather than read, so `vitest --changed` sees a table edit.

function onDesktop<Expected extends object>(
  row: Expected & { desktop?: Partial<Expected> & { reason: string } }
): Expected {
  return { ...row, ...row.desktop };
}

type MathNode = { type: string; value?: string; children?: MathNode[] };

function mathSources(markdown: string): string[] {
  const walk = (node: MathNode): string[] =>
    node.type === "math" || node.type === "inlineMath"
      ? [(node.value ?? "").trim()]
      : (node.children ?? []).flatMap(walk);
  return walk(unified().use(remarkParse).use(remarkMath).parse(markdown));
}

describe("workspace chat table", () => {
  const { cases } = workspaceChatTable as unknown as {
    cases: {
      name: string;
      sessions: Pick<SessionSummary, "id" | "workspaceId" | "lastActivityAt">[];
      chats: Record<string, string>;
    }[];
  };

  it.each(cases)("$name", ({ sessions, chats }) => {
    const rows = sessions as SessionSummary[];
    const chosen = Object.fromEntries(
      [...chatSessionByWorkspace(rows)].map(([workspace, chat]) => [workspace, chat.id])
    );
    expect(chosen).toEqual(chats);
    for (const [workspaceId, chat] of Object.entries(chats)) {
      expect(chatSessionFor(rows, workspaceId)?.id).toBe(chat);
    }
  });
});

describe("inline math table", () => {
  const { cases } = inlineMathTable as unknown as {
    cases: { name: string; input: string; math: string[]; desktop?: { math?: string[]; reason: string } }[];
  };

  it.each(cases)("$name", (row) => {
    expect(mathSources(normalizeMathDelimiters(row.input))).toEqual(onDesktop(row).math);
  });
});

describe("chat detail tables", () => {
  type Level = {
    level: ChatVerbosity;
    label: string;
    foldsActivity: boolean;
    hidesNarration: boolean;
    thoughtDisplay: string;
    opensLatestOutputs: boolean;
    hidesSettledThoughts: boolean;
    desktop?: { reason: string };
  };
  type TurnItem = { kind: "user" | "steering" | "assistant" | "thought" | "tools"; id: string; text?: string };
  const { levels, narration, turns } = chatDetailTable as unknown as {
    levels: Level[];
    narration: { name: string; text: string; repeatToUtf16?: number; isNarration: boolean }[];
    turns: {
      name: string;
      live?: boolean;
      items: TurnItem[];
      hidden: string[];
      desktop?: { hidden?: string[]; reason: string };
    }[];
  };

  it.each(levels)("level $level", (row) => {
    const expected = onDesktop(row);
    const resolved = resolveChatVerbosity(row.level);
    const hidesNarration = resolved.toolCallsDisplay === "single-line";
    expect({
      label: CHAT_VERBOSITY_LABELS[row.level],
      foldsActivity: !resolved.toolCallGroupsExpanded,
      hidesNarration,
      thoughtDisplay: resolved.thinkingDisplay,
      opensLatestOutputs: resolved.toolCallsDisplay === "expanded",
      // `hidesSettledThoughts` in SessionConversationTurn, chip closed.
      hidesSettledThoughts: hidesNarration
    }).toEqual({
      label: expected.label,
      foldsActivity: expected.foldsActivity,
      hidesNarration: expected.hidesNarration,
      thoughtDisplay: expected.thoughtDisplay,
      opensLatestOutputs: expected.opensLatestOutputs,
      hidesSettledThoughts: expected.hidesSettledThoughts
    });
  });

  it.each(narration)("narration: $name", ({ text, repeatToUtf16, isNarration }) => {
    const input = repeatToUtf16 ? text.repeat(Math.ceil(repeatToUtf16 / text.length)).slice(0, repeatToUtf16) : text;
    expect(isProgressNarration(input)).toBe(isNarration);
  });

  // One turn runs from a regular user message to the next, steering included
  // (foldConversation). Timestamps stand in for reading order.
  function hiddenNarration(items: TurnItem[], live: boolean): string[] {
    const turnsOf: TurnItem[][] = [];
    for (const item of items) {
      if (item.kind === "user") turnsOf.push([]);
      turnsOf[turnsOf.length - 1]?.push(item);
    }
    const stamp = (item: TurnItem): string => `2026-01-01T00:00:${String(items.indexOf(item)).padStart(2, "0")}.000Z`;
    return turnsOf.flatMap((turn, index) => {
      const groups = turn
        .filter((item) => item.kind === "assistant" || item.kind === "thought")
        .map((item): AssistantGroup => ({
          id: item.id,
          createdAt: stamp(item),
          lastActivityAt: stamp(item),
          text: item.text ?? "",
          streaming: false,
          thinking: item.kind === "thought"
        }));
      const lastTool = turn.filter((item) => item.kind === "tools").at(-1);
      const streaming = live && index === turnsOf.length - 1;
      return [...preToolNarrationGroupIds(groups, !streaming && lastTool ? stamp(lastTool) : null)];
    });
  }

  it.each(turns)("turn: $name", (row) => {
    expect(hiddenNarration(row.items, row.live ?? false)).toEqual(onDesktop(row).hidden);
  });
});
