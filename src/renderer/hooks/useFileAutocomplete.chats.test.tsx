import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState, type JSX } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi } from "../../shared/types.js";
import type { ChatDirectoryEntry } from "../state/chatDirectory.js";
import { useFileAutocomplete } from "./useFileAutocomplete.js";

const directory: ChatDirectoryEntry[] = [
  { sessionId: "s-billing", workspaceId: "w1", title: "Billing rewrite", projectName: "Argmax", lastActivityAt: "2026-10-03T00:00:00Z" },
  { sessionId: "s-export", workspaceId: "w2", title: "Export job", projectName: "Dotfiles", lastActivityAt: "2026-10-02T00:00:00Z" },
  { sessionId: "s-self", workspaceId: "w3", title: "Billing this chat", projectName: "Argmax", lastActivityAt: "2026-10-01T00:00:00Z" }
];

function Harness({ initialInput }: { initialInput: string }): JSX.Element {
  const [input, setInput] = useState(initialInput);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const state = useFileAutocomplete({
    input,
    setInput,
    inputRef,
    source: null,
    chats: directory,
    ownSessionId: "s-self"
  });
  return (
    <div>
      <textarea
        aria-label="probe"
        ref={inputRef}
        value={input}
        onChange={(event) => {
          setInput(event.target.value);
          state.onSelectionChange(event.target.selectionStart);
        }}
        onKeyDown={(event) => state.onKeyDown(event.nativeEvent)}
        onSelect={(event) => state.onSelectionChange(event.currentTarget.selectionStart)}
      />
      <span data-testid="open">{state.popoverOpen ? "yes" : "no"}</span>
      <ul>
        {state.filteredEntries.map((entry) => (
          <li key={`${entry.kind}:${entry.path}`} data-testid={`entry-${entry.kind}`}>
            {entry.kind === "chat" ? `${entry.title}|${entry.snippet ?? ""}` : entry.path}
          </li>
        ))}
      </ul>
    </div>
  );
}

function caretAtEnd(): HTMLTextAreaElement {
  const probe = screen.getByLabelText<HTMLTextAreaElement>("probe");
  act(() => {
    probe.setSelectionRange(probe.value.length, probe.value.length);
    fireEvent.select(probe);
  });
  return probe;
}

describe("useFileAutocomplete chat references", () => {
  const search = vi.fn<ArgmaxApi["session"]["search"]>();

  beforeEach(() => {
    search.mockReset();
    search.mockResolvedValue([]);
    window.argmax = { session: { search } } as unknown as ArgmaxApi;
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    delete (window as unknown as { argmax?: unknown }).argmax;
  });

  it("offers chats by title with no file list at all, and never the chat itself", () => {
    render(<Harness initialInput="@bil" />);
    caretAtEnd();

    expect(screen.getByTestId("open").textContent).toBe("yes");
    expect(screen.getAllByTestId("entry-chat").map((node) => node.textContent)).toEqual([
      "Billing rewrite|"
    ]);
  });

  it("stays a files-only menu for a one-letter query", () => {
    render(<Harness initialInput="@b" />);
    caretAtEnd();

    expect(screen.getByTestId("open").textContent).toBe("no");
    expect(screen.queryAllByTestId("entry-chat")).toHaveLength(0);
  });

  it("attaches the chosen chat as its reference link, replacing the @query", () => {
    render(<Harness initialInput="compare @bil" />);
    const probe = caretAtEnd();

    fireEvent.keyDown(probe, { key: "Enter" });

    expect(probe.value).toBe("compare [Billing rewrite](argmax://chat/s-billing?v=1) ");
  });

  it("adds chats found by what was said in them, after the title hits, with a clean snippet", async () => {
    search.mockResolvedValue([
      { sessionId: "s-export", eventId: "e1", snippet: "the <b>invoice</b> export ran", rank: 1 },
      { sessionId: "s-export", eventId: "e2", snippet: "again", rank: 2 },
      { sessionId: "s-unknown", eventId: "e3", snippet: "not in the directory", rank: 3 },
      { sessionId: "s-self", eventId: "e4", snippet: "this chat", rank: 4 }
    ]);
    render(<Harness initialInput="@invoice" />);
    caretAtEnd();

    await waitFor(() =>
      expect(screen.getAllByTestId("entry-chat").map((node) => node.textContent)).toEqual([
        "Export job|the invoice export ran"
      ])
    );
    expect(search).toHaveBeenCalledWith({ query: "invoice", limit: 12 });
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("waits for typing to pause before searching conversation text", () => {
    vi.useFakeTimers();
    render(<Harness initialInput="@inv" />);
    caretAtEnd();

    vi.advanceTimersByTime(150);
    expect(search).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(search).toHaveBeenCalledOnce();
  });
});
