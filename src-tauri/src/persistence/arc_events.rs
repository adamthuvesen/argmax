//! An Arc's timeline: an append-only record of what happened in it.
//!
//! The history cannot be derived on read. Sessions are deleted by "delete old
//! chats", and coordinator repoints, brief edits, state changes, and `NOTES.md`
//! edits leave no row anywhere else. So each write point records one row here,
//! with a deterministic id that makes a repeated write (a retried turn end, a
//! second poller tick) a no-op.
//!
//! Rows name their session and project by id without a foreign key, so an
//! event outlives the chat it describes. Labels are resolved at read time when
//! the session still exists, since a member's title lands after its launch.

use std::collections::HashMap;

use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use specta::Type;

use super::{sqlite_error, time::now_iso};
use crate::error::ArgmaxResult;

/// Registered by migration v53.
pub const MIGRATION_SQL: &str = r#"
CREATE TABLE arc_events (
  id TEXT PRIMARY KEY,
  arc_id TEXT NOT NULL REFERENCES arcs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'created', 'coordinator_started', 'member_launched', 'member_finished',
    'pr_checks_failing', 'pr_checks_passing', 'pr_merged', 'notes_updated',
    'brief_updated', 'state_changed', 'scheduled_run'
  )),
  occurred_at TEXT NOT NULL,
  session_id TEXT,
  project_id TEXT,
  title TEXT NOT NULL,
  detail TEXT,
  status TEXT,
  pr_number INTEGER,
  pr_url TEXT
);
CREATE INDEX idx_arc_events_timeline ON arc_events(arc_id, occurred_at DESC);
ALTER TABLE arcs ADD COLUMN notes_snapshot TEXT;
"#;

/// How much of a member's final answer or a coordinator's note-taking turn a
/// row keeps. The row is a pointer into the chat, not a copy of it.
const DETAIL_MAX_CHARS: usize = 600;
pub const TIMELINE_PAGE_MAX: i64 = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ArcEventKind {
    Created,
    CoordinatorStarted,
    MemberLaunched,
    MemberFinished,
    PrChecksFailing,
    PrChecksPassing,
    PrMerged,
    NotesUpdated,
    BriefUpdated,
    StateChanged,
    ScheduledRun,
}

impl ArcEventKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::CoordinatorStarted => "coordinator_started",
            Self::MemberLaunched => "member_launched",
            Self::MemberFinished => "member_finished",
            Self::PrChecksFailing => "pr_checks_failing",
            Self::PrChecksPassing => "pr_checks_passing",
            Self::PrMerged => "pr_merged",
            Self::NotesUpdated => "notes_updated",
            Self::BriefUpdated => "brief_updated",
            Self::StateChanged => "state_changed",
            Self::ScheduledRun => "scheduled_run",
        }
    }

    fn from_wire(value: &str) -> Option<Self> {
        [
            Self::Created,
            Self::CoordinatorStarted,
            Self::MemberLaunched,
            Self::MemberFinished,
            Self::PrChecksFailing,
            Self::PrChecksPassing,
            Self::PrMerged,
            Self::NotesUpdated,
            Self::BriefUpdated,
            Self::StateChanged,
            Self::ScheduledRun,
        ]
        .into_iter()
        .find(|kind| kind.as_str() == value)
    }
}

/// One row to record. `id` is the dedupe key: build it from what makes the
/// event unique (`finished:<session>:<turn end>`), never from a fresh UUID,
/// unless the event genuinely cannot repeat.
#[derive(Debug, Clone)]
pub struct NewArcEvent<'a> {
    pub id: String,
    pub arc_id: &'a str,
    pub kind: ArcEventKind,
    pub occurred_at: Option<String>,
    pub session_id: Option<&'a str>,
    pub project_id: Option<&'a str>,
    pub title: String,
    pub detail: Option<String>,
    pub status: Option<String>,
    pub pr_number: Option<i64>,
    pub pr_url: Option<&'a str>,
}

impl<'a> NewArcEvent<'a> {
    pub fn new(id: String, arc_id: &'a str, kind: ArcEventKind, title: impl Into<String>) -> Self {
        Self {
            id,
            arc_id,
            kind,
            occurred_at: None,
            session_id: None,
            project_id: None,
            title: title.into(),
            detail: None,
            status: None,
            pr_number: None,
            pr_url: None,
        }
    }
}

