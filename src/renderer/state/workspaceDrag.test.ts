// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginWorkspacePointerDrag,
  consumeWorkspaceDragClick,
  resetWorkspaceDragForTests,
  subscribeWorkspacePointerDrag,
  workspaceDragSnapshot
} from "./workspaceDrag.js";

function dispatchPointer(
  type: "pointermove" | "pointerup" | "pointercancel",
  input: { pointerId: number; clientX: number; clientY: number }
): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: input.clientX,
    clientY: input.clientY
  });
  Object.defineProperty(event, "pointerId", { value: input.pointerId });
  window.dispatchEvent(event);
  return event;
}

describe("workspace pointer drag", () => {
  afterEach(() => {
    resetWorkspaceDragForTests();
    vi.restoreAllMocks();
  });

  it("starts after movement, reports the drop point, and suppresses the source click", () => {
    const move = vi.fn();
    const drop = vi.fn();
    const cancel = vi.fn();
    const unsubscribe = subscribeWorkspacePointerDrag({ move, drop, cancel });

    beginWorkspacePointerDrag("workspace-1", {
      pointerId: 7,
      button: 0,
      clientX: 10,
      clientY: 20
    });
    dispatchPointer("pointermove", { pointerId: 7, clientX: 13, clientY: 23 });
    expect(workspaceDragSnapshot()).toBeNull();

    const moved = dispatchPointer("pointermove", { pointerId: 7, clientX: 18, clientY: 20 });
    expect(moved.defaultPrevented).toBe(true);
    expect(workspaceDragSnapshot()).toBe("workspace-1");
    expect(move).toHaveBeenLastCalledWith({ clientX: 18, clientY: 20 });

    const released = dispatchPointer("pointerup", { pointerId: 7, clientX: 80, clientY: 90 });
    expect(released.defaultPrevented).toBe(true);
    expect(drop).toHaveBeenCalledWith({ clientX: 80, clientY: 90 });
    expect(cancel).not.toHaveBeenCalled();
    expect(workspaceDragSnapshot()).toBeNull();
    expect(consumeWorkspaceDragClick("workspace-1")).toBe(true);
    expect(consumeWorkspaceDragClick("workspace-1")).toBe(false);

    unsubscribe();
  });

  it("cancels an active drag without dropping when the pointer session is interrupted", () => {
    const listener = { move: vi.fn(), drop: vi.fn(), cancel: vi.fn() };
    const onFinish = vi.fn();
    const unsubscribe = subscribeWorkspacePointerDrag(listener);
    beginWorkspacePointerDrag("workspace-2", {
      pointerId: 2,
      button: 0,
      clientX: 0,
      clientY: 0,
      onFinish
    });
    dispatchPointer("pointermove", { pointerId: 2, clientX: 6, clientY: 0 });
    dispatchPointer("pointercancel", { pointerId: 2, clientX: 6, clientY: 0 });

    expect(listener.cancel).toHaveBeenCalledOnce();
    expect(listener.drop).not.toHaveBeenCalled();
    expect(onFinish).toHaveBeenCalledOnce();
    expect(workspaceDragSnapshot()).toBeNull();
    unsubscribe();
  });
});
