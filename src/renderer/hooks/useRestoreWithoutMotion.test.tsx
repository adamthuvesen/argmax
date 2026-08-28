import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type JSX } from "react";
import { useRestoreWithoutMotion } from "./useRestoreWithoutMotion.js";

// The slowest entrance animation the restore window has to outlast
// (.chat-bubble, 240ms in chat-conversation.css).
const LONGEST_ENTRANCE_MS = 240;

function Transcript(): JSX.Element {
  const restoring = useRestoreWithoutMotion();
  return <div aria-label="Transcript" data-restoring={restoring ? "true" : undefined} />;
}

function restoringAttr(): string | null {
  return screen.getByLabelText("Transcript").getAttribute("data-restoring");
}

describe("useRestoreWithoutMotion", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("suppresses entrance motion on mount and releases it once the transcript has settled", () => {
    vi.useFakeTimers();
    render(<Transcript />);

    expect(restoringAttr()).toBe("true");

    // Still suppressed while the longest entrance animation would be running:
    // clearing early would let every restored bubble start its animation over.
    act(() => {
      vi.advanceTimersByTime(LONGEST_ENTRANCE_MS);
    });
    expect(restoringAttr()).toBe("true");

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(restoringAttr()).toBeNull();
  });
});
