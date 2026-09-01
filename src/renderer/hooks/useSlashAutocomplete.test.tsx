import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { ListChecks } from "lucide-react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi, ProviderId, SkillSummary } from "../../shared/types.js";
import type { ComposerCommand } from "../lib/composerCommands.js";
import { useSlashAutocomplete } from "./useSlashAutocomplete.js";

function Harness({
  commands,
  initialInput = "",
  provider = "claude",
  workspaceId = "workspace-1"
}: {
  commands?: ComposerCommand[];
  initialInput?: string;
  provider?: ProviderId | null;
  workspaceId?: string | null;
}): JSX.Element {
  const [input, setInput] = useState(initialInput);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const state = useSlashAutocomplete({ commands, input, setInput, provider, workspaceId, inputRef });
  return (
    <div>
      <input
        ref={inputRef}
        aria-label="probe"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={state.onKeyDown}
      />
      <span data-testid="selection-index">{state.selectionIndex}</span>
      <span data-testid="open">{String(state.popoverOpen)}</span>
      <button type="button" onClick={state.dismiss}>
        dismiss
      </button>
      <span data-testid="labels">{state.items.map((item) => (item.kind === "command" ? item.command.label : item.skill.name)).join(",")}</span>
      <span data-testid="filtered-count">{state.items.length}</span>
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

    // ...and the response still has to land. Those keystrokes re-run the effect,
    // and a cancelling cleanup would discard this result while the re-run bails
    // on the latch — leaving the list empty for the rest of the session.
    resolveFirst([{ name: "review", description: "review code", source: "user" }]);
    await waitFor(() => expect(screen.getByTestId("filtered-count").textContent).toBe("1"));
  });

  it("drops the previous provider's skills when the provider changes", async () => {
    // The pane retargets provider in place, so the hook never remounts: a list
    // keyed to the old provider must not be served while the new one loads.
    skillsList.mockResolvedValueOnce([
      { name: "review", description: "review code", source: "user" },
      { name: "refactor", description: "refactor code", source: "user" }
    ]);
    skillsList.mockResolvedValueOnce([{ name: "rustdoc", description: "rust docs", source: "user" }]);

    const { rerender } = render(<Harness initialInput="/r" />);
    await waitFor(() => expect(screen.getByTestId("filtered-count").textContent).toBe("2"));

    rerender(<Harness initialInput="/r" provider="codex" />);
    expect(screen.getByTestId("filtered-count").textContent).toBe("0");

    await waitFor(() => expect(screen.getByTestId("filtered-count").textContent).toBe("1"));
    expect(skillsList).toHaveBeenLastCalledWith({ provider: "codex", workspaceId: "workspace-1" });
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

describe("useSlashAutocomplete — composer commands", () => {
  let skillsList: ReturnType<typeof vi.fn<ArgmaxApi["skills"]["list"]>>;
  let run: ReturnType<typeof vi.fn<() => void>>;
  let commands: ComposerCommand[];

  beforeEach(() => {
    skillsList = vi.fn<ArgmaxApi["skills"]["list"]>().mockResolvedValue([
      { name: "plan-review", description: "Review a plan", source: "user" }
    ]);
    Object.defineProperty(window, "argmax", {
      configurable: true,
      writable: true,
      value: { skills: { list: skillsList } } satisfies Partial<ArgmaxApi>
    });
    run = vi.fn<() => void>();
    commands = [
      { name: "plan", label: "Plan", hint: "Draft a plan", icon: ListChecks, run },
      { name: "attach", label: "Attach file", hint: "Add a file", icon: ListChecks, run: vi.fn() }
    ];
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { argmax?: unknown }).argmax;
  });

  it("lists commands above the skills and runs the picked one", async () => {
    render(<Harness commands={commands} initialInput="tidy this up /pl" />);

    await waitFor(() =>
      expect(screen.getByTestId("labels").textContent).toBe("Plan,plan-review")
    );

    const probe = screen.getByLabelText<HTMLInputElement>("probe");
    fireEvent.keyDown(probe, { key: "Enter" });

    expect(run).toHaveBeenCalledTimes(1);
    // A command acts on the composer, so only the `/token` it was summoned
    // with is dropped — the draft typed before it survives.
    expect(probe.value).toBe("tidy this up ");
  });

  it("drops commands from the list once the query stops prefixing one", async () => {
    render(<Harness commands={commands} initialInput="/rev" />);

    // Skills still match on substring, so `/rev` finds "plan-review" — but no
    // command name or label *starts* with it, so none of them crowd the top.
    await waitFor(() => expect(screen.getByTestId("labels").textContent).toBe("plan-review"));
  });
});

describe("useSlashAutocomplete — dismissal", () => {
  let skillsList: ReturnType<typeof vi.fn<ArgmaxApi["skills"]["list"]>>;

  beforeEach(() => {
    skillsList = vi.fn<ArgmaxApi["skills"]["list"]>().mockResolvedValue([
      { name: "review", description: "review code", source: "user" }
    ]);
    Object.defineProperty(window, "argmax", {
      configurable: true,
      writable: true,
      value: { skills: { list: skillsList } } satisfies Partial<ArgmaxApi>
    });
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { argmax?: unknown }).argmax;
  });

  it("stays closed after a dismissal until the draft changes again", async () => {
    render(<Harness initialInput="/rev" />);
    await waitFor(() => expect(screen.getByTestId("open").textContent).toBe("true"));

    fireEvent.click(screen.getByRole("button", { name: "dismiss" }));
    expect(screen.getByTestId("open").textContent).toBe("false");

    // The draft is untouched by the dismissal, and the next keystroke on the
    // same token brings the menu back.
    const probe = screen.getByLabelText<HTMLInputElement>("probe");
    expect(probe.value).toBe("/rev");
    fireEvent.change(probe, { target: { value: "/revi" } });
    expect(screen.getByTestId("open").textContent).toBe("true");
  });
});
