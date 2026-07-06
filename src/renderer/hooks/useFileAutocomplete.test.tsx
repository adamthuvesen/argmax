import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState, type JSX } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi, WorkspaceFileEntry } from "../../shared/types.js";
import {
  buildEntries,
  parseFileQuery,
  useFileAutocomplete,
  type FileAutocompleteSource
} from "./useFileAutocomplete.js";

function Harness({
  initialInput = "",
  source = { kind: "workspace", id: "workspace-1" } satisfies FileAutocompleteSource
}: {
  initialInput?: string;
  source?: FileAutocompleteSource | null;
}): JSX.Element {
  const [input, setInput] = useState(initialInput);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const state = useFileAutocomplete({ input, setInput, inputRef, source });
  return (
    <div>
      <textarea
        aria-label="probe"
        ref={inputRef}
        value={input}
        onChange={(e) => {
          setInput(e.target.value);
          state.onSelectionChange(e);
        }}
        onKeyDown={state.onKeyDown}
        onSelect={state.onSelectionChange}
        onClick={state.onSelectionChange}
      />
      <span data-testid="popover-open">{state.popoverOpen ? "yes" : "no"}</span>
      <span data-testid="filtered-count">{state.filteredEntries.length}</span>
      <span data-testid="selection-index">{state.selectionIndex}</span>
      <ul>
        {state.filteredEntries.map((entry) => (
          <li key={`${entry.kind}:${entry.path}`} data-testid={`entry-${entry.kind}`}>
            {entry.path}
          </li>
        ))}
      </ul>
    </div>
  );
}

function setCaret(node: HTMLTextAreaElement, position: number): void {
  node.setSelectionRange(position, position);
  fireEvent.select(node);
}

describe("parseFileQuery", () => {
  it("matches an @ at start of input", () => {
    expect(parseFileQuery("@src", 4)).toEqual({ triggerStart: 0, query: "src" });
  });

  it("matches an @ preceded by whitespace", () => {
    expect(parseFileQuery("hello @src", 10)).toEqual({ triggerStart: 6, query: "src" });
  });

  it("matches an @ preceded by a newline", () => {
    expect(parseFileQuery("first line\n@src", 15)).toEqual({ triggerStart: 11, query: "src" });
  });

  it("returns null when @ is mid-word (email shape)", () => {
    expect(parseFileQuery("foo@bar.com", 11)).toBeNull();
  });

  it("returns null when caret has moved past whitespace after the @", () => {
    expect(parseFileQuery("@foo bar", 8)).toBeNull();
  });

  it("returns an empty query when caret is immediately after @", () => {
    expect(parseFileQuery("hello @", 7)).toEqual({ triggerStart: 6, query: "" });
  });

  it("returns null when there is no @ before the caret", () => {
    expect(parseFileQuery("plain text", 5)).toBeNull();
  });
});

