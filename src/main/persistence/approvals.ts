import type Database from "better-sqlite3";
import { RecordNotFoundError } from "./errors.js";
import type { ApprovalRequest } from "../../shared/types.js";

interface ApprovalRow {
  id: string;
  session_id: string;
  command: string;
  cwd: string;
  provider: ApprovalRequest["provider"];
  risk_level: ApprovalRequest["riskLevel"];
  status: ApprovalRequest["status"];
  created_at: string;
  resolved_at: string | null;
}

export interface PersistApprovalInput {
  id: string;
  sessionId: string;
  command: string;
  cwd: string;
  provider: ApprovalRequest["provider"];
  riskLevel: ApprovalRequest["riskLevel"];
  status: ApprovalRequest["status"];
  createdAt?: string;
}

export interface FindPendingApprovalInput {
  sessionId: string;
  command: string;
  cwd: string;
  provider: ApprovalRequest["provider"];
}

function approvalRowToRequest(row: ApprovalRow): ApprovalRequest {
  return {
    id: row.id,
    sessionId: row.session_id,
    command: row.command,
    cwd: row.cwd,
    provider: row.provider,
    riskLevel: row.risk_level,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at
  };
}

function findApprovalById(connection: Database.Database, approvalId: string): ApprovalRequest {
  const row = connection.prepare("SELECT * FROM approvals WHERE id = ?").get(approvalId) as ApprovalRow | undefined;
  if (!row) {
    throw new RecordNotFoundError("approval", approvalId);
  }
  return approvalRowToRequest(row);
}

export function persistApproval(connection: Database.Database, input: PersistApprovalInput): ApprovalRequest {
  const createdAt = input.createdAt ?? new Date().toISOString();
  connection
    .prepare(
      `
        INSERT INTO approvals (id, session_id, command, cwd, provider, risk_level, status, created_at, resolved_at)
        VALUES (@id, @sessionId, @command, @cwd, @provider, @riskLevel, @status, @createdAt, NULL)
      `
    )
    .run({
      id: input.id,
      sessionId: input.sessionId,
      command: input.command,
      cwd: input.cwd,
      provider: input.provider,
      riskLevel: input.riskLevel,
      status: input.status,
      createdAt
    });

  return findApprovalById(connection, input.id);
}

export function findPendingApproval(
  connection: Database.Database,
  input: FindPendingApprovalInput
): ApprovalRequest | null {
  const row = connection
    .prepare(
      `
        SELECT * FROM approvals
        WHERE session_id = ? AND command = ? AND cwd = ? AND provider = ? AND status = 'pending'
        LIMIT 1
      `
    )
    .get(input.sessionId, input.command, input.cwd, input.provider) as ApprovalRow | undefined;
  if (!row) {
    return null;
  }
  return approvalRowToRequest(row);
}

export function resolveApproval(
  connection: Database.Database,
  approvalId: string,
  status: Extract<ApprovalRequest["status"], "approved" | "rejected">
): ApprovalRequest {
  connection
    .prepare("UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ?")
    .run(status, new Date().toISOString(), approvalId);

  return findApprovalById(connection, approvalId);
}

export function listApprovals(connection: Database.Database, limit: number): ApprovalRequest[] {
  return (
    connection.prepare(`SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?`).all(limit) as ApprovalRow[]
  ).map(approvalRowToRequest);
}

export function listPendingApprovals(connection: Database.Database, limit: number): ApprovalRequest[] {
  return (
    connection
      .prepare(`SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as ApprovalRow[]
  ).map(approvalRowToRequest);
}
