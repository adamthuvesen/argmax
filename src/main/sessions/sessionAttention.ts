import type { ApprovalRequest, AttentionState, SessionState } from "../../shared/types.js";

export interface SessionAttentionInput {
  state: SessionState;
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

  if (input.state === "complete") {
    return "review-ready";
  }

  return "normal";
}
