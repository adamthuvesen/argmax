import type Database from "better-sqlite3";
import { RecordNotFoundError } from "./errors.js";
import { findWorkspaceById } from "./workspaces.js";
import { safeJsonParseRecord } from "../../shared/safeJson.js";
import type { SessionSummary } from "../../shared/types.js";
import type { ReasoningEffort } from "../../shared/providerModels.js";

export interface SessionRow {
  id: string;
  workspace_id: string;
  provider: SessionSummary["provider"];
  model_label: string;
  model_id: string | null;
  reasoning_effort: ReasoningEffort | null;
  provider_conversation_id: string | null;
  prompt: string;
  state: SessionSummary["state"];
  attention: SessionSummary["attention"];
  started_at: string;
  completed_at: string | null;
  last_activity_at: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
}

export interface PersistSessionInput {
  id: string;
  workspaceId: string;
  provider: SessionSummary["provider"];
  modelLabel: string;
  modelId: string;
  reasoningEffort?: ReasoningEffort;
  prompt: string;
  state: SessionSummary["state"];
  attention: SessionSummary["attention"];
}

export interface SessionModelInput {
  modelLabel: string;
  modelId: string;
  reasoningEffort?: ReasoningEffort;
}

export interface SessionStateInput {
  state: SessionSummary["state"];
  attention: SessionSummary["attention"];
  completedAt?: string | null;
  lastActivityAt?: string;
}

export function sessionRowToSummary(row: SessionRow, preferred: boolean): SessionSummary {
  // model_id is backfilled by migration v5 and required by `persistSession`'s
  // TypeScript input. A null here means a buggy write path or a corrupted
  // database — fail visibly rather than papering over with the human label.
  if (row.model_id == null) {
    throw new Error(`Session row missing model_id (id=${row.id}); database may be corrupted.`);
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    provider: row.provider,
    modelLabel: row.model_label,
    modelId: row.model_id,
    ...(row.reasoning_effort ? { reasoningEffort: row.reasoning_effort } : {}),
    providerConversationId: row.provider_conversation_id,
    prompt: row.prompt,
    state: row.state,
    attention: row.attention,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    lastActivityAt: row.last_activity_at,
    preferred,
    costUsd: row.cost_usd,
    tokens: {
      input: row.input_tokens,
      output: row.output_tokens,
      cacheRead: row.cache_read_tokens,
      cacheWrite: row.cache_write_tokens
    }
  };
}

export function persistSession(
  connection: Database.Database,
  input: PersistSessionInput
): SessionSummary {
  const timestamp = new Date().toISOString();
  connection
    .prepare(
      `
        INSERT INTO sessions (
          id, workspace_id, provider, model_label, model_id, reasoning_effort, provider_conversation_id, prompt, state, attention,
          started_at, completed_at, last_activity_at
        ) VALUES (
          @id, @workspaceId, @provider, @modelLabel, @modelId, @reasoningEffort, NULL, @prompt, @state, @attention,
          @startedAt, NULL, @lastActivityAt
        )
      `
    )
    .run({
      id: input.id,
      workspaceId: input.workspaceId,
      provider: input.provider,
      modelLabel: input.modelLabel,
      modelId: input.modelId,
      reasoningEffort: input.reasoningEffort ?? null,
      prompt: input.prompt,
      state: input.state,
      attention: input.attention,
      startedAt: timestamp,
      lastActivityAt: timestamp
    });

  // Just-persisted row: no need to scan ui_state for the preferred bit.
  // The row is brand new, so `preferred` is necessarily `false` here.
  // (selectPreferredAttempt is the only writer to ui_state and it has
  // its own re-read path.)
  return findSessionByIdNoPreferred(connection, input.id);
}

export function updateSessionModel(
  connection: Database.Database,
  sessionId: string,
  input: SessionModelInput
): SessionSummary {
  const timestamp = new Date().toISOString();
  connection
    .prepare(
      `
        UPDATE sessions
        SET model_label = ?, model_id = ?, reasoning_effort = ?, last_activity_at = ?
        WHERE id = ?
      `
    )
    .run(input.modelLabel, input.modelId, input.reasoningEffort ?? null, timestamp, sessionId);

  return findSessionByIdNoPreferred(connection, sessionId);
}

