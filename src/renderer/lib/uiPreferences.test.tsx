import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHAT_VERBOSITY_KEY,
  TOOL_CALLS_DISPLAY_KEY,
  TOOL_CALLS_EXPANDED_KEY,
  TOOL_CALL_GROUPS_EXPANDED_KEY,
  resolveChatVerbosity,
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

  it.each([1, 2, 3, 4] satisfies ChatVerbosity[])(
    "retains saved verbosity level %i",
    (verbosity) => {
      window.localStorage.setItem(CHAT_VERBOSITY_KEY, String(verbosity));

      const { result } = renderHook(() => useChatVerbosityPreference());

      expect(result.current[0]).toBe(verbosity);
    }
  );

  it("migrates the removed Full trace level to Detailed", () => {
    window.localStorage.setItem(CHAT_VERBOSITY_KEY, "5");

    const { result } = renderHook(() => useChatVerbosityPreference());

    expect(result.current[0]).toBe(4);
    expect(window.localStorage.getItem(CHAT_VERBOSITY_KEY)).toBe("4");
  });

  it.each([
    { display: "single-line", groupsExpanded: null, expected: 1 },
    { display: "collapsed", groupsExpanded: null, expected: 2 },
    { display: "collapsed", groupsExpanded: "false", expected: 2 },
    { display: "collapsed", groupsExpanded: "true", expected: 3 },
    { display: "expanded", groupsExpanded: null, expected: 4 }
  ] as const)(
    "migrates legacy $display preferences to level $expected",
    ({ display, groupsExpanded, expected }) => {
      window.localStorage.setItem(TOOL_CALLS_DISPLAY_KEY, display);
      if (groupsExpanded !== null) {
        window.localStorage.setItem(TOOL_CALL_GROUPS_EXPANDED_KEY, groupsExpanded);
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

  it.each([
    {
      verbosity: 1,
      expected: { toolCallsDisplay: "single-line", toolCallGroupsExpanded: false, thinkingDisplay: "collapsed" }
    },
    {
      verbosity: 2,
      expected: { toolCallsDisplay: "collapsed", toolCallGroupsExpanded: false, thinkingDisplay: "collapsed" }
    },
    {
      verbosity: 3,
      expected: { toolCallsDisplay: "collapsed", toolCallGroupsExpanded: true, thinkingDisplay: "preview" }
    },
    {
      verbosity: 4,
      expected: { toolCallsDisplay: "expanded", toolCallGroupsExpanded: true, thinkingDisplay: "inline" }
    }
  ] satisfies Array<{ verbosity: ChatVerbosity; expected: ReturnType<typeof resolveChatVerbosity> }>)(
    "resolves level $verbosity to its disclosure settings",
    ({ verbosity, expected }) => {
      expect(resolveChatVerbosity(verbosity)).toEqual(expected);
    }
  );
});
