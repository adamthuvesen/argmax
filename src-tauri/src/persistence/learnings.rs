use rusqlite::{Connection, Row};
use serde::Serialize;
use specta::Type;
use uuid::Uuid;

use super::prepared::prepared;
use super::time::now_iso;
use crate::error::{ArgmaxError, ArgmaxResult};

#[derive(Debug, Clone, PartialEq)]
pub struct InsertLearningInput {
    pub id: Option<String>,
    pub project_id: String,
    pub kind: String,
    pub summary: String,
    pub evidence_session_id: Option<String>,
    pub evidence_event_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct UpdateLearningInput {
    pub id: String,
    pub summary: Option<String>,
    pub verified: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Learning {
    pub id: String,
    pub project_id: String,
    pub kind: String,
    pub summary: String,
    pub evidence_session_id: Option<String>,
    pub evidence_event_id: Option<String>,
    pub verified: bool,
    pub hits: i64,
    pub created_at: String,
    pub last_seen_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EventSearchResult {
    pub session_id: String,
    pub event_id: String,
    pub snippet: String,
    pub rank: f64,
}

pub fn insert_learning(
    connection: &Connection,
    input: &InsertLearningInput,
) -> ArgmaxResult<Learning> {
    let id = input
        .id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let now = now_iso();
    let mut statement = prepared(
        connection,
        r#"
        INSERT INTO learnings (id, project_id, kind, summary, evidence_session_id, evidence_event_id, created_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .map_err(sqlite_error)?;
    statement
        .execute((
            id.as_str(),
            input.project_id.as_str(),
            input.kind.as_str(),
            input.summary.as_str(),
            input.evidence_session_id.as_deref(),
            input.evidence_event_id.as_deref(),
            now.as_str(),
            now.as_str(),
        ))
        .map_err(sqlite_error)?;
    find_learning_by_id(connection, &id)
}

pub fn list_learnings(
    connection: &Connection,
    project_id: &str,
    limit: usize,
) -> ArgmaxResult<Vec<Learning>> {
    let mut statement = prepared(
        connection,
        r#"
        SELECT * FROM learnings WHERE project_id = ?
        ORDER BY verified DESC, hits DESC, last_seen_at DESC
        LIMIT ?
        "#,
    )
    .map_err(sqlite_error)?;
    let rows = statement
        .query_map((project_id, limit as i64), row_to_learning)
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

pub fn update_learning(
    connection: &Connection,
    input: &UpdateLearningInput,
) -> ArgmaxResult<Learning> {
    match (&input.summary, input.verified) {
        (None, None) => find_learning_by_id(connection, &input.id),
        (Some(summary), Some(verified)) => {
            let mut statement = prepared(
                connection,
                "UPDATE learnings SET summary = ?, verified = ?, last_seen_at = ? WHERE id = ?",
            )
            .map_err(sqlite_error)?;
            update_learning_row(
                &mut statement,
                (
                    summary.as_str(),
                    bool_to_i64(verified),
                    now_iso(),
                    input.id.as_str(),
                ),
                &input.id,
            )?;
            find_learning_by_id(connection, &input.id)
        }
        (Some(summary), None) => {
            let mut statement = prepared(
                connection,
                "UPDATE learnings SET summary = ?, last_seen_at = ? WHERE id = ?",
            )
            .map_err(sqlite_error)?;
            update_learning_row(
                &mut statement,
                (summary.as_str(), now_iso(), input.id.as_str()),
                &input.id,
            )?;
            find_learning_by_id(connection, &input.id)
        }
        (None, Some(verified)) => {
            let mut statement = prepared(
                connection,
                "UPDATE learnings SET verified = ?, last_seen_at = ? WHERE id = ?",
            )
            .map_err(sqlite_error)?;
            update_learning_row(
                &mut statement,
                (bool_to_i64(verified), now_iso(), input.id.as_str()),
                &input.id,
            )?;
            find_learning_by_id(connection, &input.id)
        }
    }
}

pub fn delete_learning(connection: &Connection, id: &str) -> ArgmaxResult<()> {
    let mut statement =
        prepared(connection, "DELETE FROM learnings WHERE id = ?").map_err(sqlite_error)?;
    statement.execute([id]).map_err(sqlite_error)?;
    Ok(())
}

pub fn search_events(
    connection: &Connection,
    query: &str,
    limit: usize,
) -> ArgmaxResult<Vec<EventSearchResult>> {
    search_events_raw(connection, &build_fts_prefix_query(query), limit)
}

pub fn search_events_raw(
    connection: &Connection,
    query: &str,
    limit: usize,
) -> ArgmaxResult<Vec<EventSearchResult>> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut statement = prepared(
        connection,
        r#"
        SELECT events.session_id AS session_id,
               events.id AS event_id,
               snippet(events_fts, 0, '<b>', '</b>', '...', 12) AS snippet,
               events_fts.rank AS rank
        FROM events_fts
        JOIN events ON events.rowid = events_fts.rowid
        WHERE events_fts MATCH ?
        ORDER BY events_fts.rank
        LIMIT ?
        "#,
    )
    .map_err(sqlite_error)?;
    let rows = statement
        .query_map((query, limit as i64), |row| {
            Ok(EventSearchResult {
                session_id: row.get("session_id")?,
                event_id: row.get("event_id")?,
                snippet: row.get("snippet")?,
                rank: row.get("rank")?,
            })
        })
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

fn find_learning_by_id(connection: &Connection, id: &str) -> ArgmaxResult<Learning> {
    let mut statement =
        prepared(connection, "SELECT * FROM learnings WHERE id = ?").map_err(sqlite_error)?;
    match statement.query_row([id], row_to_learning) {
        Ok(learning) => Ok(learning),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(ArgmaxError::record_not_found("learning", id))
        }
        Err(error) => Err(sqlite_error(error)),
    }
}

fn row_to_learning(row: &Row<'_>) -> rusqlite::Result<Learning> {
    Ok(Learning {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        kind: row.get("kind")?,
        summary: row.get("summary")?,
        evidence_session_id: row.get("evidence_session_id")?,
        evidence_event_id: row.get("evidence_event_id")?,
        verified: row.get::<_, i64>("verified")? == 1,
        hits: row.get("hits")?,
        created_at: row.get("created_at")?,
        last_seen_at: row.get("last_seen_at")?,
    })
}

fn update_learning_row<P>(
    statement: &mut rusqlite::CachedStatement<'_>,
    params: P,
    id: &str,
) -> ArgmaxResult<()>
where
    P: rusqlite::Params,
{
    let changes = statement.execute(params).map_err(sqlite_error)?;
    if changes == 0 {
        return Err(ArgmaxError::record_not_found("learning", id));
    }
    Ok(())
}

fn build_fts_prefix_query(query: &str) -> String {
    let tokens = query
        .split(|character: char| !character.is_ascii_alphanumeric() && character != '_')
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>();
    if tokens.is_empty() {
        return String::new();
    }
    let phrase = tokens.join(" ");
    let prefixed = tokens
        .iter()
        .filter(|token| !is_fts_operator_token(token))
        .map(|token| format!("{token}*"))
        .collect::<Vec<_>>()
        .join(" ");
    if prefixed.is_empty() {
        return format!("\"{phrase}\"");
    }
    format!("\"{phrase}\" OR ({prefixed})")
}

fn is_fts_operator_token(token: &str) -> bool {
    token.eq_ignore_ascii_case("AND")
        || token.eq_ignore_ascii_case("OR")
        || token.eq_ignore_ascii_case("NOT")
        || token.eq_ignore_ascii_case("NEAR")
}

fn bool_to_i64(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

fn sqlite_error(error: rusqlite::Error) -> ArgmaxError {
    ArgmaxError::service("SQLITE", error.to_string())
}
