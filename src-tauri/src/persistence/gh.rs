use rusqlite::{Connection, OptionalExtension, Row};
use serde::Serialize;
use specta::Type;

use super::sqlite_error;
use super::time::now_iso;
use crate::error::{ArgmaxError, ArgmaxResult};

pub const SESSION_PR_EVIDENCE_PARSER_VERSION: i64 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrAttribution {
    Explicit,
    Inferred,
}

impl PrAttribution {
    fn as_str(self) -> &'static str {
        match self {
            Self::Explicit => "explicit",
            Self::Inferred => "inferred",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GhPrRecord {
    /// The session that observed this PR.
    pub session_id: String,
    pub pr_number: i64,
    pub head_sha: String,
    pub last_seen_check_state: String,
    pub updated_at: String,
    pub pr_state: Option<String>,
    pub notified_at: Option<String>,
    /// GitHub's authoritative PR creation timestamp.
    pub pr_created_at: Option<String>,
    /// GitHub's authoritative merge timestamp. Null until the PR is merged.
    pub pr_merged_at: Option<String>,
    /// Branch the PR was opened from, per `gh pr view --json headRefName`.
    /// Legacy rows without a branch retain a fallback on isolated workspaces.
    pub head_ref_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionPrSummary {
    pub session_id: String,
    pub pr_number: i64,
    pub url: Option<String>,
    pub title: Option<String>,
    pub pr_state: Option<String>,
    pub head_ref_name: Option<String>,
    pub relationship: String,
    pub activity_at: String,
    pub updated_at: String,
    pub check_state: String,
    pub is_primary: bool,
    pub is_pinned: bool,
    pub refresh_error: Option<String>,
}

/// All non-dismissed PRs linked to a session. The first row is the stable
/// primary: a user pin wins, then open worked PRs, then terminal worked PRs,
/// and finally referenced or unverified history. Refresh timestamps never
/// participate in this order.
pub fn list_session_prs(
    connection: &Connection,
    session_id: &str,
) -> ArgmaxResult<Vec<SessionPrSummary>> {
    let mut statement = connection
        .prepare_cached(
            r#"
            SELECT links.session_id,
                   links.pr_number,
                   prs.url,
                   prs.title,
                   prs.pr_state,
                   prs.head_ref_name,
                   links.relationship,
                   links.activity_at,
                   prs.updated_at,
                   prs.last_seen_check_state,
                   links.is_pinned,
                   prs.refresh_error
            FROM session_pr_links links
            JOIN gh_pull_requests prs
              ON prs.project_id = links.project_id
             AND prs.pr_number = links.pr_number
            WHERE links.session_id = ?1
              AND links.dismissed_at IS NULL
            ORDER BY
              links.is_pinned DESC,
              CASE
                WHEN links.relationship = 'worked'
                  AND (prs.pr_state IS NULL OR prs.pr_state = 'OPEN') THEN 0
                WHEN links.relationship = 'worked' THEN 1
                WHEN links.relationship = 'referenced' THEN 2
                ELSE 3
              END,
              links.activity_at DESC,
              links.pr_number DESC
            "#,
        )
        .map_err(sqlite_error)?;
    let mut rows = statement
        .query_map([session_id], |row| {
            Ok(SessionPrSummary {
                session_id: row.get(0)?,
                pr_number: row.get(1)?,
                url: row.get(2)?,
                title: row.get(3)?,
                pr_state: row.get(4)?,
                head_ref_name: row.get(5)?,
                relationship: row.get(6)?,
                activity_at: row.get(7)?,
                updated_at: row.get(8)?,
                check_state: row.get(9)?,
                is_primary: false,
                is_pinned: row.get::<_, i64>(10)? != 0,
                refresh_error: row.get(11)?,
            })
        })
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    if let Some(primary) = rows
        .iter_mut()
        .find(|row| row.is_pinned || row.relationship != "unverified")
    {
        primary.is_primary = true;
    }
    Ok(rows)
}

pub fn set_session_pr_selection(
    connection: &Connection,
    session_id: &str,
    pr_number: Option<i64>,
) -> ArgmaxResult<()> {
    if pr_number.is_some_and(|number| number <= 0) {
        return Err(ArgmaxError::service(
            "GH_PR_NUMBER_INVALID",
            "pull request number must be positive",
        ));
    }
    project_for_session(connection, session_id)?;
    let transaction = connection.unchecked_transaction().map_err(sqlite_error)?;
    transaction
        .prepare_cached("UPDATE session_pr_links SET is_pinned = 0 WHERE session_id = ?1")
        .map_err(sqlite_error)?
        .execute([session_id])
        .map_err(sqlite_error)?;
    if let Some(pr_number) = pr_number {
        let timestamp = now_iso();
        let changed = transaction
            .prepare_cached(
                r#"
                UPDATE session_pr_links
                SET is_pinned = 1, updated_at = ?3
                WHERE session_id = ?1 AND pr_number = ?2 AND dismissed_at IS NULL
                "#,
            )
            .map_err(sqlite_error)?
            .execute((session_id, pr_number, timestamp.as_str()))
            .map_err(sqlite_error)?;
        if changed == 0 {
            return Err(ArgmaxError::record_not_found(
                "session pull request",
                format!("{session_id}:{pr_number}"),
            ));
        }
        // Choosing an imported/legacy candidate confirms that it belongs in
        // this session's history, but it does not prove the session worked on
        // it. Keep automation gated on separate `worked` evidence.
        let project_id: String = transaction
            .prepare_cached(
                "SELECT project_id FROM session_pr_links WHERE session_id = ?1 AND pr_number = ?2",
            )
            .map_err(sqlite_error)?
            .query_row((session_id, pr_number), |row| row.get(0))
            .map_err(sqlite_error)?;
        let source_id = format!("user-select:{session_id}:{pr_number}");
        transaction
            .prepare_cached(
                r#"
                INSERT OR IGNORE INTO session_pr_evidence (
                  session_id, project_id, pr_number, relationship, source_id,
                  occurred_at, created_at
                ) VALUES (?1, ?2, ?3, 'referenced', ?4, ?5, ?5)
                "#,
            )
            .map_err(sqlite_error)?
            .execute((
                session_id,
                project_id,
                pr_number,
                source_id,
                timestamp.as_str(),
            ))
            .map_err(sqlite_error)?;
        transaction
            .prepare_cached(
                r#"
                UPDATE session_pr_links
                SET relationship = 'referenced', activity_at = MAX(activity_at, ?3)
                WHERE session_id = ?1 AND pr_number = ?2
                  AND relationship = 'unverified'
                "#,
            )
            .map_err(sqlite_error)?
            .execute((session_id, pr_number, timestamp))
            .map_err(sqlite_error)?;
    }
    transaction.commit().map_err(sqlite_error)
}

pub fn dismiss_session_pr(
    connection: &Connection,
    session_id: &str,
    pr_number: i64,
) -> ArgmaxResult<()> {
    if pr_number <= 0 {
        return Err(ArgmaxError::service(
            "GH_PR_NUMBER_INVALID",
            "pull request number must be positive",
        ));
    }
    let timestamp = now_iso();
    let changed = connection
        .prepare_cached(
            r#"
            UPDATE session_pr_links
            SET dismissed_at = ?3, is_pinned = 0, updated_at = ?3
            WHERE session_id = ?1 AND pr_number = ?2
            "#,
        )
        .map_err(sqlite_error)?
        .execute((session_id, pr_number, timestamp))
        .map_err(sqlite_error)?;
    if changed == 0 {
        return Err(ArgmaxError::record_not_found(
            "session pull request",
            format!("{session_id}:{pr_number}"),
        ));
    }
    Ok(())
}

pub fn record_session_pr_evidence(
    connection: &Connection,
    session_id: &str,
    pr_number: i64,
    relationship: &str,
    source_id: &str,
    occurred_at: &str,
) -> ArgmaxResult<()> {
    if !matches!(relationship, "worked" | "referenced" | "unverified") {
        return Err(ArgmaxError::service(
            "GH_PR_RELATIONSHIP_INVALID",
            format!("invalid PR relationship: {relationship}"),
        ));
    }
    if source_id.is_empty() || occurred_at.is_empty() || pr_number <= 0 {
        return Err(ArgmaxError::service(
            "GH_PR_EVIDENCE_INVALID",
            "PR evidence requires a positive number, source id, and timestamp",
        ));
    }
    let project_id = project_for_session(connection, session_id)?;
    let transaction = connection.unchecked_transaction().map_err(sqlite_error)?;
    ensure_canonical_pr(&transaction, &project_id, pr_number, occurred_at)?;
    record_session_pr_evidence_inner(
        &transaction,
        session_id,
        &project_id,
        pr_number,
        relationship,
        source_id,
        occurred_at,
    )?;
    transaction.commit().map_err(sqlite_error)
}

fn record_session_pr_evidence_inner(
    connection: &Connection,
    session_id: &str,
    project_id: &str,
    pr_number: i64,
    relationship: &str,
    source_id: &str,
    occurred_at: &str,
) -> ArgmaxResult<()> {
    let recorded_at = now_iso();
    let inserted = connection
        .prepare_cached(
            r#"
            INSERT INTO session_pr_evidence (
              session_id, project_id, pr_number, relationship, source_id,
              occurred_at, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(session_id, pr_number, source_id) DO UPDATE SET
              relationship = excluded.relationship
            WHERE CASE excluded.relationship
                    WHEN 'worked' THEN 2 WHEN 'referenced' THEN 1 ELSE 0 END
                  > CASE session_pr_evidence.relationship
                    WHEN 'worked' THEN 2 WHEN 'referenced' THEN 1 ELSE 0 END
            "#,
        )
        .map_err(sqlite_error)?
        .execute((
            session_id,
            project_id,
            pr_number,
            relationship,
            source_id,
            occurred_at,
            &recorded_at,
        ))
        .map_err(sqlite_error)?;
    if inserted != 0 {
        connection
            .prepare_cached(
                r#"
                INSERT INTO session_pr_links (
                  session_id, project_id, pr_number, relationship, activity_at,
                  created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
                ON CONFLICT(session_id, pr_number) DO UPDATE SET
                  relationship = CASE
                    WHEN session_pr_links.relationship = 'worked' THEN 'worked'
                    WHEN excluded.relationship = 'worked' THEN 'worked'
                    WHEN session_pr_links.relationship = 'referenced' THEN 'referenced'
                    ELSE excluded.relationship
                  END,
                  activity_at = CASE
                    WHEN session_pr_links.relationship = 'worked'
                      AND excluded.relationship != 'worked'
                    THEN session_pr_links.activity_at
                    WHEN session_pr_links.relationship != 'worked'
                      AND excluded.relationship = 'worked'
                    THEN excluded.activity_at
                    WHEN session_pr_links.relationship = 'referenced'
                      AND excluded.relationship = 'unverified'
                    THEN session_pr_links.activity_at
                    WHEN session_pr_links.relationship = 'unverified'
                      AND excluded.relationship = 'referenced'
                    THEN excluded.activity_at
                    ELSE MAX(session_pr_links.activity_at, excluded.activity_at)
                  END,
                  updated_at = excluded.updated_at
                "#,
            )
            .map_err(sqlite_error)?
            .execute((
                session_id,
                project_id,
                pr_number,
                relationship,
                occurred_at,
                recorded_at,
            ))
            .map_err(sqlite_error)?;
    }
    Ok(())
}

pub fn store_pr_metadata(
    connection: &Connection,
    session_id: &str,
    pr_number: i64,
    url: Option<&str>,
    title: Option<&str>,
) -> ArgmaxResult<()> {
    let project_id = project_for_session(connection, session_id)?;
    ensure_canonical_pr(connection, &project_id, pr_number, &now_iso())?;
    connection
        .prepare_cached(
            r#"
            UPDATE gh_pull_requests
            SET url = COALESCE(?3, url),
                title = COALESCE(?4, title)
            WHERE project_id = ?1 AND pr_number = ?2
            "#,
        )
        .map_err(sqlite_error)?
        .execute((project_id, pr_number, url, title))
        .map_err(sqlite_error)?;
    Ok(())
}

fn project_for_session(connection: &Connection, session_id: &str) -> ArgmaxResult<String> {
    connection
        .prepare_cached(
            r#"
            SELECT workspaces.project_id
            FROM sessions
            JOIN workspaces ON workspaces.id = sessions.workspace_id
            WHERE sessions.id = ?1
            "#,
        )
        .map_err(sqlite_error)?
        .query_row([session_id], |row| row.get(0))
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => {
                ArgmaxError::record_not_found("session", session_id)
            }
            other => sqlite_error(other),
        })
}

fn ensure_canonical_pr(
    connection: &Connection,
    project_id: &str,
    pr_number: i64,
    timestamp: &str,
) -> ArgmaxResult<()> {
    connection
        .prepare_cached(
            r#"
            INSERT OR IGNORE INTO gh_pull_requests (
              project_id, pr_number, refreshed_at, updated_at
            ) VALUES (?1, ?2, ?3, ?3)
            "#,
        )
        .map_err(sqlite_error)?
        .execute((project_id, pr_number, timestamp))
        .map_err(sqlite_error)?;
    Ok(())
}

/// Record one GitHub observation and, when its provenance is trustworthy,
/// associate it with the observing session. GitHub-owned fields fan out to
/// every existing row for this PR in the same project, even when a new
/// inferred association is rejected. This keeps merge state coherent without
/// allowing a shared checkout's later HEAD to rewrite session history.
pub fn record_gh_pr_observation(
    connection: &Connection,
    input: &GhPrRecord,
    attribution: PrAttribution,
) -> ArgmaxResult<Option<GhPrRecord>> {
    let context = session_pr_context(connection, &input.session_id)?;
    let transaction = connection.unchecked_transaction().map_err(sqlite_error)?;
    let effective_input = effective_project_pr_record(&transaction, &context.project_id, input)?;

    upsert_canonical_pr(&transaction, &context.project_id, &effective_input)?;
    sync_project_pr_rows(&transaction, &context.project_id, &effective_input)?;

    let existing_attribution = transaction
        .prepare_cached("SELECT attribution FROM gh_pr WHERE session_id = ? AND pr_number = ?")
        .map_err(sqlite_error)?
        .query_row((input.session_id.as_str(), input.pr_number), |row| {
            row.get::<_, String>(0)
        })
        .optional()
        .map_err(sqlite_error)?;

    let accepted_attribution = match (attribution, existing_attribution.as_deref()) {
        (PrAttribution::Explicit, _) => Some("explicit"),
        (PrAttribution::Inferred, Some("explicit")) => Some("explicit"),
        (PrAttribution::Inferred, Some("inferred")) => Some("inferred"),
        // A cached refresh carries no new attribution evidence. In particular,
        // it must not launder a pre-v37 shared row into a trusted association.
        (PrAttribution::Inferred, Some("legacy"))
            if !context.shared_workspace
                && inferred_association_is_eligible(&transaction, &context, &effective_input)? =>
        {
            Some("inferred")
        }
        (PrAttribution::Inferred, Some("legacy")) => None,
        (PrAttribution::Inferred, None)
            if inferred_association_is_eligible(&transaction, &context, &effective_input)? =>
        {
            Some(attribution.as_str())
        }
        (PrAttribution::Inferred, None) => None,
        (PrAttribution::Inferred, Some(_)) => None,
    };

    let result = if let Some(stored_attribution) = accepted_attribution {
        upsert_gh_pr_with_attribution(&transaction, &effective_input, stored_attribution)?;
        let relationship = match (context.shared_workspace, attribution) {
            (false, PrAttribution::Inferred) => "worked",
            (true, PrAttribution::Inferred) => "unverified",
            (_, PrAttribution::Explicit) => "referenced",
        };
        let source_id = format!(
            "observation:{}:{}:{}",
            input.session_id, input.pr_number, relationship
        );
        record_session_pr_evidence_inner(
            &transaction,
            &input.session_id,
            &context.project_id,
            input.pr_number,
            relationship,
            &source_id,
            &input.updated_at,
        )?;
        find_gh_pr(&transaction, &input.session_id, input.pr_number)?
    } else {
        None
    };
    transaction.commit().map_err(sqlite_error)?;
    Ok(result)
}

/// Update canonical GitHub state without creating or promoting a session
/// association. Number-based refreshes use this path because seeing a PR is
/// metadata, not evidence that the session worked on it.
pub fn store_gh_pr_observation(connection: &Connection, input: &GhPrRecord) -> ArgmaxResult<()> {
    let context = session_pr_context(connection, &input.session_id)?;
    let transaction = connection.unchecked_transaction().map_err(sqlite_error)?;
    let effective_input = effective_project_pr_record(&transaction, &context.project_id, input)?;
    upsert_canonical_pr(&transaction, &context.project_id, &effective_input)?;
    sync_project_pr_rows(&transaction, &context.project_id, &effective_input)?;
    transaction.commit().map_err(sqlite_error)
}

fn effective_project_pr_record(
    connection: &Connection,
    project_id: &str,
    input: &GhPrRecord,
) -> ArgmaxResult<GhPrRecord> {
    let (has_existing_merge, existing_merged_at) = connection
        .prepare_cached(
            r#"
            SELECT EXISTS (
              SELECT 1
              FROM gh_pull_requests
              WHERE project_id = ?1
                AND pr_number = ?2
                AND pr_state = 'MERGED'
              UNION ALL
              SELECT 1
              FROM gh_pr
              JOIN sessions ON sessions.id = gh_pr.session_id
              JOIN workspaces ON workspaces.id = sessions.workspace_id
              WHERE workspaces.project_id = ?1
                AND gh_pr.pr_number = ?2
                AND gh_pr.pr_state = 'MERGED'
            ), (
              SELECT MAX(pr_merged_at) FROM (
                SELECT pr_merged_at
                FROM gh_pull_requests
                WHERE project_id = ?1 AND pr_number = ?2 AND pr_state = 'MERGED'
                UNION ALL
                SELECT gh_pr.pr_merged_at
                FROM gh_pr
                JOIN sessions ON sessions.id = gh_pr.session_id
                JOIN workspaces ON workspaces.id = sessions.workspace_id
                WHERE workspaces.project_id = ?1
                  AND gh_pr.pr_number = ?2
                  AND gh_pr.pr_state = 'MERGED'
              )
            )
            "#,
        )
        .map_err(sqlite_error)?
        .query_row((project_id, input.pr_number), |row| {
            Ok((row.get::<_, bool>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(sqlite_error)?;
    if input.pr_state.as_deref() != Some("MERGED") && !has_existing_merge {
        return Ok(input.clone());
    }

    let mut effective = input.clone();
    effective.pr_state = Some("MERGED".to_owned());
    effective.pr_merged_at = input.pr_merged_at.clone().or(existing_merged_at);
    Ok(effective)
}

fn upsert_canonical_pr(
    connection: &Connection,
    project_id: &str,
    input: &GhPrRecord,
) -> ArgmaxResult<()> {
    connection
        .prepare_cached(
            r#"
            INSERT INTO gh_pull_requests (
              project_id, pr_number, head_sha, last_seen_check_state, pr_state,
              head_ref_name, pr_created_at, pr_merged_at, refreshed_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
            ON CONFLICT(project_id, pr_number) DO UPDATE SET
              updated_at = CASE WHEN
                gh_pull_requests.head_sha IS NOT excluded.head_sha
                OR gh_pull_requests.last_seen_check_state IS NOT excluded.last_seen_check_state
                OR gh_pull_requests.pr_state IS NOT
                   CASE WHEN gh_pull_requests.pr_state = 'MERGED' THEN 'MERGED' ELSE excluded.pr_state END
                OR (excluded.head_ref_name IS NOT NULL
                    AND gh_pull_requests.head_ref_name IS NOT excluded.head_ref_name)
                OR (excluded.pr_created_at IS NOT NULL
                    AND gh_pull_requests.pr_created_at IS NOT excluded.pr_created_at)
                OR (excluded.pr_merged_at IS NOT NULL
                    AND gh_pull_requests.pr_merged_at IS NOT excluded.pr_merged_at)
              THEN excluded.refreshed_at ELSE gh_pull_requests.updated_at END,
              head_sha = excluded.head_sha,
              last_seen_check_state = excluded.last_seen_check_state,
              pr_state = CASE
                WHEN gh_pull_requests.pr_state = 'MERGED' THEN 'MERGED'
                ELSE excluded.pr_state
              END,
              head_ref_name = COALESCE(excluded.head_ref_name, gh_pull_requests.head_ref_name),
              pr_created_at = COALESCE(excluded.pr_created_at, gh_pull_requests.pr_created_at),
              pr_merged_at = COALESCE(excluded.pr_merged_at, gh_pull_requests.pr_merged_at),
              refreshed_at = excluded.refreshed_at,
              refresh_error = NULL
            "#,
        )
        .map_err(sqlite_error)?
        .execute((
            project_id,
            input.pr_number,
            input.head_sha.as_str(),
            input.last_seen_check_state.as_str(),
            input.pr_state.as_deref(),
            input.head_ref_name.as_deref(),
            input.pr_created_at.as_deref(),
            input.pr_merged_at.as_deref(),
            input.updated_at.as_str(),
        ))
        .map_err(sqlite_error)?;
    Ok(())
}

pub fn record_pr_refresh_error(
    connection: &Connection,
    session_id: &str,
    pr_number: i64,
    error: &str,
) -> ArgmaxResult<()> {
    let project_id = project_for_session(connection, session_id)?;
    let timestamp = now_iso();
    ensure_canonical_pr(connection, &project_id, pr_number, &timestamp)?;
    connection
        .prepare_cached(
            r#"
            UPDATE gh_pull_requests
            SET refreshed_at = ?3, refresh_error = ?4
            WHERE project_id = ?1 AND pr_number = ?2
            "#,
        )
        .map_err(sqlite_error)?
        .execute((project_id, pr_number, timestamp, error))
        .map_err(sqlite_error)?;
    Ok(())
}

/// The branch trusted for attributing a new inferred PR observation.
/// Isolated workspaces own their branch, so their current branch is reliable.
/// Shared checkouts use only the branch captured while this session was active.
pub fn pr_branch_for_session(
    connection: &Connection,
    session_id: &str,
) -> ArgmaxResult<Option<String>> {
    let context = session_pr_context(connection, session_id)?;
    Ok(context.trusted_branch)
}

pub fn upsert_gh_pr(connection: &Connection, input: &GhPrRecord) -> ArgmaxResult<GhPrRecord> {
    store_gh_pr_observation(connection, input)?;
    upsert_gh_pr_with_attribution(connection, input, "legacy")?;
    find_gh_pr(connection, &input.session_id, input.pr_number)
        .map(|row| row.unwrap_or(input.clone()))
}

fn upsert_gh_pr_with_attribution(
    connection: &Connection,
    input: &GhPrRecord,
    attribution: &str,
) -> ArgmaxResult<()> {
    // Reset notified_at when head_sha rotates so a new commit is treated
    // as a fresh notification target; preserve it on a same-sha update so
    // unrelated metadata changes don't replay the notification.
    let mut statement = connection
        .prepare_cached(
            r#"
        INSERT INTO gh_pr (
          session_id, pr_number, head_sha, last_seen_check_state, updated_at,
          pr_state, head_ref_name, pr_created_at, pr_merged_at, attribution
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, pr_number) DO UPDATE SET
          head_sha = excluded.head_sha,
          last_seen_check_state = excluded.last_seen_check_state,
          updated_at = excluded.updated_at,
          pr_state = CASE
            WHEN gh_pr.pr_state = 'MERGED' THEN 'MERGED'
            ELSE excluded.pr_state
          END,
          head_ref_name = COALESCE(excluded.head_ref_name, gh_pr.head_ref_name),
          pr_created_at = COALESCE(excluded.pr_created_at, gh_pr.pr_created_at),
          pr_merged_at = COALESCE(excluded.pr_merged_at, gh_pr.pr_merged_at),
          attribution = CASE
            WHEN gh_pr.attribution = 'explicit' THEN 'explicit'
            ELSE excluded.attribution
          END,
          notified_at = CASE
            WHEN excluded.head_sha = gh_pr.head_sha THEN gh_pr.notified_at
            ELSE NULL
          END
        "#,
        )
        .map_err(sqlite_error)?;
    statement
        .execute((
            input.session_id.as_str(),
            input.pr_number,
            input.head_sha.as_str(),
            input.last_seen_check_state.as_str(),
            input.updated_at.as_str(),
            input.pr_state.as_deref(),
            input.head_ref_name.as_deref(),
            input.pr_created_at.as_deref(),
            input.pr_merged_at.as_deref(),
            attribution,
        ))
        .map_err(sqlite_error)?;
    Ok(())
}

#[derive(Debug)]
struct SessionPrContext {
    project_id: String,
    shared_workspace: bool,
    state: String,
    completed_at: Option<String>,
    trusted_branch: Option<String>,
}

fn session_pr_context(connection: &Connection, session_id: &str) -> ArgmaxResult<SessionPrContext> {
    let mut statement = connection
        .prepare_cached(
            r#"
            SELECT workspaces.project_id,
                   workspaces.shared_workspace,
                   sessions.state,
                   sessions.completed_at,
                   CASE
                     WHEN workspaces.shared_workspace = 0 THEN NULLIF(workspaces.branch, '')
                     ELSE COALESCE(sessions.pr_branch_last_active, sessions.pr_branch_at_start)
                   END AS trusted_branch
            FROM sessions
            JOIN workspaces ON workspaces.id = sessions.workspace_id
            WHERE sessions.id = ?
            "#,
        )
        .map_err(sqlite_error)?;
    match statement.query_row([session_id], |row| {
        Ok(SessionPrContext {
            project_id: row.get("project_id")?,
            shared_workspace: row.get::<_, i64>("shared_workspace")? != 0,
            state: row.get("state")?,
            completed_at: row.get("completed_at")?,
            trusted_branch: row.get("trusted_branch")?,
        })
    }) {
        Ok(context) => Ok(context),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(ArgmaxError::record_not_found("session", session_id))
        }
        Err(error) => Err(sqlite_error(error)),
    }
}

fn inferred_association_is_eligible(
    connection: &Connection,
    context: &SessionPrContext,
    input: &GhPrRecord,
) -> ArgmaxResult<bool> {
    let branch_matches = context
        .trusted_branch
        .as_deref()
        .zip(input.head_ref_name.as_deref())
        .is_some_and(|(trusted, head)| trusted == head);
    if !branch_matches {
        return Ok(false);
    }
    if !context.shared_workspace {
        return Ok(true);
    }

    let is_active = matches!(context.state.as_str(), "running" | "waiting" | "blocked");
    if is_active {
        return Ok(true);
    }

    let Some(completed_at) = context.completed_at.as_deref() else {
        return Ok(false);
    };
    let Some(pr_created_at) = input.pr_created_at.as_deref() else {
        return Ok(false);
    };
    connection
        .query_row(
            r#"
            SELECT julianday(?1) IS NOT NULL
               AND julianday(?2) IS NOT NULL
               AND julianday(?1) <= julianday(?2)
            "#,
            (pr_created_at, completed_at),
            |row| row.get::<_, bool>(0),
        )
        .map_err(sqlite_error)
}

fn sync_project_pr_rows(
    connection: &Connection,
    project_id: &str,
    input: &GhPrRecord,
) -> ArgmaxResult<()> {
    connection
        .prepare_cached(
            r#"
            UPDATE gh_pr
            SET head_sha = ?1,
                last_seen_check_state = ?2,
                updated_at = ?3,
                pr_state = CASE
                  WHEN gh_pr.pr_state = 'MERGED' THEN 'MERGED'
                  ELSE ?4
                END,
                head_ref_name = COALESCE(?5, gh_pr.head_ref_name),
                pr_created_at = COALESCE(?6, gh_pr.pr_created_at),
                pr_merged_at = COALESCE(?7, gh_pr.pr_merged_at),
                notified_at = CASE WHEN gh_pr.head_sha = ?1 THEN gh_pr.notified_at ELSE NULL END
            WHERE gh_pr.pr_number = ?8
              AND gh_pr.session_id IN (
                SELECT sessions.id
                FROM sessions
                JOIN workspaces ON workspaces.id = sessions.workspace_id
                WHERE workspaces.project_id = ?9
              )
            "#,
        )
        .map_err(sqlite_error)?
        .execute((
            input.head_sha.as_str(),
            input.last_seen_check_state.as_str(),
            input.updated_at.as_str(),
            input.pr_state.as_deref(),
            input.head_ref_name.as_deref(),
            input.pr_created_at.as_deref(),
            input.pr_merged_at.as_deref(),
            input.pr_number,
            project_id,
        ))
        .map_err(sqlite_error)?;
    Ok(())
}

pub fn list_gh_pr_for_session(
    connection: &Connection,
    session_id: &str,
) -> ArgmaxResult<Vec<GhPrRecord>> {
    let mut statement = connection
        .prepare_cached(
            r#"
            SELECT links.session_id,
                   links.pr_number,
                   prs.head_sha,
                   prs.last_seen_check_state,
                   prs.updated_at,
                   prs.pr_state,
                   COALESCE(
                     CASE WHEN links.notified_head_sha = prs.head_sha THEN links.notified_at END,
                     legacy.notified_at
                   ),
                   prs.pr_created_at,
                   prs.pr_merged_at,
                   prs.head_ref_name
            FROM session_pr_links links
            JOIN gh_pull_requests prs
              ON prs.project_id = links.project_id
             AND prs.pr_number = links.pr_number
            LEFT JOIN gh_pr legacy
              ON legacy.session_id = links.session_id
             AND legacy.pr_number = links.pr_number
            WHERE links.session_id = ?1
              AND links.dismissed_at IS NULL
            ORDER BY links.pr_number ASC
            "#,
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([session_id], |row| {
            Ok(GhPrRecord {
                session_id: row.get(0)?,
                pr_number: row.get(1)?,
                head_sha: row.get(2)?,
                last_seen_check_state: row.get(3)?,
                updated_at: row.get(4)?,
                pr_state: row.get(5)?,
                notified_at: row.get(6)?,
                pr_created_at: row.get(7)?,
                pr_merged_at: row.get(8)?,
                head_ref_name: row.get(9)?,
            })
        })
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    if !rows.is_empty() {
        return Ok(rows);
    }
    list_legacy_gh_pr_for_session(connection, session_id)
}

/// Read canonical GitHub state by session project and PR number, independent
/// of whether that session currently displays or has dismissed the PR.
pub fn find_canonical_pr_for_session(
    connection: &Connection,
    session_id: &str,
    pr_number: i64,
) -> ArgmaxResult<Option<GhPrRecord>> {
    let project_id = project_for_session(connection, session_id)?;
    let mut statement = connection
        .prepare_cached(
            r#"
            SELECT ?1 AS session_id,
                   prs.pr_number,
                   prs.head_sha,
                   prs.last_seen_check_state,
                   prs.updated_at,
                   prs.pr_state,
                   COALESCE(
                     CASE WHEN links.notified_head_sha = prs.head_sha THEN links.notified_at END,
                     legacy.notified_at
                   ),
                   prs.pr_created_at,
                   prs.pr_merged_at,
                   prs.head_ref_name
            FROM gh_pull_requests prs
            LEFT JOIN session_pr_links links
              ON links.session_id = ?1
             AND links.project_id = prs.project_id
             AND links.pr_number = prs.pr_number
            LEFT JOIN gh_pr legacy
              ON legacy.session_id = ?1 AND legacy.pr_number = prs.pr_number
            WHERE prs.project_id = ?2 AND prs.pr_number = ?3
            "#,
        )
        .map_err(sqlite_error)?;
    match statement.query_row((session_id, project_id, pr_number), |row| {
        Ok(GhPrRecord {
            session_id: row.get(0)?,
            pr_number: row.get(1)?,
            head_sha: row.get(2)?,
            last_seen_check_state: row.get(3)?,
            updated_at: row.get(4)?,
            pr_state: row.get(5)?,
            notified_at: row.get(6)?,
            pr_created_at: row.get(7)?,
            pr_merged_at: row.get(8)?,
            head_ref_name: row.get(9)?,
        })
    }) {
        Ok(record) => Ok(Some(record)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(sqlite_error(error)),
    }
}

/// Refreshable PRs for a session, oldest attempted refresh first. Both
/// successful and failed attempts update `refreshed_at`, so a bounded caller
/// eventually rotates through every association instead of retrying the same
/// first page forever.
pub fn list_refreshable_pr_numbers_for_session(
    connection: &Connection,
    session_id: &str,
) -> ArgmaxResult<Vec<i64>> {
    let mut statement = connection
        .prepare_cached(
            r#"
            SELECT links.pr_number
            FROM session_pr_links links
            JOIN gh_pull_requests prs
              ON prs.project_id = links.project_id
             AND prs.pr_number = links.pr_number
            WHERE links.session_id = ?1
              AND links.dismissed_at IS NULL
              AND (prs.pr_state IS NULL OR prs.pr_state != 'MERGED')
            ORDER BY prs.refreshed_at ASC, links.pr_number ASC
            "#,
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([session_id], |row| row.get(0))
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

fn list_legacy_gh_pr_for_session(
    connection: &Connection,
    session_id: &str,
) -> ArgmaxResult<Vec<GhPrRecord>> {
    let mut statement = connection
        .prepare_cached(
            r#"
            SELECT gh_pr.*
            FROM gh_pr
            JOIN sessions ON sessions.id = gh_pr.session_id
            JOIN workspaces ON workspaces.id = sessions.workspace_id
            WHERE gh_pr.session_id = ?
              AND (
                workspaces.shared_workspace = 0
                OR gh_pr.attribution = 'explicit'
                OR (
                  gh_pr.attribution = 'inferred'
                  AND (
                    sessions.state IN ('running', 'waiting', 'blocked')
                    OR (
                      sessions.completed_at IS NOT NULL
                      AND gh_pr.pr_created_at IS NOT NULL
                      AND julianday(sessions.completed_at) IS NOT NULL
                      AND julianday(gh_pr.pr_created_at) IS NOT NULL
                      AND julianday(gh_pr.pr_created_at) <= julianday(sessions.completed_at)
                    )
                  )
                )
              )
            ORDER BY gh_pr.pr_number ASC
            "#,
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([session_id], row_to_gh_pr)
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

/// Sessions the poller should keep asking `gh` about: an open (or not yet
/// classified) PR whose workspace is still live. Archived workspaces are
/// excluded — their worktree is gone, so every poll fails and `pr_state`
/// never advances past OPEN, which would keep the row in this set forever.
pub fn list_open_gh_pr_session_ids(connection: &Connection) -> ArgmaxResult<Vec<String>> {
    let mut statement = connection
        .prepare_cached(
            r#"
        SELECT DISTINCT links.session_id AS id
        FROM session_pr_links links
        JOIN gh_pull_requests prs
          ON prs.project_id = links.project_id AND prs.pr_number = links.pr_number
        JOIN sessions ON sessions.id = links.session_id
        JOIN workspaces ON workspaces.id = sessions.workspace_id
        WHERE (prs.pr_state IS NULL OR prs.pr_state != 'MERGED')
          AND links.relationship != 'unverified'
          AND links.dismissed_at IS NULL
          AND workspaces.state NOT IN ('archiving', 'archive-failed', 'archived')
        UNION
        SELECT DISTINCT gh_pr.session_id AS id
        FROM gh_pr
        JOIN sessions ON sessions.id = gh_pr.session_id
        JOIN workspaces ON workspaces.id = sessions.workspace_id
        WHERE (gh_pr.pr_state IS NULL OR gh_pr.pr_state = 'OPEN')
          AND (
            workspaces.shared_workspace = 0
            OR gh_pr.attribution = 'explicit'
            OR (
              gh_pr.attribution = 'inferred'
              AND (
                sessions.state IN ('running', 'waiting', 'blocked')
                OR (
                  sessions.completed_at IS NOT NULL
                  AND gh_pr.pr_created_at IS NOT NULL
                  AND julianday(sessions.completed_at) IS NOT NULL
                  AND julianday(gh_pr.pr_created_at) IS NOT NULL
                  AND julianday(gh_pr.pr_created_at) <= julianday(sessions.completed_at)
                )
              )
            )
          )
          AND workspaces.state NOT IN ('archiving', 'archive-failed', 'archived')
          AND NOT EXISTS (
            SELECT 1 FROM session_pr_links links
            WHERE links.session_id = gh_pr.session_id
              AND links.pr_number = gh_pr.pr_number
          )
        "#,
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>("id"))
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

/// Legacy associations need one evidence replay after v49. The scan ledger
/// keeps the poller from retrying sessions whose historical events contain no
/// stronger evidence.
pub fn list_session_ids_needing_pr_evidence_repair(
    connection: &Connection,
    limit: usize,
) -> ArgmaxResult<Vec<String>> {
    let mut statement = connection
        .prepare_cached(
            r#"
            SELECT DISTINCT links.session_id
            FROM session_pr_links links
            JOIN sessions ON sessions.id = links.session_id
            JOIN workspaces ON workspaces.id = sessions.workspace_id
            JOIN projects ON projects.id = workspaces.project_id
            LEFT JOIN session_pr_evidence_scans scans ON scans.session_id = links.session_id
            WHERE links.relationship = 'unverified'
              AND links.dismissed_at IS NULL
              AND (scans.session_id IS NULL OR scans.parser_version < ?2)
              AND projects.repo_remote_owner IS NOT NULL
              AND projects.repo_remote_name IS NOT NULL
              AND workspaces.state NOT IN ('archiving', 'archived')
            ORDER BY sessions.last_activity_at DESC, links.session_id DESC
            LIMIT ?1
            "#,
        )
        .map_err(sqlite_error)?;
    let session_ids = statement
        .query_map((limit as i64, SESSION_PR_EVIDENCE_PARSER_VERSION), |row| {
            row.get::<_, String>(0)
        })
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(session_ids)
}

/// Whether any session in this workspace has already fired the check-failure
/// follow-up for this PR at this commit.
///
/// The guard has to span the workspace, not the observing session: the
/// follow-up is itself a session in the same checkout on the same branch, so
/// it observes the same PR on the next tick. Keyed per session, every launch
/// would add a new observer and the launches would double every tick — and
/// each one runs an agent in the checkout the others are already editing.
pub fn check_failure_launched_in_workspace(
    connection: &Connection,
    workspace_id: &str,
    pr_number: i64,
    head_sha: &str,
) -> ArgmaxResult<bool> {
    let mut statement = connection
        .prepare_cached(
            r#"
        SELECT 1 FROM (
          SELECT links.session_id
          FROM session_pr_links links
          JOIN sessions ON sessions.id = links.session_id
          JOIN gh_pull_requests prs
            ON prs.project_id = links.project_id
           AND prs.pr_number = links.pr_number
          WHERE sessions.workspace_id = ?1
            AND links.pr_number = ?2
            AND prs.head_sha = ?3
            AND links.notified_head_sha = ?3
            AND links.notified_at IS NOT NULL
          UNION ALL
          SELECT gh_pr.session_id
          FROM gh_pr
          JOIN sessions ON sessions.id = gh_pr.session_id
          JOIN workspaces ON workspaces.id = sessions.workspace_id
          WHERE sessions.workspace_id = ?1
            AND gh_pr.pr_number = ?2
            AND gh_pr.head_sha = ?3
            AND gh_pr.notified_at IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM session_pr_links links
              WHERE links.session_id = gh_pr.session_id
                AND links.pr_number = gh_pr.pr_number
            )
            AND (
              workspaces.shared_workspace = 0
              OR gh_pr.attribution = 'explicit'
              OR (
                gh_pr.attribution = 'inferred'
                AND (
                  sessions.state IN ('running', 'waiting', 'blocked')
                  OR (
                    sessions.completed_at IS NOT NULL
                    AND gh_pr.pr_created_at IS NOT NULL
                    AND julianday(sessions.completed_at) IS NOT NULL
                    AND julianday(gh_pr.pr_created_at) IS NOT NULL
                    AND julianday(gh_pr.pr_created_at) <= julianday(sessions.completed_at)
                  )
                )
              )
            )
        ) notified
        LIMIT 1
        "#,
        )
        .map_err(sqlite_error)?;
    statement
        .exists((workspace_id, pr_number, head_sha))
        .map_err(sqlite_error)
}

/// The most-recent PR opened from `branch` in `project_id`, whichever session
/// happened to observe it. A PR is a property of its head branch, so every
/// workspace sitting on that branch resolves the same PR — including the ones
/// whose own sessions were idle when the poller last looked.
///
/// Scoped by project because branch names are only unique within a repo:
/// `adam/fix-thing` in two different repos are two different branches.
pub fn latest_pr_for_branch(
    connection: &Connection,
    project_id: &str,
    branch: &str,
) -> ArgmaxResult<Option<GhPrRecord>> {
    if branch.is_empty() {
        return Ok(None);
    }
    query_latest_pr(
        connection,
        r#"
        SELECT gh_pr.*
        FROM gh_pr
        JOIN sessions ON sessions.id = gh_pr.session_id
        JOIN workspaces ON workspaces.id = sessions.workspace_id
        WHERE workspaces.project_id = ?
          AND gh_pr.head_ref_name = ?
          AND (
            workspaces.shared_workspace = 0
            OR gh_pr.attribution = 'explicit'
            OR (
              gh_pr.attribution = 'inferred'
              AND (
                sessions.state IN ('running', 'waiting', 'blocked')
                OR (
                  sessions.completed_at IS NOT NULL
                  AND gh_pr.pr_created_at IS NOT NULL
                  AND julianday(sessions.completed_at) IS NOT NULL
                  AND julianday(gh_pr.pr_created_at) IS NOT NULL
                  AND julianday(gh_pr.pr_created_at) <= julianday(sessions.completed_at)
                )
              )
            )
          )
        ORDER BY gh_pr.updated_at DESC, gh_pr.pr_number DESC
        LIMIT 1
        "#,
        (project_id, branch),
    )
}

/// Sidebar marker for one workspace. Isolated workspaces resolve the PR on
/// their owned branch, even when the session referenced other PRs. Shared
/// checkouts resolve only PRs attributed to their own session, because another
/// session may later move the checkout's HEAD.
pub fn latest_pr_for_workspace(
    connection: &Connection,
    workspace_id: &str,
    project_id: &str,
    branch: &str,
) -> ArgmaxResult<Option<GhPrRecord>> {
    query_latest_pr(
        connection,
        r#"
        SELECT gh_pr.*
        FROM gh_pr
        JOIN sessions AS observer_sessions ON observer_sessions.id = gh_pr.session_id
        JOIN workspaces AS observer_workspaces ON observer_workspaces.id = observer_sessions.workspace_id
        JOIN workspaces AS target_workspace ON target_workspace.id = ?3
        WHERE observer_workspaces.project_id = ?1
          AND target_workspace.project_id = ?1
          AND (
            observer_workspaces.shared_workspace = 0
            OR gh_pr.attribution = 'explicit'
            OR (
              gh_pr.attribution = 'inferred'
              AND (
                observer_sessions.state IN ('running', 'waiting', 'blocked')
                OR (
                  observer_sessions.completed_at IS NOT NULL
                  AND gh_pr.pr_created_at IS NOT NULL
                  AND julianday(observer_sessions.completed_at) IS NOT NULL
                  AND julianday(gh_pr.pr_created_at) IS NOT NULL
                  AND julianday(gh_pr.pr_created_at) <= julianday(observer_sessions.completed_at)
                )
              )
            )
          )
          AND (
            (
              target_workspace.shared_workspace = 1
              AND observer_sessions.workspace_id = target_workspace.id
            )
            OR (
              target_workspace.shared_workspace = 0
              AND (
                (?2 != '' AND gh_pr.head_ref_name = ?2)
                OR (gh_pr.head_ref_name IS NULL AND observer_sessions.workspace_id = target_workspace.id)
              )
            )
          )
        ORDER BY
          CASE
            WHEN target_workspace.shared_workspace = 0
              AND ?2 != ''
              AND gh_pr.head_ref_name = ?2
            THEN 0
            ELSE 1
          END,
          gh_pr.updated_at DESC,
          gh_pr.pr_number DESC
        LIMIT 1
        "#,
        (project_id, branch, workspace_id),
    )
}

fn query_latest_pr(
    connection: &Connection,
    sql: &str,
    params: impl rusqlite::Params,
) -> ArgmaxResult<Option<GhPrRecord>> {
    let mut statement = connection.prepare_cached(sql).map_err(sqlite_error)?;
    match statement.query_row(params, row_to_gh_pr) {
        Ok(record) => Ok(Some(record)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(sqlite_error(error)),
    }
}

pub fn mark_gh_pr_notified(
    connection: &Connection,
    session_id: &str,
    pr_number: i64,
    head_sha: &str,
    notified_at: &str,
) -> ArgmaxResult<()> {
    let transaction = connection.unchecked_transaction().map_err(sqlite_error)?;
    let link_changes = transaction
        .prepare_cached(
            r#"
        UPDATE session_pr_links
        SET notified_head_sha = ?4,
            notified_at = ?5
        WHERE session_id = ?1 AND pr_number = ?2
          AND EXISTS (
            SELECT 1 FROM gh_pull_requests prs
            WHERE prs.project_id = session_pr_links.project_id
              AND prs.pr_number = session_pr_links.pr_number
              AND prs.head_sha = ?3
          )
        "#,
        )
        .map_err(sqlite_error)?
        .execute((session_id, pr_number, head_sha, head_sha, notified_at))
        .map_err(sqlite_error)?;
    let legacy_changes = transaction
        .prepare_cached(
            r#"
            UPDATE gh_pr
            SET notified_at = ?1
            WHERE session_id = ?2 AND pr_number = ?3 AND head_sha = ?4
            "#,
        )
        .map_err(sqlite_error)?
        .execute((notified_at, session_id, pr_number, head_sha))
        .map_err(sqlite_error)?;
    if link_changes == 0 && legacy_changes == 0 {
        // The head_sha rotated between read and mark — the notification
        // belongs to a stale commit. Surface it so the caller can decide
        // whether to retry against the new sha or drop the notification.
        return Err(ArgmaxError::service(
            "GH_PR_STALE_HEAD_SHA",
            format!(
                "gh_pr row for session {session_id} pr {pr_number} no longer at head_sha {head_sha}",
            ),
        ));
    }
    transaction.commit().map_err(sqlite_error)?;
    Ok(())
}

fn find_gh_pr(
    connection: &Connection,
    session_id: &str,
    pr_number: i64,
) -> ArgmaxResult<Option<GhPrRecord>> {
    let mut statement = connection
        .prepare_cached("SELECT * FROM gh_pr WHERE session_id = ? AND pr_number = ?")
        .map_err(sqlite_error)?;
    match statement.query_row((session_id, pr_number), row_to_gh_pr) {
        Ok(row) => Ok(Some(row)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(sqlite_error(error)),
    }
}

fn row_to_gh_pr(row: &Row<'_>) -> rusqlite::Result<GhPrRecord> {
    Ok(GhPrRecord {
        session_id: row.get("session_id")?,
        pr_number: row.get("pr_number")?,
        head_sha: row.get("head_sha")?,
        last_seen_check_state: row.get("last_seen_check_state")?,
        updated_at: row.get("updated_at")?,
        pr_state: row.get("pr_state")?,
        notified_at: row.get("notified_at")?,
        pr_created_at: row.get("pr_created_at")?,
        pr_merged_at: row.get("pr_merged_at")?,
        head_ref_name: row.get("head_ref_name")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::projects::{persist_project, PersistProjectInput, ProjectSettings};
    use crate::persistence::sessions::{
        persist_session, update_session_state, PersistSessionInput, SessionStateInput,
    };
    use crate::persistence::workspaces::{
        persist_workspace, update_workspace_status, PersistWorkspaceInput, WorkspaceStatusInput,
    };
    use crate::persistence::Database;
    use crate::sessions::state::SessionState;

    fn add_project(connection: &Connection, id: &str) {
        persist_project(
            connection,
            &PersistProjectInput {
                id: id.to_owned(),
                name: id.to_owned(),
                repo_path: format!("/tmp/{id}"),
                current_branch: "main".to_owned(),
                default_branch: Some("main".to_owned()),
                settings: ProjectSettings {
                    archive_on_merge: false,
                    worktree_location: format!("/tmp/{id}/worktrees"),
                    setup_command: String::new(),
                    check_commands: Vec::new(),
                },
            },
        )
        .expect("persist project");
    }

    fn add_session(
        connection: &Connection,
        project_id: &str,
        workspace_id: &str,
        session_id: &str,
        branch: &str,
        shared: bool,
    ) {
        persist_workspace(
            connection,
            &PersistWorkspaceInput {
                id: workspace_id.to_owned(),
                project_id: project_id.to_owned(),
                task_label: session_id.to_owned(),
                branch: branch.to_owned(),
                base_ref: "main".to_owned(),
                path: format!("/tmp/{project_id}/{workspace_id}"),
                state: "running".to_owned(),
                shared_workspace: shared,
                kind: "git".to_owned(),
                dirty: false,
                changed_files: 0,
            },
        )
        .expect("persist workspace");
        persist_session(
            connection,
            &PersistSessionInput {
                id: session_id.to_owned(),
                workspace_id: workspace_id.to_owned(),
                provider: "codex".to_owned(),
                model_label: "Default".to_owned(),
                model_id: "default".to_owned(),
                reasoning_effort: None,
                permission_mode: None,
                agent_mode: None,
                prompt: "test".to_owned(),
                state: SessionState::Running,
            },
        )
        .expect("persist session");
    }

    fn pr(session_id: &str, state: &str, head_sha: &str) -> GhPrRecord {
        GhPrRecord {
            session_id: session_id.to_owned(),
            pr_number: 7,
            head_sha: head_sha.to_owned(),
            last_seen_check_state: "PENDING".to_owned(),
            updated_at: "2026-09-07T10:00:00.000Z".to_owned(),
            pr_state: Some(state.to_owned()),
            notified_at: None,
            pr_created_at: Some("2026-09-07T09:00:00.000Z".to_owned()),
            pr_merged_at: (state == "MERGED").then(|| "2026-09-07T09:30:00.000Z".to_owned()),
            head_ref_name: Some("feature/pr".to_owned()),
        }
    }

    #[test]
    fn isolated_workspace_marker_rejects_explicit_pr_on_another_branch() {
        for state in ["OPEN", "CLOSED", "MERGED"] {
            let database = Database::open_in_memory().expect("open db");
            let connection = database.connection();
            add_project(&connection, "p1");
            add_session(&connection, "p1", "w1", "s1", "feature/work", false);
            record_gh_pr_observation(
                &connection,
                &pr("s1", state, "sha1"),
                PrAttribution::Explicit,
            )
            .expect("record explicit")
            .expect("associated");
            assert_eq!(list_gh_pr_for_session(&connection, "s1").unwrap().len(), 1);
            assert!(
                latest_pr_for_workspace(&connection, "w1", "p1", "feature/work")
                    .unwrap()
                    .is_none(),
                "an unrelated {state} PR is session history, not this workspace's PR"
            );

            add_session(&connection, "p1", "w2", "s2", "feature/work", false);
            let mut matching = pr("s2", "OPEN", "eight");
            matching.pr_number = 8;
            matching.head_ref_name = Some("feature/work".to_owned());
            record_gh_pr_observation(&connection, &matching, PrAttribution::Inferred)
                .expect("record matching PR")
                .expect("associated");
            assert_eq!(
                latest_pr_for_workspace(&connection, "w1", "p1", "feature/work")
                    .unwrap()
                    .unwrap()
                    .pr_number,
                8
            );
        }
    }

    #[test]
    fn observations_propagate_within_project_and_preserve_notification_per_head() {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        add_project(&connection, "p1");
        add_project(&connection, "p2");
        add_session(&connection, "p1", "w1", "s1", "feature/pr", false);
        add_session(&connection, "p1", "w2", "s2", "feature/pr", false);
        add_session(&connection, "p2", "w3", "s3", "feature/pr", false);

        for session_id in ["s1", "s2", "s3"] {
            upsert_gh_pr(&connection, &pr(session_id, "OPEN", "old")).expect("seed pr");
            mark_gh_pr_notified(&connection, session_id, 7, "old", "notified")
                .expect("mark notified");
        }

        record_gh_pr_observation(
            &connection,
            &pr("s1", "MERGED", "new"),
            PrAttribution::Explicit,
        )
        .expect("record merge")
        .expect("explicit association");
        for session_id in ["s1", "s2"] {
            let row = find_gh_pr(&connection, session_id, 7)
                .expect("read pr")
                .expect("pr exists");
            assert_eq!(row.pr_state.as_deref(), Some("MERGED"));
            assert_eq!(row.head_sha, "new");
            assert_eq!(row.notified_at, None, "new head resets each observer");
        }
        let other_project = find_gh_pr(&connection, "s3", 7)
            .expect("read other project")
            .expect("other project pr");
        assert_eq!(other_project.pr_state.as_deref(), Some("OPEN"));
        assert_eq!(other_project.head_sha, "old");
        assert_eq!(other_project.notified_at.as_deref(), Some("notified"));

        mark_gh_pr_notified(&connection, "s1", 7, "new", "merged-notified")
            .expect("mark merged notified");
        record_gh_pr_observation(
            &connection,
            &pr("s2", "OPEN", "new"),
            PrAttribution::Explicit,
        )
        .expect("record stale open")
        .expect("promote explicit");
        let first = find_gh_pr(&connection, "s1", 7)
            .expect("read first")
            .expect("first pr");
        let second = find_gh_pr(&connection, "s2", 7)
            .expect("read second")
            .expect("second pr");
        assert_eq!(first.pr_state.as_deref(), Some("MERGED"));
        assert_eq!(second.pr_state.as_deref(), Some("MERGED"));
        assert_eq!(first.notified_at.as_deref(), Some("merged-notified"));
    }

    #[test]
    fn canonical_only_notification_deduplicates_workspace_and_resets_for_new_head() {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        add_project(&connection, "p1");
        add_session(&connection, "p1", "w1", "s1", "feature/pr", true);
        persist_session(
            &connection,
            &PersistSessionInput {
                id: "s2".to_owned(),
                workspace_id: "w1".to_owned(),
                provider: "codex".to_owned(),
                model_label: "Default".to_owned(),
                model_id: "default".to_owned(),
                reasoning_effort: None,
                permission_mode: None,
                agent_mode: None,
                prompt: "test".to_owned(),
                state: SessionState::Running,
            },
        )
        .expect("persist peer session");
        for session_id in ["s1", "s2"] {
            record_session_pr_evidence(
                &connection,
                session_id,
                7,
                "worked",
                &format!("work:{session_id}"),
                "2026-09-07T09:00:00.000Z",
            )
            .expect("record canonical-only work");
        }
        store_gh_pr_observation(&connection, &pr("s1", "OPEN", "old"))
            .expect("store canonical observation");
        assert!(find_gh_pr(&connection, "s1", 7).unwrap().is_none());
        assert!(find_gh_pr(&connection, "s2", 7).unwrap().is_none());

        mark_gh_pr_notified(&connection, "s1", 7, "old", "notified").expect("mark canonical link");
        assert!(check_failure_launched_in_workspace(&connection, "w1", 7, "old").unwrap());
        assert_eq!(
            list_gh_pr_for_session(&connection, "s1").unwrap()[0]
                .notified_at
                .as_deref(),
            Some("notified")
        );

        store_gh_pr_observation(&connection, &pr("s2", "OPEN", "new"))
            .expect("rotate canonical head");
        assert!(!check_failure_launched_in_workspace(&connection, "w1", 7, "old").unwrap());
        assert!(!check_failure_launched_in_workspace(&connection, "w1", 7, "new").unwrap());
        assert!(mark_gh_pr_notified(&connection, "s1", 7, "old", "stale").is_err());

        mark_gh_pr_notified(&connection, "s2", 7, "new", "new-notification")
            .expect("mark new canonical head through peer session");
        assert!(check_failure_launched_in_workspace(&connection, "w1", 7, "new").unwrap());
    }

    #[test]
    fn merged_without_timestamp_is_irreversible_for_every_peer() {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        add_project(&connection, "p1");
        add_session(&connection, "p1", "w1", "s1", "feature/pr", false);
        add_session(&connection, "p1", "w2", "s2", "feature/pr", false);
        add_session(&connection, "p1", "w3", "s3", "feature/pr", false);
        let mut merged = pr("s1", "MERGED", "same");
        merged.pr_merged_at = None;
        upsert_gh_pr(&connection, &merged).expect("seed legacy merge");
        upsert_gh_pr(&connection, &pr("s2", "OPEN", "same")).expect("seed open peer");

        record_gh_pr_observation(
            &connection,
            &pr("s3", "OPEN", "same"),
            PrAttribution::Explicit,
        )
        .expect("record stale open")
        .expect("associate observer");
        for session_id in ["s1", "s2", "s3"] {
            assert_eq!(
                find_gh_pr(&connection, session_id, 7)
                    .expect("read row")
                    .expect("row")
                    .pr_state
                    .as_deref(),
                Some("MERGED")
            );
        }
    }

    #[test]
    fn shared_attribution_uses_frozen_branch_and_completion_cutoff() {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        add_project(&connection, "p1");
        add_session(&connection, "p1", "w1", "s1", "feature/pr", true);

        let accepted = record_gh_pr_observation(
            &connection,
            &pr("s1", "OPEN", "one"),
            PrAttribution::Inferred,
        )
        .expect("record inferred");
        assert!(accepted.is_some());
        update_session_state(
            &connection,
            "s1",
            &SessionStateInput::transition(SessionState::Complete)
                .finished_at("2026-09-07T10:00:00.000Z"),
        )
        .expect("complete session");
        update_workspace_status(
            &connection,
            "w1",
            &WorkspaceStatusInput {
                branch: "main".to_owned(),
                dirty: false,
                changed_files: 0,
                last_activity_at: None,
            },
        )
        .expect("move shared checkout");
        assert_eq!(
            pr_branch_for_session(&connection, "s1").unwrap().as_deref(),
            Some("feature/pr")
        );
        assert_eq!(list_gh_pr_for_session(&connection, "s1").unwrap().len(), 1);
        assert_eq!(
            latest_pr_for_workspace(&connection, "w1", "p1", "main")
                .unwrap()
                .unwrap()
                .pr_number,
            7
        );
        update_session_state(
            &connection,
            "s1",
            &SessionStateInput::transition(SessionState::Running),
        )
        .expect("resume session");
        assert_eq!(
            pr_branch_for_session(&connection, "s1").unwrap().as_deref(),
            Some("main"),
            "a resumed turn trusts the branch it actually resumed on"
        );

        add_session(&connection, "p1", "w2", "s2", "feature/pr", true);
        update_session_state(
            &connection,
            "s2",
            &SessionStateInput::transition(SessionState::Complete)
                .finished_at("2026-09-07T08:00:00.000Z"),
        )
        .expect("complete before pr");
        assert!(record_gh_pr_observation(
            &connection,
            &pr("s2", "OPEN", "one"),
            PrAttribution::Inferred,
        )
        .expect("reject late inference")
        .is_none());
        assert!(list_gh_pr_for_session(&connection, "s2")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn shared_legacy_rows_require_explicit_promotion() {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        add_project(&connection, "p1");
        add_session(&connection, "p1", "w1", "s1", "feature/pr", true);
        upsert_gh_pr(&connection, &pr("s1", "OPEN", "one")).expect("seed legacy row");
        assert!(list_gh_pr_for_session(&connection, "s1")
            .unwrap()
            .is_empty());
        assert!(record_gh_pr_observation(
            &connection,
            &pr("s1", "OPEN", "one"),
            PrAttribution::Inferred,
        )
        .expect("cached inferred refresh")
        .is_none());
        assert!(list_gh_pr_for_session(&connection, "s1")
            .unwrap()
            .is_empty());
        record_gh_pr_observation(
            &connection,
            &pr("s1", "OPEN", "one"),
            PrAttribution::Explicit,
        )
        .expect("explicit refresh")
        .expect("promoted row");
        assert_eq!(list_gh_pr_for_session(&connection, "s1").unwrap().len(), 1);
    }

    #[test]
    fn primary_selection_uses_evidence_activity_not_refresh_order() {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        add_project(&connection, "p1");
        add_session(&connection, "p1", "w1", "s1", "feature/pr", false);
        record_session_pr_evidence(
            &connection,
            "s1",
            10,
            "worked",
            "event-old",
            "2026-09-07T10:00:00.000Z",
        )
        .unwrap();
        record_session_pr_evidence(
            &connection,
            "s1",
            11,
            "worked",
            "event-new",
            "2026-09-07T11:00:00.000Z",
        )
        .unwrap();

        let mut older = pr("s1", "OPEN", "old");
        older.pr_number = 10;
        older.updated_at = "2026-09-07T13:00:00.000Z".to_owned();
        store_gh_pr_observation(&connection, &older).unwrap();
        let mut newer = pr("s1", "OPEN", "new");
        newer.pr_number = 11;
        newer.updated_at = "2026-09-07T12:00:00.000Z".to_owned();
        store_gh_pr_observation(&connection, &newer).unwrap();

        let rows = list_session_prs(&connection, "s1").unwrap();
        assert_eq!(rows[0].pr_number, 11);
        assert!(rows[0].is_primary);

        newer.updated_at = "2026-09-07T14:00:00.000Z".to_owned();
        store_gh_pr_observation(&connection, &newer).unwrap();
        older.updated_at = "2026-09-07T15:00:00.000Z".to_owned();
        store_gh_pr_observation(&connection, &older).unwrap();
        assert_eq!(
            list_session_prs(&connection, "s1").unwrap()[0].pr_number,
            11
        );
    }

    #[test]
    fn evidence_replay_is_idempotent_and_dismissal_survives_it() {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        add_project(&connection, "p1");
        add_session(&connection, "p1", "w1", "s1", "feature/pr", true);
        for _ in 0..2 {
            record_session_pr_evidence(
                &connection,
                "s1",
                48,
                "worked",
                "event-48",
                "2026-09-07T10:00:00.000Z",
            )
            .unwrap();
        }
        let evidence_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM session_pr_evidence WHERE session_id = 's1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(evidence_count, 1);
        assert_eq!(list_session_prs(&connection, "s1").unwrap().len(), 1);

        dismiss_session_pr(&connection, "s1", 48).unwrap();
        dismiss_session_pr(&connection, "s1", 48).expect("repeat dismissal is idempotent");
        assert!(dismiss_session_pr(&connection, "s1", 0).is_err());
        assert!(dismiss_session_pr(&connection, "s1", 49).is_err());
        record_session_pr_evidence(
            &connection,
            "s1",
            48,
            "worked",
            "event-later",
            "2026-09-07T12:00:00.000Z",
        )
        .unwrap();
        assert!(list_session_prs(&connection, "s1").unwrap().is_empty());
    }

    #[test]
    fn pin_is_stable_and_user_selection_only_confirms_reference() {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        add_project(&connection, "p1");
        add_session(&connection, "p1", "w1", "s1", "feature/pr", true);
        record_session_pr_evidence(
            &connection,
            "s1",
            7,
            "unverified",
            "legacy-7",
            "2026-09-07T10:00:00.000Z",
        )
        .unwrap();
        record_session_pr_evidence(
            &connection,
            "s1",
            8,
            "worked",
            "create-8",
            "2026-09-07T11:00:00.000Z",
        )
        .unwrap();
        set_session_pr_selection(&connection, "s1", Some(7)).unwrap();
        let rows = list_session_prs(&connection, "s1").unwrap();
        assert_eq!(rows[0].pr_number, 7);
        assert_eq!(rows[0].relationship, "referenced");
        assert!(rows[0].is_primary);
        assert!(rows[0].is_pinned);
        assert!(set_session_pr_selection(&connection, "missing", None).is_err());
    }

    #[test]
    fn shared_checkout_sessions_keep_separate_associations() {
        let database = Database::open_in_memory().expect("open db");
        let connection = database.connection();
        add_project(&connection, "p1");
        add_session(&connection, "p1", "w1", "s1", "feature/one", true);
        add_session(&connection, "p1", "w2", "s2", "feature/two", true);
        record_session_pr_evidence(
            &connection,
            "s1",
            101,
            "worked",
            "create-101",
            "2026-09-07T10:00:00.000Z",
        )
        .unwrap();
        record_session_pr_evidence(
            &connection,
            "s2",
            102,
            "worked",
            "create-102",
            "2026-09-07T11:00:00.000Z",
        )
        .unwrap();
        assert_eq!(
            list_session_prs(&connection, "s1").unwrap()[0].pr_number,
            101
        );
        assert_eq!(
            list_session_prs(&connection, "s2").unwrap()[0].pr_number,
            102
        );
    }
}