describe("buildEntries", () => {
  it("derives folder prefixes from file paths", () => {
    const entries = buildEntries(["src-tauri/main.ts", "src/renderer/App.tsx", "package.json"]);
    const dirs = entries.filter((e) => e.kind === "dir").map((e) => e.path);
    const files = entries.filter((e) => e.kind === "file").map((e) => e.path);
    expect(files).toEqual(["src-tauri/main.ts", "src/renderer/App.tsx", "package.json"]);
    expect(dirs).toEqual(["src", "src-tauri", "src/renderer"]);
  });

  it("returns no folders for top-level files only", () => {
    const entries = buildEntries(["README.md", "package.json"]);
    expect(entries.filter((e) => e.kind === "dir")).toEqual([]);
  });

  it("dedupes shared folder prefixes", () => {
    const entries = buildEntries(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(entries.filter((e) => e.kind === "dir")).toEqual([{ path: "src", kind: "dir" }]);
  });
});

describe("useFileAutocomplete", () => {
  let listFiles: ReturnType<typeof vi.fn<ArgmaxApi["workspace"]["listFiles"]>>;
  let listFilesForProject: ReturnType<typeof vi.fn<ArgmaxApi["workspace"]["listFilesForProject"]>>;

  beforeEach(() => {
    listFiles = vi.fn<ArgmaxApi["workspace"]["listFiles"]>();
    listFilesForProject = vi.fn<ArgmaxApi["workspace"]["listFilesForProject"]>();
    Object.defineProperty(window, "argmax", {
      configurable: true,
      writable: true,
      value: {
        workspace: { listFiles, listFilesForProject }
      }
    });
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { argmax?: unknown }).argmax;
  });

  it("does not apply listFiles after unmount", async () => {
    let resolveList!: (entries: WorkspaceFileEntry[]) => void;
    listFiles.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveList = resolve;
        })
    );

    const { unmount } = render(<Harness initialInput="@" />);
    const probe = screen.getByLabelText<HTMLTextAreaElement>("probe");
    act(() => {
      setCaret(probe, 1);
    });
    await waitFor(() => expect(listFiles).toHaveBeenCalledTimes(1));
    unmount();

    act(() => {
      resolveList([{ path: "stale-after-unmount.ts" }]);
    });

    listFiles.mockResolvedValue([{ path: "fresh.ts" }]);
    render(<Harness initialInput="@" />);
    const probe2 = screen.getByLabelText<HTMLTextAreaElement>("probe");
    act(() => {
      setCaret(probe2, 1);
    });
    await waitFor(() => expect(listFiles).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryAllByTestId("entry-file").map((node) => node.textContent)).toEqual(["fresh.ts"])
    );
  });

  it("opens the popover with files and derived folders when the user types `@`", async () => {
    const entries: WorkspaceFileEntry[] = [
      { path: "src-tauri/main.ts" },
      { path: "src/renderer/App.tsx" }
    ];
    listFiles.mockResolvedValue(entries);

    render(<Harness initialInput="@" />);

    const probe = screen.getByLabelText<HTMLTextAreaElement>("probe");
    act(() => {
      setCaret(probe, 1);
    });

    await waitFor(() => expect(listFiles).toHaveBeenCalledWith("workspace-1"));
    await waitFor(() => expect(screen.getByTestId("popover-open").textContent).toBe("yes"));
    // 2 files + 3 derived folders (src, src-tauri, src/renderer)
    expect(screen.getByTestId("filtered-count").textContent).toBe("5");
    expect(screen.queryAllByTestId("entry-file")).toHaveLength(2);
    expect(screen.queryAllByTestId("entry-dir")).toHaveLength(3);
  });

  it("shows project-scoped files after the bridge resolves", async () => {
    listFilesForProject.mockResolvedValue([{ path: "packages/shared/index.ts" }]);

    render(<Harness initialInput="@" source={{ kind: "project", id: "project-1" }} />);

    const probe = screen.getByLabelText<HTMLTextAreaElement>("probe");
    act(() => {
      setCaret(probe, 1);
    });

    await waitFor(() => expect(listFilesForProject).toHaveBeenCalledWith("project-1"));
    await waitFor(() => expect(screen.getByTestId("popover-open").textContent).toBe("yes"));
    expect(screen.getByText("packages/shared/index.ts")).toBeTruthy();
    expect(listFiles).not.toHaveBeenCalled();
  });

  it("matches short prefixes that are not at a non-alphanumeric boundary (regression)", async () => {
    // Previously the file-path uFuzzy config used `interRgt: 1`, which required
    // the matched prefix to end at a non-alphanumeric boundary. That rejected
    // "AG" against "AGENTS.md" (next char is "E"), producing a "No matches"
    // state for every short prefix.
    listFiles.mockResolvedValue([
      { path: "AGENTS.md" },
      { path: "src/renderer/lib/agentMode.ts" },
      { path: "package.json" }
    ]);

    render(<Harness initialInput="@AG" />);

    const probe = screen.getByLabelText<HTMLTextAreaElement>("probe");
    act(() => {
      setCaret(probe, 3);
    });

    await waitFor(() => expect(listFiles).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      const filePaths = screen.queryAllByTestId("entry-file").map((node) => node.textContent);
      expect(filePaths).toContain("AGENTS.md");
      expect(filePaths).toContain("src/renderer/lib/agentMode.ts");
      expect(filePaths).not.toContain("package.json");
    });
  });

  it("filters entries by the query after `@`", async () => {
    listFiles.mockResolvedValue([
      { path: "src-tauri/src/main.ts" },
      { path: "src/renderer/App.tsx" },
      { path: "package.json" }
    ]);

    render(<Harness initialInput="@main" />);

    const probe = screen.getByLabelText<HTMLTextAreaElement>("probe");
    act(() => {
      setCaret(probe, 5);
    });

    await waitFor(() => expect(listFiles).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      const filePaths = screen.queryAllByTestId("entry-file").map((node) => node.textContent);
      expect(filePaths).toContain("src-tauri/src/main.ts");
      expect(filePaths).not.toContain("package.json");
    });
  });

  it("inserts `@path ` (file, with trailing space) when Enter is pressed", async () => {
    listFiles.mockResolvedValue([{ path: "src-tauri/src/main.ts" }, { path: "src/renderer/App.tsx" }]);

    render(<Harness initialInput="hello @main.ts" />);

    const probe = screen.getByLabelText<HTMLTextAreaElement>("probe");
    act(() => {
      setCaret(probe, 14);
    });

    await waitFor(() => expect(listFiles).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("popover-open").textContent).toBe("yes"));

    act(() => {
      fireEvent.keyDown(probe, { key: "Enter" });
    });

    expect(probe.value).toBe("hello @src-tauri/src/main.ts ");
  });

  it("inserts a folder with trailing slash + space when Enter is pressed", async () => {
    listFiles.mockResolvedValue([
      { path: "src-tauri/main.ts" },
      { path: "src-tauri/ipc.ts" },
      { path: "package.json" }
    ]);

    render(<Harness initialInput="poke @src-tauri" />);

    const probe = screen.getByLabelText<HTMLTextAreaElement>("probe");
    act(() => {
      setCaret(probe, 15);
    });

    await waitFor(() => expect(listFiles).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("popover-open").textContent).toBe("yes"));

    // Advance selection to the dir entry (top hit may be a file). Loop until
    // the highlighted entry is the dir match.
    const indexOfDir = (): number => {
      const items = screen.queryAllByTestId(/^entry-/);
      return items.findIndex(
        (node) =>
          node.getAttribute("data-testid") === "entry-dir" && node.textContent === "src-tauri"
      );
    };
    let target = indexOfDir();
    expect(target).toBeGreaterThanOrEqual(0);
    while (Number(screen.getByTestId("selection-index").textContent) !== target) {
      act(() => {
        fireEvent.keyDown(probe, { key: "ArrowDown" });
      });
      target = indexOfDir();
    }

    act(() => {
      fireEvent.keyDown(probe, { key: "Enter" });
    });

    expect(probe.value).toBe("poke @src-tauri/ ");
  });

  it("does not open for `foo@bar.com` (email shape)", async () => {
    listFiles.mockResolvedValue([{ path: "src-tauri/main.ts" }]);

    render(<Harness initialInput="foo@bar.com" />);

    const probe = screen.getByLabelText<HTMLTextAreaElement>("probe");
    act(() => {
      setCaret(probe, 11);
    });

    // Give effects a chance — popover should remain closed and no IPC fired.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.getByTestId("popover-open").textContent).toBe("no");
    expect(listFiles).not.toHaveBeenCalled();
  });

  it("closes on Escape and stays closed while typing in the same token", async () => {
    listFiles.mockResolvedValue([{ path: "src-tauri/src/main.ts" }, { path: "src/renderer/App.tsx" }]);

    render(<Harness initialInput="@" />);

    const probe = screen.getByLabelText<HTMLTextAreaElement>("probe");
    act(() => {
      setCaret(probe, 1);
    });
    await waitFor(() => expect(screen.getByTestId("popover-open").textContent).toBe("yes"));

    act(() => {
      fireEvent.keyDown(probe, { key: "Escape" });
    });
    expect(screen.getByTestId("popover-open").textContent).toBe("no");

    // Keep typing in the same `@` token — popover should remain dismissed.
    fireEvent.change(probe, { target: { value: "@s" } });
    act(() => {
      setCaret(probe, 2);
    });
    expect(screen.getByTestId("popover-open").textContent).toBe("no");
  });

  it("uses listFilesForProject when source.kind is `project`", async () => {
    listFilesForProject.mockResolvedValue([{ path: "README.md" }]);

    render(<Harness initialInput="@" source={{ kind: "project", id: "project-7" }} />);

    const probe = screen.getByLabelText<HTMLTextAreaElement>("probe");
    act(() => {
      setCaret(probe, 1);
    });

    await waitFor(() => expect(listFilesForProject).toHaveBeenCalledWith("project-7"));
    expect(listFiles).not.toHaveBeenCalled();
  });
});
