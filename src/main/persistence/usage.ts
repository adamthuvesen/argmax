import type Database from "better-sqlite3";
import { RecordNotFoundError } from "./errors.js";
import type { SessionCostSummary } from "../../shared/types.js";
import type { UsageCounts } from "../../shared/providerModels.js";

export interface InsertUsageEventInput {
  sessionId: string;
  eventId?: string;
  modelId: string;
  tokens: UsageCounts;
  costUsd: number;
  /**
   * Optional ISO-8601 timestamp; defaults to `new Date().toISOString()` at
   * insert time. Accepts epoch-ms for back-compat — the helper coerces to ISO.
   * Migration v13 unified usage_events.created_at to TEXT to match every other
   * timestamp column in the schema.
   */
  createdAt?: number | string;
}

interface UsageEventRow {
  model_id: string;
}

interface SessionCostRow {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
}

/**
 * Insert a usage-event audit row and bump the session-level token + cost
 * aggregates atomically. Nested-call safe — better-sqlite3 promotes this
 * transaction to a savepoint when run inside an outer transaction (which is
 * exactly how the provider session service's flushBatch invokes it).
 */
export function insertUsageEvent(connection: Database.Database, input: InsertUsageEventInput): void {
  const insertStmt = connection.prepare(
    `
      INSERT INTO usage_events (
        session_id, event_id, model_id, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, cost_usd, created_at
      ) VALUES (
        @sessionId, @eventId, @modelId, @inputTokens, @outputTokens,
        @cacheReadTokens, @cacheWriteTokens, @costUsd, @createdAt
      )
    `
  );
  const updateStmt = connection.prepare(
    `
      UPDATE sessions
      SET
        input_tokens = input_tokens + @inputTokens,
        output_tokens = output_tokens + @outputTokens,
        cache_read_tokens = cache_read_tokens + @cacheReadTokens,
        cache_write_tokens = cache_write_tokens + @cacheWriteTokens,
        cost_usd = cost_usd + @costUsd
      WHERE id = @sessionId
    `
  );
  const modelStmt = connection.prepare(
    "UPDATE sessions SET last_model_id = @modelId WHERE id = @sessionId"
  );
  const createdAtIso =
    typeof input.createdAt === "string"
      ? input.createdAt
      : typeof input.createdAt === "number"
        ? new Date(input.createdAt).toISOString()
        : new Date().toISOString();
  connection.transaction(() => {
    insertStmt.run({
      sessionId: input.sessionId,
      eventId: input.eventId ?? null,
      modelId: input.modelId,
      inputTokens: input.tokens.input,
      outputTokens: input.tokens.output,
      cacheReadTokens: input.tokens.cacheRead,
      cacheWriteTokens: input.tokens.cacheWrite,
      costUsd: input.costUsd,
      createdAt: createdAtIso
    });
    const result = updateStmt.run({
      sessionId: input.sessionId,
      inputTokens: input.tokens.input,
      outputTokens: input.tokens.output,
      cacheReadTokens: input.tokens.cacheRead,
      cacheWriteTokens: input.tokens.cacheWrite,
      costUsd: input.costUsd
    });
    if (result.changes === 0) {
      throw new RecordNotFoundError("session", input.sessionId);
    }
    if (input.modelId) {
      modelStmt.run({ sessionId: input.sessionId, modelId: input.modelId });
    }
  })();
}

export function getSessionCostSummary(connection: Database.Database, sessionId: string): SessionCostSummary {
  const sessionRow = connection
    .prepare(
      "SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, last_model_id FROM sessions WHERE id = ?"
    )
    .get(sessionId) as (SessionCostRow & { last_model_id: string | null }) | undefined;
  if (!sessionRow) {
    throw new RecordNotFoundError("session", sessionId);
  }
  const latestUsage = connection
    .prepare("SELECT model_id FROM usage_events WHERE session_id = ? ORDER BY id DESC LIMIT 1")
    .get(sessionId) as UsageEventRow | undefined;

  return {
    sessionId,
    modelId: latestUsage?.model_id ?? sessionRow.last_model_id ?? null,
    tokens: {
      input: sessionRow.input_tokens,
      output: sessionRow.output_tokens,
      cacheRead: sessionRow.cache_read_tokens,
      cacheWrite: sessionRow.cache_write_tokens
    },
    costUsd: sessionRow.cost_usd
  };
}
