import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { CommandPalette, type MessageHit, type PaletteCommand } from "./CommandPalette.js";
import type { WorkspaceContentSearchResult } from "../../shared/types.js";

const COMMANDS: PaletteCommand[] = Array.from({ length: 12 }, (_, i) => ({
  id: `cmd-${i}`,
  label: `Command ${i}`,
  group: "Actions",
  run: vi.fn()
}));

describe("CommandPalette", () => {
  let scrollSpy: Mock<Element["scrollIntoView"]>;

  beforeEach(() => {
    // jsdom doesn't implement layout, so scrollIntoView is undefined on
    // HTMLElement.prototype by default. Stub it so we can assert the keyboard
    // nav effect runs against the currently selected row.
    scrollSpy = vi.fn<Element["scrollIntoView"]>();
    Element.prototype.scrollIntoView = scrollSpy;
  });

  afterEach(() => {
    cleanup();
  });

  it("renders nothing when closed", () => {
    render(<CommandPalette open={false} commands={COMMANDS} onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  });

  it("autofocuses the input on open", () => {
    render(<CommandPalette open={true} commands={COMMANDS} onClose={vi.fn()} />);
    expect(screen.getByRole("searchbox", { name: "Command palette query" })).toHaveFocus();
  });

  it("ArrowDown moves selection and keeps the active row in view", () => {
    render(<CommandPalette open={true} commands={COMMANDS} onClose={vi.fn()} />);
    const input = screen.getByRole("searchbox", { name: "Command palette query" });

    // Initial selection is the first row; the scroll effect should already
    // have fired one mount-time scroll on whichever row is selected.
    scrollSpy.mockClear();
    fireEvent.keyDown(input, { key: "ArrowDown" });

    // The effect runs after the selectedIndex state update — assert that the
    // currently-selected DOM element was the scroll target.
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("Command 1");
    expect(scrollSpy).toHaveBeenCalled();
  });

  it("Enter activates the selected command and closes the palette", () => {
    const onClose = vi.fn();
    const run = vi.fn();
    const single: PaletteCommand[] = [
      { id: "only", label: "Only", group: "Actions", run }
    ];
    render(<CommandPalette open={true} commands={single} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "Command palette query" }), {
      key: "Enter"
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape closes the palette", () => {
    const onClose = vi.fn();
    render(<CommandPalette open={true} commands={COMMANDS} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "Command palette query" }), {
      key: "Escape"
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ranks files beyond the first 200 paths before capping visible rows", async () => {
    const onClose = vi.fn();
    const onFilePick = vi.fn();
    const loadFiles = vi.fn().mockResolvedValue([
      ...Array.from({ length: 250 }, (_, i) => `src/generated/file-${i}.ts`),
      "src/renderer/NeedlePanel.tsx"
    ]);

    render(
      <CommandPalette
        open={true}
        commands={COMMANDS}
        onClose={onClose}
        fileSource={{ kind: "workspace", id: "workspace-1" }}
        loadFiles={loadFiles}
        onFilePick={onFilePick}
      />
    );

    const input = screen.getByRole("searchbox", { name: "Command palette query" });
    fireEvent.change(input, { target: { value: "needle" } });

    expect(await screen.findByText("NeedlePanel.tsx")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onFilePick).toHaveBeenCalledWith("src/renderer/NeedlePanel.tsx");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("opens on the All filter by default and on Files when asked", () => {
    const { unmount } = render(
      <CommandPalette open={true} commands={COMMANDS} onClose={vi.fn()} />
    );
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("All");
    expect(screen.getByRole("searchbox", { name: "Command palette query" })).toHaveAttribute(
      "placeholder",
      "Search agents, files, actions…"
    );
    unmount();

    render(
      <CommandPalette open={true} commands={COMMANDS} onClose={vi.fn()} initialScope="files" />
    );
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Files");
    expect(screen.getByRole("searchbox", { name: "Command palette query" })).toHaveAttribute(
      "placeholder",
      "Search files…"
    );
  });

  it("exposes one tab per search chord and scopes results to the picked one", () => {
    const mixed: PaletteCommand[] = [
      { id: "act", label: "New Session", group: "Actions", run: vi.fn() },
      { id: "sess", label: "Refactor watcher", group: "Sessions", run: vi.fn() }
    ];
    render(<CommandPalette open={true} commands={mixed} onClose={vi.fn()} />);

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "All",
      "Agents",
      "Files",
      "Messages",
      "Contents",
      "Actions",
      "Settings"
    ]);
    expect(screen.getByText("New Session")).toBeInTheDocument();
    expect(screen.getByText("Refactor watcher")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Agents" }));
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Agents");
    expect(screen.getByText("Refactor watcher")).toBeInTheDocument();
    expect(screen.queryByText("New Session")).toBeNull();
  });

  it("Tab and Shift+Tab move between filters without leaving the input", () => {
    render(<CommandPalette open={true} commands={COMMANDS} onClose={vi.fn()} />);
    const input = screen.getByRole("searchbox", { name: "Command palette query" });

    fireEvent.keyDown(input, { key: "Tab" });
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Agents");
    expect(input).toHaveFocus();

    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("All");
  });

  it("lists workspace files with no query once the Files filter is active", async () => {
    const onFilePick = vi.fn();
    const loadFiles = vi.fn().mockResolvedValue(["src/renderer/App.tsx", "docs/ipc.md"]);
    render(
      <CommandPalette
        open={true}
        commands={COMMANDS}
        onClose={vi.fn()}
        initialScope="files"
        fileSource={{ kind: "workspace", id: "workspace-1" }}
        loadFiles={loadFiles}
        onFilePick={onFilePick}
      />
    );

    expect(await screen.findByText("App.tsx")).toBeInTheDocument();
    expect(screen.getByText("Recent Files")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "Command palette query" }), {
      key: "Enter"
    });
    expect(onFilePick).toHaveBeenCalledWith("src/renderer/App.tsx");
  });

  it("Enter runs a command on the Actions filter and a file on the Files filter", async () => {
    const run = vi.fn();
    const onFilePick = vi.fn();
    const loadFiles = vi.fn().mockResolvedValue(["src/renderer/Needle.tsx"]);
    render(
      <CommandPalette
        open={true}
        commands={[{ id: "act", label: "Needle Action", group: "Actions", run }]}
        onClose={vi.fn()}
        fileSource={{ kind: "workspace", id: "workspace-1" }}
        loadFiles={loadFiles}
        onFilePick={onFilePick}
      />
    );
    const input = screen.getByRole("searchbox", { name: "Command palette query" });

    fireEvent.click(screen.getByRole("tab", { name: "Actions" }));
    fireEvent.change(input, { target: { value: "needle" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(onFilePick).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    expect(await screen.findByText("Needle.tsx")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onFilePick).toHaveBeenCalledWith("src/renderer/Needle.tsx");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("keeps a row on one line: title plus trailing meta, and matches on the meta", () => {
    const run = vi.fn();
    render(
      <CommandPalette
        open={true}
        commands={[
          { id: "sess", label: "Refactor watcher", meta: "argmax", group: "Sessions", run }
        ]}
        onClose={vi.fn()}
      />
    );

    const row = screen.getByRole("option", { name: /Refactor watcher/ });
    expect(row).toHaveTextContent("Refactor watcher");
    expect(row).toHaveTextContent("argmax");

    const input = screen.getByRole("searchbox", { name: "Command palette query" });
    fireEvent.change(input, { target: { value: "argmax" } });
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("Refactor watcher");
  });

  it("drops stale message-search results after the query becomes too short", async () => {
    let resolveSearch!: (hits: MessageHit[]) => void;
    const searchMessages = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSearch = resolve;
        })
    );
    render(
      <CommandPalette
        open={true}
        commands={COMMANDS}
        onClose={vi.fn()}
        searchMessages={searchMessages}
      />
    );

    const input = screen.getByRole("searchbox", { name: "Command palette query" });
    fireEvent.change(input, { target: { value: "needle" } });
    await waitFor(() => expect(searchMessages).toHaveBeenCalledWith("needle", 8));

    fireEvent.change(input, { target: { value: "n" } });
    resolveSearch([
      {
        id: "session-1:event-1",
        sessionId: "session-1",
        label: "Stale message",
        snippetSegments: [{ text: "needle", matched: true }],
        run: vi.fn()
      }
    ]);

    await waitFor(() => expect(screen.queryByText("Stale message")).toBeNull());
  });

  it("searches messages even while the searchMessages prop keeps changing identity", async () => {
    // Upstream `searchMessages` is rebuilt on every `dashboard:delta`, so while
    // an agent streams the prop churns faster than the 150ms debounce. The
    // effect must not restart its timer for that.
    const backend = vi
      .fn<(query: string, limit: number) => Promise<MessageHit[]>>()
      .mockResolvedValue([]);
    const paletteWith = (search: (query: string, limit: number) => Promise<MessageHit[]>) => (
      <CommandPalette
        open={true}
        commands={COMMANDS}
        onClose={vi.fn()}
        searchMessages={search}
      />
    );
    const { rerender } = render(paletteWith((query, limit) => backend(query, limit)));

    const input = screen.getByRole("searchbox", { name: "Command palette query" });
    fireEvent.change(input, { target: { value: "needle" } });

    // 8 * 40ms of churn is well past the 150ms debounce, so the backend must
    // already have run by the time the churn stops — waiting for it to settle
    // first would hide the bug.
    // Real waits, but inside `act`: the debounce fires mid-loop and the
    // backend's resolution sets state, which React otherwise reports as an
    // update outside the test.
    for (let tick = 0; tick < 8; tick += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
      });
      rerender(paletteWith((query, limit) => backend(query, limit)));
    }
    await act(async () => {});

    expect(backend).toHaveBeenCalledWith("needle", 8);
  });

  describe("Contents filter", () => {
    const CONTENT_RESULT: WorkspaceContentSearchResult = {
      files: [
        { path: "src-tauri/src/index.ts", matches: [{ line: 3, preview: "var abc = 1;" }] },
        {
          path: "src/renderer/App.tsx",
          matches: [
            { line: 12, preview: "const abc = 'two';" },
            { line: 33, preview: "abc.toUpperCase();" }
          ]
        }
      ],
      truncated: false
    };

    it("greps after a debounce and renders each file with its matching lines", async () => {
      const searchContents = vi.fn().mockResolvedValue(CONTENT_RESULT);
      render(
        <CommandPalette
          open={true}
          commands={COMMANDS}
          onClose={vi.fn()}
          initialScope="contents"
          fileSource={{ kind: "workspace", id: "workspace-1" }}
          onFilePick={vi.fn()}
          searchContents={searchContents}
        />
      );

      const input = screen.getByRole("searchbox", { name: "Command palette query" });
      fireEvent.change(input, { target: { value: "var abc" } });

      await waitFor(() => expect(searchContents).toHaveBeenCalledWith("var abc"));
      expect(await screen.findByText("index.ts")).toBeInTheDocument();
      expect(screen.getByText("var abc = 1;")).toBeInTheDocument();
      expect(screen.getByText("App.tsx")).toBeInTheDocument();
      expect(screen.getByText("abc.toUpperCase();")).toBeInTheDocument();
    });

    it("opens the file behind a match row", async () => {
      const onFilePick = vi.fn();
      const onClose = vi.fn();
      render(
        <CommandPalette
          open={true}
          commands={COMMANDS}
          onClose={onClose}
          initialScope="contents"
          fileSource={{ kind: "workspace", id: "workspace-1" }}
          onFilePick={onFilePick}
          searchContents={vi.fn().mockResolvedValue(CONTENT_RESULT)}
        />
      );

      fireEvent.change(screen.getByRole("searchbox", { name: "Command palette query" }), {
        target: { value: "var abc" }
      });

      fireEvent.mouseDown(await screen.findByText("abc.toUpperCase();"));
      expect(onFilePick).toHaveBeenCalledWith("src/renderer/App.tsx");
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("drops stale grep results once the query falls below two characters", async () => {
      let resolveSearch!: (result: WorkspaceContentSearchResult) => void;
      const searchContents = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSearch = resolve;
          })
      );
      render(
        <CommandPalette
          open={true}
          commands={COMMANDS}
          onClose={vi.fn()}
          initialScope="contents"
          fileSource={{ kind: "workspace", id: "workspace-1" }}
          onFilePick={vi.fn()}
          searchContents={searchContents}
        />
      );

      const input = screen.getByRole("searchbox", { name: "Command palette query" });
      fireEvent.change(input, { target: { value: "abc" } });
      await waitFor(() => expect(searchContents).toHaveBeenCalled());

      fireEvent.change(input, { target: { value: "a" } });
      resolveSearch(CONTENT_RESULT);

      await waitFor(() => expect(screen.queryByText("index.ts")).toBeNull());
    });

    it("asks for a project when no file source is registered", () => {
      const searchContents = vi.fn();
      render(
        <CommandPalette
          open={true}
          commands={COMMANDS}
          onClose={vi.fn()}
          initialScope="contents"
          fileSource={null}
          searchContents={searchContents}
        />
      );
      expect(screen.getByText(/open a session or project/i)).toBeInTheDocument();
    });
  });
});
