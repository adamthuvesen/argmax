import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DebugPanel } from "./DebugPanel.js";
import type {
  ArgmaxApi,
  BackendLogEntry,
  RawProviderOutput,
  SessionSummary,
  TimelineEvent,
  WorkspaceSummary
} from "../../../shared/types.js";

describe("DebugPanel", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "argmax");
  });

  it("interleaves raw output and events, and expands a row to the verbatim line", () => {
    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } });
    renderPanel({
      events: [timelineEvent("e1", "assistant.message", "2026-09-01T10:00:01.000Z", "ran a command")],
      rawOutputs: [rawOutput("r1", line, "2026-09-01T10:00:00.000Z")]
    });

    const summaries = screen.getAllByRole("button", { expanded: false });
    expect(summaries[0]).toHaveTextContent("assistant · tool_use Bash");
    expect(summaries[1]).toHaveTextContent("ran a command");

    fireEvent.click(summaries[0]);
    expect(screen.getByText(/"name": "Bash"/)).toBeInTheDocument();
  });

  it("narrows the trace to raw output only", () => {
    renderPanel({
      events: [timelineEvent("e1", "assistant.message", "2026-09-01T10:00:01.000Z", "an event")],
      rawOutputs: [rawOutput("r1", "a raw line", "2026-09-01T10:00:00.000Z")]
    });

    fireEvent.click(screen.getByRole("button", { name: "Raw" }));

    expect(screen.getByText("a raw line")).toBeInTheDocument();
    expect(screen.queryByText("an event")).not.toBeInTheDocument();
  });

  it("tails backend logs and advances the seq cursor between polls", async () => {
    const debugSnapshot = vi
      .fn()
      .mockResolvedValueOnce({
        generatedAt: "2026-09-01T10:00:00.000Z",
        ipcStats: [],
        logs: [logEntry(1, "info", "providers.session", "session launched")]
      })
      .mockResolvedValue({
        generatedAt: "2026-09-01T10:00:01.000Z",
        ipcStats: [],
        logs: [logEntry(2, "error", "gh.poller", "refresh failed")]
      });
    stubApi({ debugSnapshot });

    renderPanel({});
    fireEvent.click(screen.getByRole("tab", { name: "Logs" }));

    await waitFor(() => expect(screen.getByText("session launched")).toBeInTheDocument());
    expect(debugSnapshot).toHaveBeenCalledWith({ afterLogSeq: undefined });

    await waitFor(() => expect(screen.getByText("refresh failed")).toBeInTheDocument());
    expect(debugSnapshot).toHaveBeenLastCalledWith({ afterLogSeq: 1 });
    // Both lines are retained: the poll is a delta, not a replacement.
    expect(screen.getByText("session launched")).toBeInTheDocument();
  });

  it("hides log lines below the selected level", async () => {
    stubApi({
      debugSnapshot: vi.fn().mockResolvedValue({
        generatedAt: "2026-09-01T10:00:00.000Z",
        ipcStats: [],
        logs: [logEntry(1, "debug", "db", "chatty"), logEntry(2, "error", "db", "broken")]
      })
    });

    renderPanel({});
    fireEvent.click(screen.getByRole("tab", { name: "Logs" }));
    await waitFor(() => expect(screen.getByText("chatty")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Minimum level"), { target: { value: "warn" } });

    expect(screen.queryByText("chatty")).not.toBeInTheDocument();
    expect(screen.getByText("broken")).toBeInTheDocument();
  });

  it("sorts IPC channels by p99 and flags the slow ones", async () => {
    stubApi({
      debugSnapshot: vi.fn().mockResolvedValue({
        generatedAt: "2026-09-01T10:00:00.000Z",
        ipcStats: [
          { channel: "health:ping", count: 4, totalRecorded: 4, p50: 0.2, p99: 0.4 },
          { channel: "review:load-diff", count: 9, totalRecorded: 9, p50: 40, p99: 320 }
        ],
        logs: []
      })
    });

    renderPanel({});
    fireEvent.click(screen.getByRole("tab", { name: "IPC" }));

    await waitFor(() => expect(screen.getByText("review:load-diff")).toBeInTheDocument());
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("review:load-diff");
    expect(rows[0]).toHaveAttribute("data-health", "bad");
    expect(rows[1]).toHaveAttribute("data-health", "ok");
    // Sub-millisecond calls keep their resolution rather than rounding to 0.0ms.
    expect(rows[1]).toHaveTextContent("400µs");
  });

  it("copies the ids needed to find this session outside the app", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    renderPanel({});
    fireEvent.click(screen.getByRole("button", { name: "Copy session and workspace ids" }));

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain("session   session-1");
    expect(copied).toContain("provider  conv-9");
    expect(copied).toContain("workspace workspace-1");
  });
});

function renderPanel({
  events = [],
  rawOutputs = []
}: {
  events?: TimelineEvent[];
  rawOutputs?: RawProviderOutput[];
}): void {
  render(
    <DebugPanel
      events={events}
      rawOutputs={rawOutputs}
      session={session()}
      workspace={workspace()}
      onClose={vi.fn()}
    />
  );
}

function stubApi(system: Partial<ArgmaxApi["system"]>): void {
  Object.defineProperty(window, "argmax", { configurable: true, value: { system } });
}

function timelineEvent(id: string, type: string, createdAt: string, message: string): TimelineEvent {
  return { id, sessionId: "session-1", type: type as TimelineEvent["type"], message, payload: {}, createdAt };
}

function rawOutput(id: string, content: string, createdAt: string): RawProviderOutput {
  return { id, sessionId: "session-1", stream: "stdout", content, createdAt };
}

function logEntry(seq: number, level: string, scope: string, message: string): BackendLogEntry {
  return { seq, timestamp: "2026-09-01T10:00:00.000Z", level, scope, message, fields: {} };
}

function session(): SessionSummary {
  return {
    id: "session-1",
    workspaceId: "workspace-1",
    provider: "claude",
    modelLabel: "Opus 5",
    modelId: "claude-opus-5",
    permissionMode: "auto-approve",
    providerConversationId: "conv-9",
    prompt: "do the thing",
    state: "running",
    attention: "normal",
    startedAt: "2026-09-01T10:00:00.000Z",
    completedAt: null,
    lastActivityAt: "2026-09-01T10:00:00.000Z"
  };
}

function workspace(): WorkspaceSummary {
  return {
    id: "workspace-1",
    projectId: "project-1",
    taskLabel: "debug panel",
    branch: "adam/debug",
    baseRef: "main",
    path: "/tmp/worktree",
    state: "running",
    sharedWorkspace: false,
    kind: "git",
    dirty: false,
    changedFiles: 0,
    lastActivityAt: "2026-09-01T10:00:00.000Z",
    pinned: false,
    priorityDismissedAt: null,
    priorityAddedAt: null
  };
}
