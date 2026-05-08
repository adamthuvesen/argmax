import type { ApprovalRequest, AttentionState, WorkspaceState } from "../../shared/types.js";

export interface SessionAttentionInput {
  state: WorkspaceState;
  pendingApprovals?: Array<Pick<ApprovalRequest, "status">>;
}

export function computeSessionAttention(input: SessionAttentionInput): AttentionState {
  if (input.pendingApprovals?.some((approval) => approval.status === "pending")) {
    return "approval-needed";
  }

  if (input.state === "blocked" || input.state === "waiting") {
    return "blocked";
  }

  if (input.state === "failed") {
    return "failed";
  }

  if (input.state === "complete" || input.state === "kept") {
    return "review-ready";
  }

  return "normal";
}
