import type Database from "better-sqlite3";
import { safeJsonParseRecord } from "../../shared/safeJson.js";
import type { UsageCounts } from "../../shared/providerModels.js";
import type { RawProviderOutput, TimelineEvent } from "../../shared/types.js";
import { prepared } from "./preparedStatements.js";

export interface EventRow {
  row_cursor?: number;
  id: string;
  session_id: string;
  type: TimelineEvent["type"];
  message: string;
  payload_json: string;
  created_at: string;
}

export interface RawOutputRow {
  row_cursor?: number;
  id: string;
  session_id: string;
  stream: RawProviderOutput["stream"];
  content: string;
  created_at: string;
}

export interface PersistTimelineEventInput {
  id: string;
  sessionId: string;
  type: TimelineEvent["type"];
  message: string;
  payload: Record<string, unknown>;
  createdAt?: string;
  /**
   * Optional usage sidecar. Not persisted to the events row; consumed by
   * the provider session service to drive `insertUsageEvent`.
   */
  usage?: {
    modelId: string;
    tokens: UsageCounts;
    costUsd: number;
    eventId?: string;
  };
}

export interface PersistRawOutputInput {
  id: string;
  sessionId: string;
  stream: "stdout" | "stderr" | "pty" | "system";
  content: string;
  createdAt?: string;
}

export interface SessionEventsSinceInput {
  sessionId: string;
  eventCursor?: number;
  rawOutputCursor?: number;
}

export interface SessionEventsSinceResult {
  events: TimelineEvent[];
  rawOutputs: RawProviderOutput[];
  eventCursor: number;
  rawOutputCursor: number;
}

export function eventRowToTimelineEvent(row: EventRow): TimelineEvent {
  return {
    id: row.id,
    sessionId: row.session_id,
    type: row.type,
    message: row.message,
    payload: safeJsonParseRecord(row.payload_json, "database.eventPayload"),
    createdAt: row.created_at
  };
}

export function rawOutputRowToProviderOutput(row: RawOutputRow): RawProviderOutput {
  return {
    id: row.id,
    sessionId: row.session_id,
    stream: row.stream,
    content: row.content,
    createdAt: row.created_at
  };
}

function maxRowCursor(rows: Array<{ row_cursor?: number }>, fallback: number): number {
  return rows.reduce((max, row) => Math.max(max, row.row_cursor ?? max), fallback);
}

export function persistTimelineEvent(
  connection: Database.Database,
  input: PersistTimelineEventInput
): TimelineEvent {
  const createdAt = input.createdAt ?? new Date().toISOString();
  prepared(
    connection,
    `
      INSERT INTO events (id, session_id, type, message, payload_json, created_at)
      VALUES (@id, @sessionId, @type, @message, @payloadJson, @createdAt)
    `
  ).run({
    id: input.id,
    sessionId: input.sessionId,
    type: input.type,
    message: input.message,
    payloadJson: JSON.stringify(input.payload),
    createdAt
  });

  return {
    id: input.id,
    sessionId: input.sessionId,
    type: input.type,
    message: input.message,
    payload: input.payload,
    createdAt
  };
}

export function persistRawOutput(
  connection: Database.Database,
  input: PersistRawOutputInput
): void {
  prepared(
    connection,
    `
      INSERT INTO raw_outputs (id, session_id, stream, content, created_at)
      VALUES (@id, @sessionId, @stream, @content, @createdAt)
    `
  ).run({
    id: input.id,
    sessionId: input.sessionId,
    stream: input.stream,
    content: input.content,
    createdAt: input.createdAt ?? new Date().toISOString()
  });
}

export function listSessionEventsSince(
  connection: Database.Database,
  input: SessionEventsSinceInput,
  eventPageLimit: number,
  rawOutputPageLimit: number
): SessionEventsSinceResult {
  const eventRows = input.eventCursor === undefined
    ? (prepared(
        connection,
        `
          SELECT * FROM (
            SELECT rowid AS row_cursor, * FROM events
            WHERE session_id = ?
            ORDER BY rowid DESC
            LIMIT ?
          )
          ORDER BY row_cursor ASC
        `
      ).all(input.sessionId, eventPageLimit) as EventRow[])
    : (prepared(
        connection,
        `
          SELECT rowid AS row_cursor, * FROM events
          WHERE session_id = ? AND rowid > ?
          ORDER BY rowid ASC
          LIMIT ?
        `
      ).all(input.sessionId, input.eventCursor, eventPageLimit) as EventRow[]);

  const rawOutputRows = input.rawOutputCursor === undefined
    ? (prepared(
        connection,
        `
          SELECT * FROM (
            SELECT rowid AS row_cursor, * FROM raw_outputs
            WHERE session_id = ?
            ORDER BY rowid DESC
            LIMIT ?
          )
          ORDER BY row_cursor ASC
        `
      ).all(input.sessionId, rawOutputPageLimit) as RawOutputRow[])
    : (prepared(
        connection,
        `
          SELECT rowid AS row_cursor, * FROM raw_outputs
          WHERE session_id = ? AND rowid > ?
          ORDER BY rowid ASC
          LIMIT ?
        `
      ).all(input.sessionId, input.rawOutputCursor, rawOutputPageLimit) as RawOutputRow[]);

  return {
    events: eventRows.map(eventRowToTimelineEvent),
    rawOutputs: rawOutputRows.map(rawOutputRowToProviderOutput),
    eventCursor: maxRowCursor(eventRows, input.eventCursor ?? 0),
    rawOutputCursor: maxRowCursor(rawOutputRows, input.rawOutputCursor ?? 0)
  };
}
