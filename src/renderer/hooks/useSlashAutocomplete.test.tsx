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
    // Functional state updates keep batched ArrowDown events from collapsing
    // into a single selection move.
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

  it("fires exactly one skills.list IPC for repeated keystrokes during an in-flight fetch", async () => {
    // `fetchedFor.current = cacheKey` must be set before `api.list`. We hold
    // the first promise open so the effect's cache-latch is the only thing
    // preventing duplicate calls.
    let resolveFirst: (skills: SkillSummary[]) => void = () => undefined;
    skillsList.mockReturnValueOnce(
      new Promise<SkillSummary[]>((resolve) => {
        resolveFirst = resolve;
      })
    );

    render(<Harness initialInput="/r" />);

    await waitFor(() => expect(skillsList).toHaveBeenCalledTimes(1));

    const probe = screen.getByLabelText("probe");
    fireEvent.change(probe, { target: { value: "/re" } });
    fireEvent.change(probe, { target: { value: "/rev" } });
    fireEvent.change(probe, { target: { value: "/revi" } });
    fireEvent.change(probe, { target: { value: "/revie" } });

    // The in-flight cache-latch must suppress further IPC calls until the
    // first promise settles. cacheKey is stable across these keystrokes
    // because provider+workspaceId did not change.
    expect(skillsList).toHaveBeenCalledTimes(1);

    // Resolve so the in-flight handle doesn't leak between tests.
    resolveFirst([{ name: "review", description: "review code", source: "user" }]);
  });

  it("retries the skills fetch after a transient failure (no permanent latch)", async () => {
    // A transient IPC failure clears `fetchedFor.current` in `.catch` so the
    // next effect invocation can retry the same cacheKey.
    skillsList.mockRejectedValueOnce(new Error("transient"));
    skillsList.mockResolvedValueOnce([
      { name: "review", description: "review code", source: "user" },
      { name: "refactor", description: "refactor code", source: "user" }
    ]);

    render(<Harness initialInput="/r" />);

    // First mount: the promise rejects. fetchedFor.current should be cleared.
    await waitFor(() => expect(skillsList).toHaveBeenCalledTimes(1));

    // The user keeps typing — input changes from `/r` to `/re`. That changes
    // slashQuery's identity, refiring the effect after the latch is cleared.
    const probe = screen.getByLabelText("probe");
    fireEvent.change(probe, { target: { value: "/re" } });

    await waitFor(() => expect(skillsList).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("filtered-count").textContent).toBe("2"));
  });
});