export function updateSessionState(
  connection: Database.Database,
  sessionId: string,
  input: SessionStateInput
): SessionSummary {
  const timestamp = input.lastActivityAt ?? new Date().toISOString();
  connection
    .prepare(
      `
        UPDATE sessions
        SET state = ?, attention = ?, completed_at = ?, last_activity_at = ?
        WHERE id = ?
      `
    )
    .run(input.state, input.attention, input.completedAt ?? null, timestamp, sessionId);

  // The preferred bit is decoupled from session state; reuse the
  // NoPreferred fast path. If a caller specifically needs the preferred
  // flag after a state update they should call findSessionById/getSession.
  return findSessionByIdNoPreferred(connection, sessionId);
}

export function updateSessionProviderConversationId(
  connection: Database.Database,
  sessionId: string,
  providerConversationId: string
): SessionSummary {
  const timestamp = new Date().toISOString();
  connection
    .prepare("UPDATE sessions SET provider_conversation_id = ?, last_activity_at = ? WHERE id = ?")
    .run(providerConversationId, timestamp, sessionId);

  return findSessionByIdNoPreferred(connection, sessionId);
}

export function findSessionById(connection: Database.Database, sessionId: string): SessionSummary {
  const row = connection.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as SessionRow | undefined;
  if (!row) {
    throw new RecordNotFoundError("session", sessionId);
  }
  return sessionRowToSummary(row, isPreferredSession(connection, row.id));
}

/**
 * Single-row session SELECT that does NOT consult `ui_state` for the
 * preferred bit; returns `preferred: false`. Use from hot paths and from
 * post-write callers that just inserted/updated the row (`persistSession`,
 * `updateSessionState`) where the preferred flag has not changed and
 * cannot be true anyway.
 */
function findSessionByIdNoPreferred(
  connection: Database.Database,
  sessionId: string
): SessionSummary {
  const row = connection.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as SessionRow | undefined;
  if (!row) {
    throw new RecordNotFoundError("session", sessionId);
  }
  return sessionRowToSummary(row, false);
}

export function updateSessionLastModelId(
  connection: Database.Database,
  sessionId: string,
  modelId: string
): void {
  if (!modelId) return;
  connection
    .prepare("UPDATE sessions SET last_model_id = ? WHERE id = ?")
    .run(modelId, sessionId);
}

export function selectPreferredAttempt(
  connection: Database.Database,
  sessionId: string
): SessionSummary {
  return connection.transaction(() => {
    // Read first via the no-preferred fast path so the workspace lookup is
    // available without an extra ui_state scan.
    const session = findSessionByIdNoPreferred(connection, sessionId);
    const workspace = findWorkspaceById(connection, session.workspaceId);
    const key = preferredAttemptKey(workspace.projectId, workspace.taskLabel);
    connection
      .prepare(
        `
          INSERT INTO ui_state (key, value_json, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
        `
      )
      .run(key, JSON.stringify({ sessionId }), new Date().toISOString());

    // Re-read with preferred recomputed; returned session reflects the
    // just-written preferred state without relying on a `{ ...session,
    // preferred: true }` overlay — concurrent calls would otherwise
    // interleave and produce stale snapshots.
    return findSessionById(connection, sessionId);
  })();
}

export function loadPreferredSessionIds(connection: Database.Database): Set<string> {
  // Range scan on the PK index — `LIKE 'preferred-attempt:%'` skips the index
  // unless `case_sensitive_like` is ON. The half-open range below uses the PK
  // regardless of pragma settings. `:` is 0x3A, `;` is 0x3B (next codepoint).
  const rows = connection
    .prepare(
      "SELECT value_json FROM ui_state WHERE key >= 'preferred-attempt:' AND key < 'preferred-attempt;'"
    )
    .all() as Array<{ value_json: string }>;

  return new Set(
    rows
      .map((row) => safeJsonParseRecord(row.value_json, "sessions.preferredAttempt").sessionId)
      .filter((value): value is string => typeof value === "string")
  );
}

function isPreferredSession(connection: Database.Database, sessionId: string): boolean {
  return loadPreferredSessionIds(connection).has(sessionId);
}

function preferredAttemptKey(projectId: string, taskLabel: string): string {
  return `preferred-attempt:${projectId}:${taskLabel}`;
}
