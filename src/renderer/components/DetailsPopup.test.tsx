import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DetailsPopup } from "./DetailsPopup.js";
import { baseSession, event, workspace } from "../../test/sessionConversationTestHarness.js";
import type { ArgmaxApi, TimelineEvent } from "../../shared/types.js";

const popupWorkspace = {
  ...workspace,
  kind: "popup" as const,
  sharedWorkspace: true
};

const EVENTS: TimelineEvent[] = [
  // Newest first, matching mergeDashboardDelta's descending order.
  event("m4", "user.message", "Follow-up: what about clock skew?", "2026-05-12T15:00:03.000Z"),
  {
    ...event("m3", "message.completed", "Unrelated pane message.", "2026-05-12T15:00:02.000Z"),
    sessionId: "session-other"
  },
  event("m2", "message.completed", "A vector clock orders events without a shared clock.", "2026-05-12T15:00:01.000Z"),
  event("m1", "user.message", "Explain this excerpt in more detail: vector clocks", "2026-05-12T15:00:00.000Z")
];

const MINIMAL_TOOL_EVENTS: TimelineEvent[] = [
  event("answer", "message.completed", "The file tabs are ready.", "2026-05-12T15:00:13.000Z"),
  event("run-4-b-done", "command.completed", "tool_result", "2026-05-12T15:00:12.000Z", {
    tool_use_id: "run-4-b",
    content: "ok"
  }),
  event("run-4-b-start", "command.started", "Bash", "2026-05-12T15:00:11.000Z", {
    id: "run-4-b",
    name: "Bash",
    input: { command: "echo four-b" }
  }),
  event("run-4-a-done", "command.completed", "tool_result", "2026-05-12T15:00:10.000Z", {
    tool_use_id: "run-4-a",
    content: "ok"
  }),
  event("run-4-a-start", "command.started", "Bash", "2026-05-12T15:00:09.000Z", {
    id: "run-4-a",
    name: "Bash",
    input: { command: "echo four-a" }
  }),
  event("narration-4", "message.completed", "Checking the final state.", "2026-05-12T15:00:08.000Z"),
  event("run-3-b-done", "command.completed", "tool_result", "2026-05-12T15:00:07.000Z", {
    tool_use_id: "run-3-b",
    content: "ok"
  }),
  event("run-3-b-start", "command.started", "Bash", "2026-05-12T15:00:06.000Z", {
    id: "run-3-b",
    name: "Bash",
    input: { command: "echo three-b" }
  }),
  event("run-3-a-done", "command.completed", "tool_result", "2026-05-12T15:00:05.000Z", {
    tool_use_id: "run-3-a",
    content: "ok"
  }),
  event("run-3-a-start", "command.started", "Bash", "2026-05-12T15:00:04.000Z", {
    id: "run-3-a",
    name: "Bash",
    input: { command: "echo three-a" }
  }),
  event("narration-3", "message.completed", "Checking the third pass.", "2026-05-12T15:00:03.000Z"),
  event("run-2-b-done", "command.completed", "tool_result", "2026-05-12T15:00:02.000Z", {
    tool_use_id: "run-2-b",
    content: "ok"
  }),
  event("run-2-b-start", "command.started", "Bash", "2026-05-12T15:00:01.900Z", {
    id: "run-2-b",
    name: "Bash",
    input: { command: "echo two-b" }
  }),
  event("run-2-a-done", "command.completed", "tool_result", "2026-05-12T15:00:01.800Z", {
    tool_use_id: "run-2-a",
    content: "ok"
  }),
  event("run-2-a-start", "command.started", "Bash", "2026-05-12T15:00:01.700Z", {
    id: "run-2-a",
    name: "Bash",
    input: { command: "echo two-a" }
  }),
  event("narration-2", "message.completed", "Checking the second pass.", "2026-05-12T15:00:01.600Z"),
  event("run-1-b-done", "command.completed", "tool_result", "2026-05-12T15:00:01.500Z", {
    tool_use_id: "run-1-b",
    content: "ok"
  }),
  event("run-1-b-start", "command.started", "Bash", "2026-05-12T15:00:01.400Z", {
    id: "run-1-b",
    name: "Bash",
    input: { command: "echo one-b" }
  }),
  event("run-1-a-done", "command.completed", "tool_result", "2026-05-12T15:00:01.300Z", {
    tool_use_id: "run-1-a",
    content: "ok"
  }),
  event("run-1-a-start", "command.started", "Bash", "2026-05-12T15:00:01.200Z", {
    id: "run-1-a",
    name: "Bash",
    input: { command: "echo one-a" }
  }),
  event("narration-1", "message.completed", "Checking the first pass.", "2026-05-12T15:00:01.100Z"),
  event("seed", "user.message", "Add file tabs.", "2026-05-12T15:00:01.000Z")
];

// The popup's own prop types, not `ReturnType<typeof vi.fn>`: Vitest 4 types
// a bare `vi.fn()` as `Mock<Procedure | Constructable>`, which no longer
// widens to a call signature, so a loose override type poisons the prop.
type DetailsPopupProps = Parameters<typeof DetailsPopup>[0];

