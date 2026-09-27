import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useState } from "react";
import {
  useAppNavigationHistory,
  type AppNavigationDestination
} from "./useAppNavigationHistory.js";

const LAUNCHER: AppNavigationDestination = {
  kind: "launcher",
  sideChatMode: false,
  projectId: "project-1"
};
const SIDE_CHAT_LAUNCHER: AppNavigationDestination = {
  kind: "launcher",
  sideChatMode: true,
  projectId: null
};
const CHAT: AppNavigationDestination = {
  kind: "grid",
  grid: {
    rows: [[{ sessionId: "session-1", workspaceId: "workspace-1" }]],
    focused: { row: 0, col: 0 }
  }
};
const SETTINGS: AppNavigationDestination = { kind: "settings", group: "general" };
const SCHEDULE: AppNavigationDestination = { kind: "schedule" };

afterEach(() => cleanup());

function mouseHistory(button: 3 | 4, target: HTMLElement = document.body): void {
  fireEvent.mouseDown(target, { button });
  fireEvent.mouseUp(target, { button });
}

function renderHistory(initial: AppNavigationDestination = LAUNCHER) {
  let available = (destination: AppNavigationDestination): boolean => destination.kind !== "arc";
  const hook = renderHook(() => {
    const [destination, setDestination] = useState(initial);
    useAppNavigationHistory({
      destination,
      canRestore: (candidate) => available(candidate),
      restore: setDestination
    });
    return { destination, setDestination };
  });
  return {
    ...hook,
    setAvailable: (check: typeof available): void => {
      available = check;
      hook.rerender();
    }
  };
}

describe("useAppNavigationHistory", () => {
  it("walks destinations without recording its own replay", () => {
    const { result } = renderHistory();
    act(() => result.current.setDestination(CHAT));
    act(() => result.current.setDestination(SETTINGS));

    mouseHistory(3);
    expect(result.current.destination).toEqual(CHAT);
    mouseHistory(3);
    expect(result.current.destination).toEqual(LAUNCHER);
    mouseHistory(4);
    expect(result.current.destination).toEqual(CHAT);
    mouseHistory(4);
    expect(result.current.destination).toEqual(SETTINGS);

    mouseHistory(4);
    expect(result.current.destination).toEqual(SETTINGS);
  });

  it("drops the forward branch after new navigation", () => {
    const { result } = renderHistory();
    act(() => result.current.setDestination(CHAT));
    act(() => result.current.setDestination(SETTINGS));
    mouseHistory(3);
    expect(result.current.destination).toEqual(CHAT);

    act(() => result.current.setDestination(SCHEDULE));
    mouseHistory(4);
    expect(result.current.destination).toEqual(SCHEDULE);
    mouseHistory(3);
    expect(result.current.destination).toEqual(CHAT);
  });

  it("does not record a semantically unchanged grid snapshot", () => {
    const { result } = renderHistory();
    act(() => result.current.setDestination(CHAT));
    act(() => result.current.setDestination({
      kind: "grid",
      grid: {
        rows: CHAT.kind === "grid"
          ? CHAT.grid.rows.map((row) => row.map((cell) => ({ ...cell })))
          : [],
        focused: { row: 0, col: 0 }
      }
    }));
    act(() => result.current.setDestination(SETTINGS));

    mouseHistory(3);
    expect(result.current.destination).toEqual(CHAT);
    mouseHistory(3);
    expect(result.current.destination).toEqual(LAUNCHER);
  });

  it("restores each launcher's chat mode and project context", () => {
    const { result } = renderHistory();
    act(() => result.current.setDestination(SIDE_CHAT_LAUNCHER));
    act(() => result.current.setDestination(CHAT));
    const otherProjectLauncher: AppNavigationDestination = {
      kind: "launcher",
      sideChatMode: false,
      projectId: "project-2"
    };
    act(() => result.current.setDestination(otherProjectLauncher));
    act(() => result.current.setDestination(SCHEDULE));

    mouseHistory(3);
    expect(result.current.destination).toEqual(otherProjectLauncher);
    mouseHistory(3);
    expect(result.current.destination).toEqual(CHAT);
    mouseHistory(3);
    expect(result.current.destination).toEqual(SIDE_CHAT_LAUNCHER);
  });

  it("skips destinations that disappeared", () => {
    const { result, setAvailable } = renderHistory();
    act(() => result.current.setDestination(CHAT));
    act(() => result.current.setDestination(SETTINGS));
    setAvailable((destination) => destination.kind !== "grid");

    mouseHistory(3);
    expect(result.current.destination).toEqual(LAUNCHER);
  });

  it("leaves browser-panel gestures to browser history", () => {
    const { result } = renderHistory();
    act(() => result.current.setDestination(CHAT));
    const panel = document.createElement("div");
    panel.className = "browser-panel";
    const target = document.createElement("button");
    panel.append(target);
    document.body.append(panel);

    mouseHistory(3, target);
    expect(result.current.destination).toEqual(CHAT);
    mouseHistory(3);
    expect(result.current.destination).toEqual(LAUNCHER);
    panel.remove();
  });

  it("consumes thumb buttons at history bounds and ignores ordinary buttons", () => {
    renderHistory();
    const down = new MouseEvent("mousedown", { button: 3, bubbles: true, cancelable: true });
    const up = new MouseEvent("mouseup", { button: 3, bubbles: true, cancelable: true });
    expect(document.body.dispatchEvent(down)).toBe(false);
    expect(document.body.dispatchEvent(up)).toBe(false);

    const ordinary = new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true });
    expect(document.body.dispatchEvent(ordinary)).toBe(true);
  });
});
