import { createContext, useCallback, useState } from "react";

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
export const PR_MILESTONE_CELEBRATION_KEY = "argmax.prMilestones.celebrate";
export const RANDOM_SESSION_ICON_KEY = "argmax.sessionIcon.random.enabled";
export const DESKTOP_NOTIFICATIONS_KEY = "argmax.desktopNotifications.enabled";
export const KEEP_AWAKE_KEY = "argmax.keepAwake.enabled";
export const BROWSER_PAGE_OPEN_KEY = "argmax.browser.pageOpen";

export const PrMilestoneCelebrationContext = createContext(false);

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

/** Whether thought content uses a disclosure row or stays visible inline. */
export type ThinkingDisplay = "collapsed" | "inline";

/** 1–4 scale governing default tool calls, groups, and thinking detail. */
export type ChatVerbosity = 1 | 2 | 3 | 4;

export interface ResolvedVerbosity {
  toolCallsDisplay: ToolCallsDisplay;
  toolCallGroupsExpanded: boolean;
  thinkingDisplay: ThinkingDisplay;
}

export const CHAT_VERBOSITY_LABELS: Record<ChatVerbosity, string> = {
  1: "Minimal",
  2: "Compact",
  3: "Balanced",
  4: "Detailed"
};

export const CHAT_VERBOSITY_HINTS: Record<ChatVerbosity, string> = {
  1: "Activity summaries while working. Finished turns keep the answer and failures. Click Worked for to inspect the work.",
  2: "One short activity summary between messages. Expand to see commands, files, and agent activity.",
  3: "One short activity summary between messages, with thoughts always shown inline.",
  4: "Tool calls and groups open on the latest turn, with thoughts always shown inline."
};

export function resolveChatVerbosity(verbosity: ChatVerbosity): ResolvedVerbosity {
  switch (verbosity) {
    case 1:
      return { toolCallsDisplay: "single-line", toolCallGroupsExpanded: false, thinkingDisplay: "collapsed" };
    case 2:
      return { toolCallsDisplay: "collapsed", toolCallGroupsExpanded: false, thinkingDisplay: "collapsed" };
    case 3:
      return { toolCallsDisplay: "collapsed", toolCallGroupsExpanded: false, thinkingDisplay: "inline" };
    case 4:
      return { toolCallsDisplay: "expanded", toolCallGroupsExpanded: true, thinkingDisplay: "inline" };
  }
}

function readChatVerbosity(): ChatVerbosity {
  if (typeof window === "undefined") return 2;
  const raw = window.localStorage.getItem(CHAT_VERBOSITY_KEY);
  if (raw !== null) {
    const parsed = Number.parseInt(raw, 10);
    if (parsed >= 1 && parsed <= 4) return parsed as ChatVerbosity;
    if (parsed === 5) {
      try {
        window.localStorage.setItem(CHAT_VERBOSITY_KEY, "4");
      } catch {
        // A storage failure must not prevent the saved setting from resolving.
      }
      return 4;
    }
  }
  // Migrate legacy granular preferences if present
  const legacyDisplay = readToolCallsDisplay();
  if (legacyDisplay === "single-line") return 1;
  const legacyGroups = window.localStorage.getItem(TOOL_CALL_GROUPS_EXPANDED_KEY);
  if (legacyDisplay === "collapsed") return legacyGroups === "true" ? 3 : 2;
  if (legacyDisplay === "expanded") return 4;
  return 2;
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
