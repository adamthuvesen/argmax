import { randomUUID } from "node:crypto";
import type { MaestroDatabase } from "../persistence/database.js";
import type { ApprovalRequest, ProviderId } from "../../shared/types.js";
import { classifyCommandRisk } from "./dangerousActionPolicy.js";

export interface RequestCommandApprovalInput {
  sessionId: string;
  command: string;
  cwd: string;
  provider: ProviderId;
}

export interface CommandApprovalDecision {
  allowed: boolean;
  approval: ApprovalRequest | null;
  reason: string;
}

export class ApprovalService {
  constructor(private readonly database: MaestroDatabase) {}

  requestCommandApproval(input: RequestCommandApprovalInput): CommandApprovalDecision {
    const risk = classifyCommandRisk(input.command);
    if (!risk.requiresApproval) {
      return {
        allowed: true,
        approval: null,
        reason: risk.reason
      };
    }

    const approval = this.database.persistApproval({
      id: randomUUID(),
      sessionId: input.sessionId,
      command: input.command,
      cwd: input.cwd,
      provider: input.provider,
      riskLevel: risk.riskLevel,
      status: "pending"
    });
    this.database.updateSessionState(input.sessionId, {
      state: "waiting",
      attention: "approval-needed"
    });
    this.database.persistTimelineEvent({
      id: randomUUID(),
      sessionId: input.sessionId,
      type: "approval.requested",
      message: risk.reason,
      payload: {
        command: input.command,
        cwd: input.cwd,
        provider: input.provider,
        riskLevel: risk.riskLevel
      }
    });

    return {
      allowed: false,
      approval,
      reason: risk.reason
    };
  }
}
