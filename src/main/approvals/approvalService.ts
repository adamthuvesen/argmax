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

  /**
   * Persist an approval request and the matching session-state and timeline
   * mutations atomically. All three writes share a single SQLite transaction
   * so a concurrent reader cannot observe a half-applied state (e.g. an
   * approval row without the corresponding "waiting" session state).
   *
   * Concurrent requests with the same (sessionId, command, cwd, provider)
   * tuple collapse into a single pending row: the SELECT-then-INSERT inside
   * the transaction sees a fresh snapshot, so the second caller observes the
   * first caller's row and returns the existing approval rather than
   * creating a duplicate.
   *
   * `findPendingApproval` is provided by the persistence layer (added by the
   * foundations agent in this change wave). If absent at runtime, we fall
   * back to non-deduplicated behavior so the service remains usable.
   */
  requestCommandApproval(input: RequestCommandApprovalInput): CommandApprovalDecision {
    const risk = classifyCommandRisk(input.command);
    if (!risk.requiresApproval) {
      return {
        allowed: true,
        approval: null,
        reason: risk.reason
      };
    }

    return this.database.connection.transaction((): CommandApprovalDecision => {
      const existing = findPendingApproval(this.database, {
        sessionId: input.sessionId,
        command: input.command,
        cwd: input.cwd,
        provider: input.provider
      });
      if (existing) {
        return {
          allowed: false,
          approval: existing,
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
    })();
  }

  /**
   * Resolve an approval and emit the matching session-state transition and
   * timeline event in a single transaction. The renderer reads each of
   * these via `loadDashboard`; without the transaction wrapper a concurrent
   * dashboard refresh could see the approval as "approved" while the
   * session is still in `waiting/approval-needed`.
   */
  resolveApproval(
    approvalId: string,
    status: Extract<ApprovalRequest["status"], "approved" | "rejected">
  ): ApprovalRequest {
    return this.database.connection.transaction((): ApprovalRequest => {
      const approval = this.database.resolveApproval(approvalId, status);
      this.database.updateSessionState(approval.sessionId, {
        state: status === "approved" ? "running" : "blocked",
        attention: "normal"
      });
      this.database.persistTimelineEvent({
        id: randomUUID(),
        sessionId: approval.sessionId,
        type: "approval.resolved",
        message: status === "approved" ? "Approval granted" : "Approval denied",
        payload: {
          approvalId: approval.id,
          status,
          command: approval.command
        }
      });
      return approval;
    })();
  }
}

interface PendingApprovalQuery {
  sessionId: string;
  command: string;
  cwd: string;
  provider: ProviderId;
}

/**
 * Bridge to the persistence-layer helper. Foundations agent adds
 * `findPendingApproval` to `MaestroDatabase`; until that lands at runtime
 * we treat its absence as "no dedup" rather than crashing the service.
 */
function findPendingApproval(
  database: MaestroDatabase,
  query: PendingApprovalQuery
): ApprovalRequest | null {
  const candidate = (database as unknown as {
    findPendingApproval?: (q: PendingApprovalQuery) => ApprovalRequest | null;
  }).findPendingApproval;
  if (typeof candidate === "function") {
    return candidate.call(database, query);
  }
  return null;
}