/// Records one event. Returns whether a row was written; `false` means the
/// same event was already recorded.
pub fn record_arc_event(connection: &Connection, event: &NewArcEvent<'_>) -> ArgmaxResult<bool> {
    let occurred_at = event.occurred_at.clone().unwrap_or_else(now_iso);
    let detail = event
        .detail
        .as_deref()
        .map(excerpt)
        .filter(|text| !text.is_empty());
    let inserted = connection
        .prepare_cached(
            r#"
            INSERT OR IGNORE INTO arc_events (
                id, arc_id, kind, occurred_at, session_id, project_id, title,
                detail, status, pr_number, pr_url
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .map_err(sqlite_error)?
        .execute(params![
            event.id,
            event.arc_id,
            event.kind.as_str(),
            occurred_at,
            event.session_id,
            event.project_id,
            event.title,
            detail,
            event.status,
            event.pr_number,
            event.pr_url,
        ])
        .map_err(sqlite_error)?;
    Ok(inserted > 0)
}

/// One timeline row as the Arc page renders it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArcTimelineEvent {
    pub id: String,
    pub seq: i64,
    pub kind: ArcEventKind,
    pub occurred_at: String,
    pub session_id: Option<String>,
    /// Whether the session still exists, so the page can offer to open it.
    pub session_available: bool,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    /// The member's current label when the session still exists, otherwise
    /// the label recorded with the event.
    pub title: String,
    pub detail: Option<String>,
    pub status: Option<String>,
    pub pr_number: Option<i64>,
    pub pr_url: Option<String>,
}

/// Where the next page starts: the last row of the previous one. `seq` is
/// the row's insertion order, which breaks ties between events recorded in
/// the same millisecond (an Arc created and its coordinator started together)
/// the way they actually happened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArcTimelineCursor {
    pub occurred_at: String,
    pub seq: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArcTimelinePage {
    pub events: Vec<ArcTimelineEvent>,
    pub next_cursor: Option<ArcTimelineCursor>,
}

/// Newest first, keyset-paged on `(occurred_at, insertion order)` so rows
/// recorded while a person scrolls never shift a page.
pub fn list_arc_timeline(
    connection: &Connection,
    arc_id: &str,
    before: Option<&ArcTimelineCursor>,
    limit: i64,
) -> ArgmaxResult<ArcTimelinePage> {
    let limit = limit.clamp(1, TIMELINE_PAGE_MAX);
    let (before_at, before_seq) = match before {
        Some(cursor) => (Some(cursor.occurred_at.as_str()), Some(cursor.seq)),
        None => (None, None),
    };
    let mut statement = connection
        .prepare_cached(
            r#"
            SELECT arc_events.rowid AS seq, arc_events.id, arc_events.kind, arc_events.occurred_at,
                   arc_events.session_id, sessions.id IS NOT NULL AS session_available,
                   arc_events.project_id, projects.name AS project_name,
                   CASE
                     WHEN arc_events.kind IN ('member_launched', 'member_finished')
                       THEN COALESCE(NULLIF(trim(workspaces.task_label), ''), arc_events.title)
                     ELSE arc_events.title
                   END AS title,
                   arc_events.detail, arc_events.status, arc_events.pr_number,
                   arc_events.pr_url
            FROM arc_events
            LEFT JOIN sessions ON sessions.id = arc_events.session_id
            LEFT JOIN workspaces ON workspaces.id = sessions.workspace_id
            LEFT JOIN projects ON projects.id = arc_events.project_id
            WHERE arc_events.arc_id = ?1
              AND (?2 IS NULL
                   OR arc_events.occurred_at < ?2
                   OR (arc_events.occurred_at = ?2 AND arc_events.rowid < ?3))
            ORDER BY arc_events.occurred_at DESC, arc_events.rowid DESC
            LIMIT ?4
            "#,
        )
        .map_err(sqlite_error)?;
    let mut events = statement
        .query_map(
            params![arc_id, before_at, before_seq, limit + 1],
            row_to_event,
        )
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    let has_more = events.len() as i64 > limit;
    events.truncate(limit as usize);
    let next_cursor = has_more
        .then(|| events.last())
        .flatten()
        .map(|event| ArcTimelineCursor {
            occurred_at: event.occurred_at.clone(),
            seq: event.seq,
        });
    Ok(ArcTimelinePage {
        events,
        next_cursor,
    })
}

fn row_to_event(row: &Row<'_>) -> rusqlite::Result<ArcTimelineEvent> {
    let kind: String = row.get("kind")?;
    Ok(ArcTimelineEvent {
        id: row.get("id")?,
        seq: row.get("seq")?,
        kind: ArcEventKind::from_wire(&kind).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                format!("unknown arc event kind {kind}").into(),
            )
        })?,
        occurred_at: row.get("occurred_at")?,
        session_id: row.get("session_id")?,
        session_available: row.get("session_available")?,
        project_id: row.get("project_id")?,
        project_name: row.get("project_name")?,
        title: row.get("title")?,
        detail: row.get("detail")?,
        status: row.get("status")?,
        pr_number: row.get("pr_number")?,
        pr_url: row.get("pr_url")?,
    })
}

