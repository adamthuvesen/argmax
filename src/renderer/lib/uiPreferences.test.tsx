import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHAT_VERBOSITY_KEY,
  THINKING_EXPANDED_KEY,
  TOOL_CALLS_DISPLAY_KEY,
  TOOL_CALLS_EXPANDED_KEY,
  TOOL_CALL_GROUPS_EXPANDED_KEY,
  useChatVerbosityPreference,
  type ChatVerbosity
} from "./uiPreferences.js";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("chat verbosity preference", () => {
  it("defaults to Compact when no preference has been saved", () => {
    const { result } = renderHook(() => useChatVerbosityPreference());

    expect(result.current[0]).toBe(2);
  });

  it.each([1, 2, 3, 4, 5] satisfies ChatVerbosity[])(
    "retains saved verbosity level %i",
    (verbosity) => {
      window.localStorage.setItem(CHAT_VERBOSITY_KEY, String(verbosity));

      const { result } = renderHook(() => useChatVerbosityPreference());

      expect(result.current[0]).toBe(verbosity);
    }
  );

  it.each([
    { display: "single-line", groupsExpanded: null, thinkingExpanded: null, expected: 1 },
    { display: "collapsed", groupsExpanded: null, thinkingExpanded: null, expected: 2 },
    { display: "collapsed", groupsExpanded: "false", thinkingExpanded: null, expected: 2 },
    { display: "collapsed", groupsExpanded: "true", thinkingExpanded: null, expected: 3 },
    { display: "expanded", groupsExpanded: null, thinkingExpanded: null, expected: 4 },
    { display: "expanded", groupsExpanded: null, thinkingExpanded: "true", expected: 5 }
  ] as const)(
    "migrates legacy $display preferences to level $expected",
    ({ display, groupsExpanded, thinkingExpanded, expected }) => {
      window.localStorage.setItem(TOOL_CALLS_DISPLAY_KEY, display);
      if (groupsExpanded !== null) {
        window.localStorage.setItem(TOOL_CALL_GROUPS_EXPANDED_KEY, groupsExpanded);
      }
      if (thinkingExpanded !== null) {
        window.localStorage.setItem(THINKING_EXPANDED_KEY, thinkingExpanded);
      }

      const { result } = renderHook(() => useChatVerbosityPreference());

      expect(result.current[0]).toBe(expected);
    }
  );

  it("migrates the oldest expanded boolean to Detailed", () => {
    window.localStorage.setItem(TOOL_CALLS_EXPANDED_KEY, "true");

    const { result } = renderHook(() => useChatVerbosityPreference());

    expect(result.current[0]).toBe(4);
  });
});
