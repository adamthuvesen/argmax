import { useCallback, useState } from "react";

export const SIDEBAR_PRIORITY_KEY = "argmax.sidebar.priority.visible";
export const SIDEBAR_COLLAPSED_KEY = "argmax.sidebar.collapsed";
export const WORKSPACE_CARD_KEY = "argmax.workspaceCard.visible";
export const CHAT_VERBOSITY_KEY = "argmax.chat.verbosity";
export const THINKING_EXPANDED_KEY = "argmax.thinking.expanded";
export const TOOL_CALLS_EXPANDED_KEY = "argmax.toolCalls.expanded";
export const TOOL_CALLS_DISPLAY_KEY = "argmax.toolCalls.display";
export const TOOL_CALL_GROUPS_EXPANDED_KEY = "argmax.toolCalls.groups.expanded";
export const TURN_CHANGES_EXPANDED_KEY = "argmax.turnChanges.expanded";
export const FAST_MODE_KEY = "argmax.fastMode.enabled";
export const COMPOSER_PIXEL_FIELD_KEY = "argmax.composer.pixelField.enabled";
export const RANDOM_SESSION_ICON_KEY = "argmax.sessionIcon.random.enabled";

function readBooleanPreference(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  return raw === null ? fallback : raw === "true";
}

export function writeBooleanPreference(key: string, value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Quota or private-mode failures are non-fatal for appearance prefs.
  }
}

/**
 * Read an integer UI preference (a persisted pixel size), clamped into
 * `[min, max]`. A missing or non-numeric value returns `fallback`; a stored
 * value outside the range clamps to the nearest bound rather than resetting —
 * so a width saved under an older min/max survives instead of snapping back.
 */
export function readBoundedNumberPreference(
  key: string,
  { min, max, fallback }: { min: number; max: number; fallback: number }
): number {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

/** Boolean UI preference with mirrored localStorage persistence. */
export function useBooleanUiPreference(key: string, fallback: boolean): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => readBooleanPreference(key, fallback));
  const setPreference = useCallback(
    (next: boolean) => {
      setValue(next);
      writeBooleanPreference(key, next);
    },
    [key]
  );
  return [value, setPreference];
}

/** How much tool-call detail the chat shows: expanded rows, collapsed group
 *  headers, or a single self-updating line per gap between replies. */
export type ToolCallsDisplay = "expanded" | "collapsed" | "single-line";

const TOOL_CALLS_DISPLAY_VALUES: readonly ToolCallsDisplay[] = ["expanded", "collapsed", "single-line"];

/** 1–5 scale governing default tool calls, groups, and thinking detail. */
export type ChatVerbosity = 1 | 2 | 3 | 4 | 5;

export interface ResolvedVerbosity {
  toolCallsDisplay: ToolCallsDisplay;
  toolCallGroupsExpanded: boolean;
  thinkingExpanded: boolean;
}

export const CHAT_VERBOSITY_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "1", label: "1 · Minimal" },
  { value: "2", label: "2 · Compact" },
  { value: "3", label: "3 · Balanced" },
  { value: "4", label: "4 · Detailed" },
  { value: "5", label: "5 · Full trace" }
];

export const CHAT_VERBOSITY_HINTS: Record<ChatVerbosity, string> = {
  1: "One self-updating summary line per turn. Completed thoughts and tool lists fold away.",
  2: "Turn chips with collapsed group headers. No raw tool lists or reasoning blocks.",
  3: "Live tools and reasoning expand while running, then collapse to tidy group headers on answer.",
  4: "Tool groups and touched files stay expanded on recent turns for quick inspection.",
  5: "Full trace: all tool calls, diffs, and thought blocks stay wide open across history."
};

export function resolveChatVerbosity(verbosity: ChatVerbosity): ResolvedVerbosity {
  switch (verbosity) {
    case 1:
      return { toolCallsDisplay: "single-line", toolCallGroupsExpanded: false, thinkingExpanded: false };
    case 2:
      return { toolCallsDisplay: "collapsed", toolCallGroupsExpanded: false, thinkingExpanded: false };
    case 3:
      return { toolCallsDisplay: "collapsed", toolCallGroupsExpanded: true, thinkingExpanded: false };
    case 4:
      return { toolCallsDisplay: "expanded", toolCallGroupsExpanded: true, thinkingExpanded: false };
    case 5:
      return { toolCallsDisplay: "expanded", toolCallGroupsExpanded: true, thinkingExpanded: true };
  }
}

function readChatVerbosity(): ChatVerbosity {
  if (typeof window === "undefined") return 3;
  const raw = window.localStorage.getItem(CHAT_VERBOSITY_KEY);
  if (raw !== null) {
    const parsed = Number.parseInt(raw, 10);
    if (parsed >= 1 && parsed <= 5) return parsed as ChatVerbosity;
  }
  // Migrate legacy granular preferences if present
  const legacyDisplay = window.localStorage.getItem(TOOL_CALLS_DISPLAY_KEY);
  if (legacyDisplay === "single-line") return 1;
  const legacyGroups = window.localStorage.getItem(TOOL_CALL_GROUPS_EXPANDED_KEY);
  if (legacyDisplay === "collapsed" && legacyGroups === "false") return 2;
  const legacyThinking = window.localStorage.getItem(THINKING_EXPANDED_KEY);
  if (legacyDisplay === "expanded" && legacyThinking === "true") return 5;
  if (legacyDisplay === "expanded") return 4;
  return 3;
}

export function useChatVerbosityPreference(): [ChatVerbosity, (value: ChatVerbosity) => void] {
  const [value, setValue] = useState<ChatVerbosity>(readChatVerbosity);
  const setPreference = useCallback((next: ChatVerbosity) => {
    setValue(next);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(CHAT_VERBOSITY_KEY, String(next));
      } catch {
        // Quota or private-mode failures are non-fatal for appearance prefs.
      }
    }
  }, []);
  return [value, setPreference];
}

function readToolCallsDisplay(): ToolCallsDisplay {
  if (typeof window === "undefined") return "collapsed";
  const raw = window.localStorage.getItem(TOOL_CALLS_DISPLAY_KEY);
  if (raw !== null && TOOL_CALLS_DISPLAY_VALUES.includes(raw as ToolCallsDisplay)) {
    return raw as ToolCallsDisplay;
  }
  // Migrate the pre-tri-state boolean; absent legacy value reads as the
  // "collapsed" default the boolean hook shipped with.
  return readBooleanPreference(TOOL_CALLS_EXPANDED_KEY, false) ? "expanded" : "collapsed";
}

/** Tri-state "Tool calls in chat" preference with legacy boolean migration. */
export function useToolCallsDisplayPreference(): [ToolCallsDisplay, (value: ToolCallsDisplay) => void] {
  const [value, setValue] = useState<ToolCallsDisplay>(readToolCallsDisplay);
  const setPreference = useCallback((next: ToolCallsDisplay) => {
    setValue(next);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(TOOL_CALLS_DISPLAY_KEY, next);
      } catch {
        // Quota or private-mode failures are non-fatal for appearance prefs.
      }
    }
  }, []);
  return [value, setPreference];
}
