import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi, ProviderId, SkillSummary } from "../../shared/types.js";
import { useSlashAutocomplete } from "./useSlashAutocomplete.js";

function Harness({
  initialInput = "",
  provider = "claude",
  workspaceId = "workspace-1"
}: {
  initialInput?: string;
  provider?: ProviderId | null;
  workspaceId?: string | null;
}): JSX.Element {
  const [input, setInput] = useState(initialInput);
  const state = useSlashAutocomplete({ input, setInput, provider, workspaceId });
  return (
    <div>
      <input
        aria-label="probe"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={state.onKeyDown}
      />
      <span data-testid="selection-index">{state.selectionIndex}</span>
      <span data-testid="filtered-count">{state.filteredSkills.length}</span>
    </div>
  );
}

describe("useSlashAutocomplete — stale-state + failure-latch guards", () => {
  let skillsList: ReturnType<typeof vi.fn<ArgmaxApi["skills"]["list"]>>;

  beforeEach(() => {
    skillsList = vi.fn<ArgmaxApi["skills"]["list"]>();
    Object.defineProperty(window, "argmax", {
      configurable: true,
      writable: true,
      value: {
        skills: { list: skillsList }
      } satisfies Partial<ArgmaxApi>
    });
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { argmax?: unknown }).argmax;
  });

  it("advances the selection by two when ArrowDown fires twice in rapid succession", async () => {
    // audit-2026-05-11 / SPEC P1.06 — the previous code captured
    // `selectionIndex` directly, so two ArrowDown events batched together
    // would lose the second update. The functional updater fixes that.
    const skills: SkillSummary[] = [
      { name: "review", description: "review code", source: "user" },
      { name: "refactor", description: "refactor code", source: "user" },
      { name: "research", description: "do research", source: "user" }
    ];
    skillsList.mockResolvedValue(skills);

    render(<Harness initialInput="/r" />);

    await waitFor(() => expect(screen.getByTestId("filtered-count").textContent).toBe("3"));
    expect(screen.getByTestId("selection-index").textContent).toBe("0");

    const probe = screen.getByLabelText("probe");
    act(() => {
      fireEvent.keyDown(probe, { key: "ArrowDown" });
      fireEvent.keyDown(probe, { key: "ArrowDown" });
    });

    expect(screen.getByTestId("selection-index").textContent).toBe("2");
  });

  it("retries the skills fetch after a transient failure (no permanent latch)", async () => {
    // audit-2026-05-11 / SPEC P1.07 — `fetchedFor.current = cacheKey` was
    // set before the promise resolved and never cleared in `.catch`, so
    // a transient IPC failure left the popover empty forever for that
    // cacheKey. Fix: clear `fetchedFor.current` in `.catch` so the next
    // effect invocation can retry.
    skillsList.mockRejectedValueOnce(new Error("transient"));
    skillsList.mockResolvedValueOnce([
      { name: "review", description: "review code", source: "user" },
      { name: "refactor", description: "refactor code", source: "user" }
    ]);

    render(<Harness initialInput="/r" />);

    // First mount: the promise rejects. fetchedFor.current should be cleared.
    await waitFor(() => expect(skillsList).toHaveBeenCalledTimes(1));

    // The user keeps typing — input changes from `/r` to `/re`. That changes
    // slashQuery's identity, refiring the effect. Before the fix, the
    // cache-latch was still set to the original cacheKey and the fetch was
    // skipped permanently; now the latch is cleared by the prior catch,
    // and the effect issues a fresh IPC call that resolves successfully.
    const probe = screen.getByLabelText("probe");
    fireEvent.change(probe, { target: { value: "/re" } });

    await waitFor(() => expect(skillsList).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("filtered-count").textContent).toBe("2"));
  });
});
