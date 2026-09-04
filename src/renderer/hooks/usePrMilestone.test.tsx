import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { workspace as baseWorkspace } from "../../test/sessionConversationTestHarness.js";
import { PrMilestoneCelebrationContext } from "../lib/uiPreferences.js";
import { usePrMilestone } from "./usePrMilestone.js";

const start = "2026-09-05T10:00:00.000Z";
const later = "2026-09-05T10:00:05.000Z";
const old = "2026-09-04T10:00:00.000Z";
const workspace = { ...baseWorkspace, prNumber: null, prState: null, prCreatedAt: null, prMergedAt: null };
let enabled = true;
function wrapper({ children }: { children: ReactNode }) {
  return <PrMilestoneCelebrationContext value={enabled}>{children}</PrMilestoneCelebrationContext>;
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); enabled = true; });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("confirmed PR milestones", () => {
  it("celebrates a newly created PR once, independently of turn completion", () => {
    const { result, rerender } = renderHook(usePrMilestone, { initialProps: baseWorkspace, wrapper });
    const created = { ...workspace, prNumber: 42, prState: "OPEN" as const, prCreatedAt: later };
    vi.setSystemTime(later);
    rerender(created);
    expect(result.current.milestone).toBe("42:created");
    act(() => result.current.finish());
    rerender({ ...created, changedFiles: 20 });
    expect(result.current.milestone).toBeNull();
  });

  it("ignores an old PR discovered later and an offline merge", () => {
    const { result, rerender } = renderHook(usePrMilestone, { initialProps: baseWorkspace, wrapper });
    rerender({ ...workspace, prNumber: 42, prState: "OPEN", prCreatedAt: old });
    expect(result.current.milestone).toBeNull();
    rerender({ ...workspace, prNumber: 42, prState: "MERGED", prCreatedAt: old, prMergedAt: old });
    expect(result.current.milestone).toBeNull();
  });

  it("celebrates a confirmed merge once, including creation and merge between polls", () => {
    const { result, rerender } = renderHook(usePrMilestone, { initialProps: baseWorkspace, wrapper });
    const merged = { ...workspace, prNumber: 42, prState: "MERGED" as const, prCreatedAt: later, prMergedAt: later };
    vi.setSystemTime(later);
    rerender(merged);
    expect(result.current.milestone).toBe("42:merged");
    act(() => result.current.finish());
    rerender({ ...merged });
    expect(result.current.milestone).toBeNull();
  });

  it("does not celebrate missing timestamps, closed PRs, or ordinary updates", () => {
    const { result, rerender } = renderHook(usePrMilestone, { initialProps: baseWorkspace, wrapper });
    rerender({ ...workspace, changedFiles: 10 });
    expect(result.current.milestone).toBeNull();
    rerender({ ...workspace, prNumber: 42, prState: "OPEN" });
    expect(result.current.milestone).toBeNull();
    rerender({ ...workspace, prNumber: 42, prState: "CLOSED", prCreatedAt: later });
    expect(result.current.milestone).toBeNull();
  });

  it("stays off by default without a settings provider", () => {
    const { result, rerender } = renderHook(usePrMilestone, { initialProps: baseWorkspace });
    rerender({ ...workspace, prNumber: 42, prState: "OPEN", prCreatedAt: later });
    expect(result.current.milestone).toBeNull();
  });

  it("does not replay disabled milestones when enabled, even if discovery is delayed", () => {
    enabled = false;
    const { result, rerender } = renderHook(usePrMilestone, { initialProps: baseWorkspace, wrapper });
    vi.setSystemTime("2026-09-05T10:00:10.000Z");
    enabled = true;
    rerender({ ...workspace });
    rerender({ ...workspace, prNumber: 42, prState: "OPEN", prCreatedAt: later });
    expect(result.current.milestone).toBeNull();
  });

  it("resets on branch navigation and suppresses initial historical values", () => {
    const created = { ...workspace, prNumber: 42, prState: "OPEN" as const, prCreatedAt: old };
    const { result, rerender } = renderHook(usePrMilestone, { initialProps: created, wrapper });
    expect(result.current.milestone).toBeNull();
    vi.setSystemTime(later);
    rerender({ ...created, branch: "another-branch", prCreatedAt: later });
    expect(result.current.milestone).toBeNull();
  });
});
