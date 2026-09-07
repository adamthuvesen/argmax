import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest, TimelineEvent } from "../../shared/types.js";
import { ApprovalSurface } from "./ApprovalSurface.js";

const approval: ApprovalRequest = {
  id: "approval-1",
  sessionId: "session-1",
  command: "git worktree remove /tmp/draft",
  cwd: "/Users/adam/code/project",
  provider: "codex",
  providerInvocationId: null,
  providerRequestId: "request-1",
  riskLevel: "high",
  status: "pending",
  createdAt: "2026-09-07T10:00:00.000Z",
  resolvedAt: null
};

const event: TimelineEvent = {
  id: "event-1",
  sessionId: "session-1",
  type: "approval.requested",
  message: approval.command,
  payload: {
    command: approval.command,
    cwd: approval.cwd,
    providerRequestId: approval.providerRequestId,
    reason: "Removing a worktree can discard local files."
  },
  createdAt: approval.createdAt
};

describe("ApprovalSurface", () => {
  it("explains the action and reason before approving once", async () => {
    let acknowledge!: () => void;
    const pending = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const onResolveApproval = vi.fn(() => pending);

    render(
      <ApprovalSurface approvals={[approval]} events={[event]} onResolveApproval={onResolveApproval} />
    );

    expect(screen.getByText(approval.command)).toBeInTheDocument();
    expect(screen.getByText("Removing a worktree can discard local files.")).toBeInTheDocument();

    const approve = screen.getByRole("button", { name: `Approve action: ${approval.command}` });
    const reject = screen.getByRole("button", { name: `Reject action: ${approval.command}` });
    fireEvent.click(approve);

    expect(onResolveApproval).toHaveBeenCalledWith("approval-1", "approved");
    expect(approve).toBeDisabled();
    expect(reject).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Approving…");

    acknowledge();
    await waitFor(() => expect(screen.getByText("Response sent")).toBeInTheDocument());
    expect(approve).toBeDisabled();
  });

  it("keeps a failed request actionable and reports the failure inline", async () => {
    const onResolveApproval = vi.fn().mockRejectedValue(new Error("Request expired"));
    render(
      <ApprovalSurface approvals={[approval]} events={[event]} onResolveApproval={onResolveApproval} />
    );

    const approve = screen.getByRole("button", { name: `Approve action: ${approval.command}` });
    fireEvent.click(approve);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not send your response. Request expired"
    );
    expect(approve).not.toBeDisabled();
  });

  it("names the tool instead of dumping its input JSON", () => {
    const input = { questions: [{ header: "Target", options: [{ label: "One" }] }], limit: 3 };
    render(
      <ApprovalSurface
        approvals={[{ ...approval, command: `AskUserQuestion\n${JSON.stringify(input)}` }]}
        events={[]}
        onResolveApproval={vi.fn()}
      />
    );

    expect(screen.getByText("AskUserQuestion")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve action: AskUserQuestion" })).toBeInTheDocument();
    // Scalars are arguments you decide on; the question set is payload.
    expect(screen.getByText("limit")).toBeInTheDocument();
    expect(screen.queryByText(/"header"/)).not.toBeInTheDocument();
  });

  it("shows stale requests without response actions", () => {
    render(
      <ApprovalSurface
        approvals={[{ ...approval, status: "cancelled" }]}
        events={[event]}
        onResolveApproval={vi.fn()}
      />
    );

    expect(screen.getByText("No longer active")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
