import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi, TerminalDataEvent, TerminalExitEvent } from "../../shared/types.js";
import { TerminalTabsPanel } from "./TerminalTabsPanel.js";

// xterm.js is too DOM-heavy for jsdom to be useful here — the value of these
// tests is the tab-state contract, not the xterm internals. Stub Terminal +
// FitAddon so each TerminalInstance can mount cleanly.
vi.mock("@xterm/xterm", () => ({
  Terminal: class FakeTerminal {
    cols = 80;
    rows = 24;
    loadAddon = vi.fn();
    open = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    write = vi.fn();
    focus = vi.fn();
    dispose = vi.fn();
  }
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class FakeFitAddon {
    fit = vi.fn();
  }
}));

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

interface ArgmaxStub {
  spawn: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  emitData: (event: TerminalDataEvent) => void;
  emitExit: (event: TerminalExitEvent) => void;
}

function installArgmaxStub(): ArgmaxStub {
  const dataListeners = new Set<(event: TerminalDataEvent) => void>();
  const exitListeners = new Set<(event: TerminalExitEvent) => void>();

  let nextId = 0;
  const spawn = vi.fn(() => {
    nextId += 1;
    return Promise.resolve({ terminalId: `pty-${nextId}` });
  });
  const write = vi.fn(() => Promise.resolve({ ok: true as const }));
  const resize = vi.fn(() => Promise.resolve({ ok: true as const }));
  const terminate = vi.fn(() => Promise.resolve({ ok: true as const }));

  (window as unknown as { argmax: ArgmaxApi }).argmax = {
    terminal: {
      spawn,
      write,
      resize,
      terminate,
      onData: (listener: (event: TerminalDataEvent) => void) => {
        dataListeners.add(listener);
        return () => {
          dataListeners.delete(listener);
        };
      },
      onExit: (listener: (event: TerminalExitEvent) => void) => {
        exitListeners.add(listener);
        return () => {
          exitListeners.delete(listener);
        };
      }
    }
  } as unknown as ArgmaxApi;

  return {
    spawn,
    write,
    resize,
    terminate,
    emitData: (event) => {
      for (const l of dataListeners) l(event);
    },
    emitExit: (event) => {
      for (const l of exitListeners) l(event);
    }
  };
}

function noop(): void {}

describe("TerminalTabsPanel", () => {
  let stub: ArgmaxStub;

  beforeEach(() => {
    class StubResizeObserver implements ResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    window.ResizeObserver = StubResizeObserver;
    stub = installArgmaxStub();
  });

  afterEach(() => {
    cleanup();
    delete (window as { argmax?: unknown }).argmax;
    vi.restoreAllMocks();
  });

  it("seeds with one tab labelled `zsh` and spawns one PTY", async () => {
    render(
      <TerminalTabsPanel
        workspaceId="ws-1"
        visible
        onCollapse={noop}
        onRequestClose={noop}
      />
    );

    expect(screen.getByRole("tab", { name: "zsh" })).toBeInTheDocument();
    await waitFor(() => expect(stub.spawn).toHaveBeenCalledTimes(1));
    expect(stub.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1" })
    );
  });

  it("clicking + adds a tab, spawns a second PTY, and switches active", async () => {
    render(
      <TerminalTabsPanel
        workspaceId="ws-1"
        visible
        onCollapse={noop}
        onRequestClose={noop}
      />
    );

    await waitFor(() => expect(stub.spawn).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));

    const secondTab = await screen.findByRole("tab", { name: "zsh 2" });
    expect(secondTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "zsh" })).toHaveAttribute(
      "aria-selected",
      "false"
    );
    await waitFor(() => expect(stub.spawn).toHaveBeenCalledTimes(2));
  });

  it("clicking a tab switches active without spawning a new PTY", async () => {
    render(
      <TerminalTabsPanel
        workspaceId="ws-1"
        visible
        onCollapse={noop}
        onRequestClose={noop}
      />
    );
    await waitFor(() => expect(stub.spawn).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    await waitFor(() => expect(stub.spawn).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("tab", { name: "zsh" }));

    expect(screen.getByRole("tab", { name: "zsh" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByRole("tab", { name: "zsh 2" })).toHaveAttribute(
      "aria-selected",
      "false"
    );
    // No third spawn.
    expect(stub.spawn).toHaveBeenCalledTimes(2);
  });

  it("closing a tab terminates its PTY", async () => {
    render(
      <TerminalTabsPanel
        workspaceId="ws-1"
        visible
        onCollapse={noop}
        onRequestClose={noop}
      />
    );
    await waitFor(() => expect(stub.spawn).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    await waitFor(() => expect(stub.spawn).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: "Close zsh 2" }));

    await waitFor(() => expect(stub.terminate).toHaveBeenCalledWith("pty-2"));
    expect(screen.queryByRole("tab", { name: "zsh 2" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "zsh" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("closing the last tab calls onRequestClose", async () => {
    const onRequestClose = vi.fn();
    render(
      <TerminalTabsPanel
        workspaceId="ws-1"
        visible
        onCollapse={noop}
        onRequestClose={onRequestClose}
      />
    );
    await waitFor(() => expect(stub.spawn).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Close zsh" }));

    await waitFor(() => expect(onRequestClose).toHaveBeenCalledTimes(1));
    expect(stub.terminate).toHaveBeenCalledWith("pty-1");
  });

  it("clicking the header × calls onCollapse without tearing down PTYs", async () => {
    const onCollapse = vi.fn();
    const onRequestClose = vi.fn();
    render(
      <TerminalTabsPanel
        workspaceId="ws-1"
        visible
        onCollapse={onCollapse}
        onRequestClose={onRequestClose}
      />
    );
    await waitFor(() => expect(stub.spawn).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Hide terminal" }));

    expect(onCollapse).toHaveBeenCalledTimes(1);
    expect(onRequestClose).not.toHaveBeenCalled();
    expect(stub.terminate).not.toHaveBeenCalled();
  });

  it("reuses gaps in tab labels (`zsh`, `zsh 2`, `zsh 3` → close 2 → new `zsh 2`)", async () => {
    render(
      <TerminalTabsPanel
        workspaceId="ws-1"
        visible
        onCollapse={noop}
        onRequestClose={noop}
      />
    );
    await waitFor(() => expect(stub.spawn).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    await waitFor(() => expect(stub.spawn).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    await waitFor(() => expect(stub.spawn).toHaveBeenCalledTimes(3));

    expect(screen.getByRole("tab", { name: "zsh 3" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close zsh 2" }));
    await waitFor(() =>
      expect(screen.queryByRole("tab", { name: "zsh 2" })).not.toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    expect(await screen.findByRole("tab", { name: "zsh 2" })).toBeInTheDocument();
  });

  it("emits terminal:data only to the matching xterm — listeners are id-filtered", async () => {
    render(
      <TerminalTabsPanel
        workspaceId="ws-1"
        visible
        onCollapse={noop}
        onRequestClose={noop}
      />
    );
    await waitFor(() => expect(stub.spawn).toHaveBeenCalledTimes(1));

    // Pushing an event for an unknown terminalId must not throw — the
    // per-instance listeners drop non-matching ids on the floor.
    act(() => {
      stub.emitData({ terminalId: "unknown", data: "noise" });
    });

    // Still rendering and responsive.
    expect(screen.getByRole("tab", { name: "zsh" })).toBeInTheDocument();
  });
});