/// What changed between two versions of `NOTES.md`, for a `notes_updated`
/// row: how many lines came and went, and the first new heading (or line) as
/// a hint of what the coordinator wrote. Lines are compared as a multiset,
/// which is exact about counts and cheap on a file that only grows by edits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotesChange {
    pub added: usize,
    pub removed: usize,
    pub first_new_line: Option<String>,
}

pub fn notes_change(before: &str, after: &str) -> Option<NotesChange> {
    if before == after {
        return None;
    }
    let mut remaining: HashMap<&str, usize> = HashMap::new();
    for line in before.lines().filter(|line| !line.trim().is_empty()) {
        *remaining.entry(line).or_default() += 1;
    }
    let mut added_lines = Vec::new();
    for line in after.lines().filter(|line| !line.trim().is_empty()) {
        match remaining.get_mut(line) {
            Some(count) if *count > 0 => *count -= 1,
            _ => added_lines.push(line),
        }
    }
    let removed = remaining.values().sum();
    if added_lines.is_empty() && removed == 0 {
        return None;
    }
    let first_new_line = added_lines
        .iter()
        .find(|line| line.trim_start().starts_with('#'))
        .or_else(|| added_lines.first())
        .map(|line| line.trim().trim_start_matches('#').trim().to_string());
    Some(NotesChange {
        added: added_lines.len(),
        removed,
        first_new_line,
    })
}

/// The first paragraph of an answer, capped. A coordinator's turn usually
/// opens with what it decided, which is what a timeline row should carry.
pub fn first_paragraph(text: &str) -> String {
    let paragraph = text
        .split("\n\n")
        .map(str::trim)
        .find(|part| !part.is_empty())
        .unwrap_or("");
    excerpt(paragraph)
}

fn excerpt(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= DETAIL_MAX_CHARS {
        return trimmed.to_string();
    }
    let mut cut: String = trimmed.chars().take(DETAIL_MAX_CHARS).collect();
    if let Some(space) = cut.rfind(char::is_whitespace) {
        cut.truncate(space);
    }
    format!("{}…", cut.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notes_change_counts_lines_and_prefers_a_new_heading() {
        let before = "# Plan\n- one\n- two\n";
        let after = "# Plan\n- one\n- three\n\n## Gotchas\n- commit with -c user.name\n";
        let change = notes_change(before, after).expect("changed");
        assert_eq!(change.added, 3);
        assert_eq!(change.removed, 1);
        assert_eq!(change.first_new_line.as_deref(), Some("Gotchas"));
    }

    #[test]
    fn notes_change_ignores_blank_line_edits() {
        assert_eq!(notes_change("a\nb\n", "a\n\n\nb\n"), None);
        assert_eq!(notes_change("same", "same"), None);
    }

    #[test]
    fn first_paragraph_caps_on_a_word_boundary() {
        let long = "word ".repeat(400);
        let result = first_paragraph(&format!("{long}\n\nsecond"));
        assert!(result.ends_with('…'));
        assert!(result.chars().count() <= DETAIL_MAX_CHARS + 1);
        assert_eq!(first_paragraph("\n\nDecided X.\n\nThen Y."), "Decided X.");
    }
}