function renderPopup(overrides: {
  defaultToolCallsDisplay?: DetailsPopupProps["defaultToolCallsDisplay"];
  defaultToolCallGroupsExpanded?: DetailsPopupProps["defaultToolCallGroupsExpanded"];
  thinkingDisplay?: DetailsPopupProps["thinkingDisplay"];
  chatFontSize?: DetailsPopupProps["chatFontSize"];
  events?: DetailsPopupProps["events"];
  approvals?: DetailsPopupProps["approvals"];
  onResolveApproval?: DetailsPopupProps["onResolveApproval"];
  onClose?: DetailsPopupProps["onClose"];
  onLoadSessionEvents?: DetailsPopupProps["onLoadSessionEvents"];
} = {}) {
  return render(
    <DetailsPopup
      approvals={overrides.approvals}
      onResolveApproval={overrides.onResolveApproval}
      defaultToolCallsDisplay={overrides.defaultToolCallsDisplay}
      defaultToolCallGroupsExpanded={overrides.defaultToolCallGroupsExpanded}
      thinkingDisplay={overrides.thinkingDisplay}
      chatFontSize={overrides.chatFontSize}
      events={overrides.events ?? EVENTS}
      onCancelQueuedMessage={vi.fn().mockResolvedValue(undefined)}
      onClose={overrides.onClose ?? vi.fn(() => {})}
      onLoadSessionEvents={overrides.onLoadSessionEvents ?? vi.fn(() => Promise.resolve())}
      onSendQueuedMessageNow={vi.fn().mockResolvedValue(undefined)}
      onSendSessionInput={vi.fn().mockResolvedValue(undefined)}
      onTerminateSession={vi.fn().mockResolvedValue(undefined)}
      onClearSession={vi.fn().mockResolvedValue(undefined)}
      project={null}
      rawOutputs={[]}
      session={baseSession()}
      workspace={popupWorkspace}
    />
  );
}

describe("DetailsPopup", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.argmax = {
      prs: { listForSession: vi.fn(() => new Promise(() => {})) }
    } as unknown as ArgmaxApi;
  });

  afterEach(() => {
    cleanup();
  });

  it("renders its own session's transcript under the More details heading", () => {
    renderPopup();

    expect(screen.getByRole("dialog", { name: "More details" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "More details" })).toBeInTheDocument();
    expect(
      screen.getByText("A vector clock orders events without a shared clock.")
    ).toBeInTheDocument();
    expect(screen.queryByText("Unrelated pane message.")).toBeNull();
    // Floating composer: no attach or workspace-context cluster — the popup
    // is too narrow for them at its minimum width.
    expect(screen.queryByRole("button", { name: "Attach file" })).toBeNull();
  });

  it("keeps the floating composer on the agent-window font scale", () => {
    renderPopup({ chatFontSize: 10 });

    expect(screen.getByRole("dialog", { name: "More details" }))
      .toHaveAttribute("data-font-size", "10");
    expect(screen.getByRole("textbox", { name: "Chat prompt" }).closest("form"))
      .toHaveAttribute("data-font-size", "10");
  });

  it("forwards Minimal verbosity so successful tool groups stay behind Worked", () => {
    renderPopup({
      events: MINIMAL_TOOL_EVENTS,
      defaultToolCallsDisplay: "single-line",
      defaultToolCallGroupsExpanded: false,
      thinkingDisplay: "collapsed"
    });

    expect(screen.getByText("The file tabs are ready.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Worked/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Ran \d+ commands$/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^Worked/ }));
    expect(screen.getAllByRole("button", { name: /^Ran \d+ commands$/ })).toHaveLength(4);
  });

  it("hides the seed prompt but keeps typed follow-ups", () => {
    renderPopup();

    // The seed restates the excerpt the user just selected; the panel belongs
    // to the answer. Later user messages are real follow-ups and stay. The
    // session prompt must not resurface either — foldConversation synthesizes
    // a user bubble from it once the seed event is filtered away.
    expect(screen.queryByText(/Explain this excerpt in more detail/)).toBeNull();
    expect(screen.queryByText("Build dashboard")).toBeNull();
    expect(screen.getByText("Follow-up: what about clock skew?")).toBeInTheDocument();
  });

  it("backfills the transcript once for its session", async () => {
    const onLoadSessionEvents = vi.fn().mockResolvedValue(undefined);
    renderPopup({ onLoadSessionEvents });

    await waitFor(() => expect(onLoadSessionEvents).toHaveBeenCalledWith("session-a"));
  });

  it("shows and resolves only its own pending approvals", async () => {
    const onResolveApproval = vi.fn().mockResolvedValue(undefined);
    const approval = {
      id: "approval-popup", sessionId: "session-a", command: "Read local file", cwd: "/tmp",
      provider: "claude" as const, providerInvocationId: "turn-1", providerRequestId: "request-1",
      riskLevel: "low" as const, status: "pending" as const,
      createdAt: "2026-09-07T10:00:00.000Z", resolvedAt: null
    };
    renderPopup({ approvals: [approval, { ...approval, id: "other", sessionId: "other", command: "Unrelated action" }], onResolveApproval });
    expect(screen.queryByText("Unrelated action")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Approve action: Read local file" }));
    await waitFor(() => expect(onResolveApproval).toHaveBeenCalledWith("approval-popup", "approved"));
  });

  it("closes from the header close button", () => {
    const onClose = vi.fn();
    renderPopup({ onClose });

    fireEvent.click(screen.getByRole("button", { name: "Close popup" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
