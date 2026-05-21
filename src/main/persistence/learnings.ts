import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { RecordNotFoundError } from "./errors.js";
import type { Learning } from "../../shared/types.js";

interface LearningRow {
  id: string;
  project_id: string;
  kind: "pitfall" | "convention" | "command";
  summary: string;
  evidence_session_id: string | null;
  evidence_event_id: string | null;
  verified: number;
  hits: number;
  created_at: string;
  last_seen_at: string;
}

export interface InsertLearningInput {
  id?: string;
  projectId: string;
  kind: "pitfall" | "convention" | "command";
  summary: string;
  evidenceSessionId?: string | null;
  evidenceEventId?: string | null;
}

function learningRowToSummary(row: LearningRow): Learning {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    summary: row.summary,
    evidenceSessionId: row.evidence_session_id,
    evidenceEventId: row.evidence_event_id,
    verified: row.verified === 1,
    hits: row.hits,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at
  };
}

export function insertLearning(connection: Database.Database, input: InsertLearningInput): Learning {
  const id = input.id ?? randomUUID();
  const now = new Date().toISOString();
  connection
    .prepare(
      `INSERT INTO learnings (id, project_id, kind, summary, evidence_session_id, evidence_event_id, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.projectId,
      input.kind,
      input.summary,
      input.evidenceSessionId ?? null,
      input.evidenceEventId ?? null,
      now,
      now
    );
  const row = connection.prepare("SELECT * FROM learnings WHERE id = ?").get(id) as LearningRow;
  return learningRowToSummary(row);
}

export function listLearnings(
  connection: Database.Database,
  projectId: string,
  limit = 50
): Learning[] {
  const rows = connection
    .prepare(
      `SELECT * FROM learnings WHERE project_id = ?
       ORDER BY verified DESC, hits DESC, last_seen_at DESC
       LIMIT ?`
    )
    .all(projectId, limit) as LearningRow[];
  return rows.map(learningRowToSummary);
}

export function updateLearning(
  connection: Database.Database,
  input: { id: string; summary?: string; verified?: boolean }
): Learning {
  const fragments: string[] = [];
  const values: unknown[] = [];
  if (typeof input.summary === "string") {
    fragments.push("summary = ?");
    values.push(input.summary);
  }
  if (typeof input.verified === "boolean") {
    fragments.push("verified = ?");
    values.push(input.verified ? 1 : 0);
  }
  if (fragments.length === 0) {
    const existing = connection.prepare("SELECT * FROM learnings WHERE id = ?").get(input.id) as LearningRow | undefined;
    if (!existing) throw new RecordNotFoundError("learning", input.id);
    return learningRowToSummary(existing);
  }
  fragments.push("last_seen_at = ?");
  values.push(new Date().toISOString());
  values.push(input.id);
  const result = connection
    .prepare(`UPDATE learnings SET ${fragments.join(", ")} WHERE id = ?`)
    .run(...values);
  if (result.changes === 0) {
    throw new RecordNotFoundError("learning", input.id);
  }
  const row = connection.prepare("SELECT * FROM learnings WHERE id = ?").get(input.id) as LearningRow;
  return learningRowToSummary(row);
}

export function deleteLearning(connection: Database.Database, id: string): void {
  connection.prepare("DELETE FROM learnings WHERE id = ?").run(id);
}

/**
 * Ranked full-text search over events.message via the FTS5 sidecar. Returns
 * the matching session id, event id, an FTS5 snippet (with `<b>` markers
 * around the matched tokens), and the raw rank (lower = more relevant).
 *
 * Free-text input is quoted and escaped so FTS5 operator syntax doesn't leak
 * — `"`, `*`, `(`, `AND`/`OR`/`NEAR` etc. are no longer special. Use
 * {@link searchEventsRaw} when you actually want operator syntax (CLI usage,
 * power-user palette).
 */
export function searchEvents(
  connection: Database.Database,
  query: string,
  limit = 50
): Array<{ sessionId: string; eventId: string; snippet: string; rank: number }> {
  return searchEventsRaw(connection, escapeFts5(query), limit);
}

/** Wrap user input so FTS5 treats it as a literal phrase, escaping any
 *  embedded double quotes. Whitespace inside the phrase still tokenises. */
function escapeFts5(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return "";
  return `"${trimmed.replace(/"/g, '""')}"`;
}

export function searchEventsRaw(
  connection: Database.Database,
  query: string,
  limit = 50
): Array<{ sessionId: string; eventId: string; snippet: string; rank: number }> {
  if (!query.trim()) return [];
  const rows = connection
    .prepare(
      `SELECT events.session_id AS sessionId,
              events.id AS eventId,
              snippet(events_fts, 0, '<b>', '</b>', '…', 12) AS snippet,
              events_fts.rank AS rank
       FROM events_fts
       JOIN events ON events.rowid = events_fts.rowid
       WHERE events_fts MATCH ?
       ORDER BY events_fts.rank
       LIMIT ?`
    )
    .all(query, limit) as Array<{
    sessionId: string;
    eventId: string;
    snippet: string;
    rank: number;
  }>;
  return rows;
}
