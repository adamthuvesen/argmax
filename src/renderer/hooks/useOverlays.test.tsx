import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useOverlays } from "./useOverlays.js";

describe("useOverlays", () => {
  it("keeps the two full-screen panels mutually exclusive", () => {
    const { result } = renderHook(() => useOverlays());

    act(() => result.current.setIsScheduledTasksOpen(true));
    expect(result.current.isScheduledTasksOpen).toBe(true);

    act(() => result.current.setIsSettingsOpen(true));
    expect(result.current.isSettingsOpen).toBe(true);
    expect(result.current.isScheduledTasksOpen).toBe(false);

    act(() => result.current.setIsScheduledTasksOpen(true));
    expect(result.current.isSettingsOpen).toBe(false);
  });

  // Every navigation site in App dismisses settings before showing a session,
  // project, or launcher. Scheduled tasks must ride along, or the panel stays
  // stranded over the grid it was supposed to hand back.
  it("closing settings also closes scheduled tasks", () => {
    const { result } = renderHook(() => useOverlays());

    act(() => result.current.setIsScheduledTasksOpen(true));
    act(() => result.current.setIsSettingsOpen(false));

    expect(result.current.isScheduledTasksOpen).toBe(false);
    expect(result.current.isSettingsOpen).toBe(false);
  });
});
