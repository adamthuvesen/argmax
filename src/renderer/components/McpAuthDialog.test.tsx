import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpAuthDialog } from "./McpAuthDialog.js";
import type { ArgmaxApi, McpAuthDataEvent, McpAuthExitEvent } from "../../shared/types.js";

// xterm.js does enough DOM work that we'd rather assert on the dialog's own
// contract than against the inner xterm internals. Stub it: Terminal and
// FitAddon become inert objects so the component mounts cleanly in jsdom.
vi.mock("@xterm/xterm", () => {
  return {
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
  };
});

vi.mock("@xterm/addon-fit", () => {
  return {
    FitAddon: class FakeFitAddon {
      fit = vi.fn();
    }
  };
});

// xterm css import has no runtime side-effect; jsdom ignores style imports.
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

function installArgmaxStub(overrides: Partial<ArgmaxApi["mcp"]["auth"]> = {}) {
  let dataListener: ((event: McpAuthDataEvent) => void) | null = null;
  let exitListener: ((event: McpAuthExitEvent) => void) | null = null;

  const start = overrides.start ?? vi.fn().mockResolvedValue({ sessionId: "auth-1" });
  const terminate = overrides.terminate ?? vi.fn().mockResolvedValue({ ok: true });
  const write = overrides.write ?? vi.fn().mockResolvedValue({ ok: true });
  const resize = overrides.resize ?? vi.fn().mockResolvedValue({ ok: true });

  (window as unknown as { argmax: ArgmaxApi }).argmax = {
    mcp: {
      list: vi.fn().mockResolvedValue([]),
      auth: {
        start,
        write,
        resize,
        terminate,
        onData: (listener: (event: McpAuthDataEvent) => void) => {
          dataListener = listener;
          return () => {
            dataListener = null;
          };
        },
        onExit: (listener: (event: McpAuthExitEvent) => void) => {
          exitListener = listener;
          return () => {
            exitListener = null;
          };
        }
      }
    }
  } as unknown as ArgmaxApi;

  return {
    start,
    terminate,
    write,
    resize,
    emitData: (event: McpAuthDataEvent) => dataListener?.(event),
    emitExit: (event: McpAuthExitEvent) => exitListener?.(event)
  };
}

describe("McpAuthDialog", () => {
  beforeEach(() => {
    // ResizeObserver is not implemented in jsdom; stub a noop so the
    // component's `new ResizeObserver(...)` call doesn't throw on mount.
    class StubResizeObserver implements ResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    window.ResizeObserver = StubResizeObserver;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("returns null while closed and renders no dialog", () => {
    installArgmaxStub();
    const { container } = render(<McpAuthDialog open={false} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("opens the dialog and calls mcp.auth.start on mount", async () => {
    const stub = installArgmaxStub();
    render(<McpAuthDialog open={true} onClose={() => {}} />);

    expect(screen.getByRole("dialog", { name: /authenticate mcp/i })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /mcp auth terminal/i })).toBeInTheDocument();

    await waitFor(() => {
      expect(stub.start).toHaveBeenCalledWith(expect.objectContaining({ cols: 80, rows: 24 }));
    });
  });

  it("fires onCompleted and terminates the PTY when the user closes the dialog", async () => {
    const stub = installArgmaxStub();
    const onClose = vi.fn();
    const onCompleted = vi.fn();
    render(<McpAuthDialog open={true} onClose={onClose} onCompleted={onCompleted} />);

    await waitFor(() => expect(stub.start).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: /close authenticate dialog/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("fires onCompleted when the underlying PTY exits", async () => {
    const stub = installArgmaxStub();
    const onCompleted = vi.fn();
    render(<McpAuthDialog open={true} onClose={() => {}} onCompleted={onCompleted} />);

    await waitFor(() => expect(stub.start).toHaveBeenCalled());

    stub.emitExit({ sessionId: "auth-1", exitCode: 0, signal: null });
    await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
  });

  it("closes on Escape via the document-level keydown handler", async () => {
    const stub = installArgmaxStub();
    const onClose = vi.fn();
    render(<McpAuthDialog open={true} onClose={onClose} />);
    await waitFor(() => expect(stub.start).toHaveBeenCalled());

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("restores focus to the previously focused element on close", async () => {
    const stub = installArgmaxStub();
    const trigger = document.createElement("button");
    trigger.textContent = "Open auth dialog";
    document.body.appendChild(trigger);
    trigger.focus();
    try {
      const { rerender } = render(<McpAuthDialog open={true} onClose={() => {}} />);
      await waitFor(() => expect(stub.start).toHaveBeenCalled());
      rerender(<McpAuthDialog open={false} onClose={() => {}} />);
      expect(trigger).toHaveFocus();
    } finally {
      document.body.removeChild(trigger);
    }
  });

  it("surfaces a clear error when claude is not installed", async () => {
    const stub = installArgmaxStub({
      start: vi.fn().mockRejectedValue(new Error("Claude Code is not installed on this machine."))
    });
    render(<McpAuthDialog open={true} onClose={() => {}} />);

    await waitFor(() => expect(stub.start).toHaveBeenCalled());
    expect(await screen.findByRole("alert")).toHaveTextContent(/Claude Code is not installed/);
  });
});
