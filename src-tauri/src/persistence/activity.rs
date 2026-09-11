//! Storage for the Activity page's ledger (migration v44). The scanner in
//! `crate::activity::scanner` decides what to read out of git and `gh`; this
//! module only remembers what it found. See `docs/activity.md`.

use rusqlite::{Connection, OptionalExtension};

use super::sqlite_error;
use crate::error::ArgmaxResult;

pub const MIGRATION_SQL: &str = r#"
CREATE TABLE activity_commits (
  sha TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  author_email TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  author_at TEXT NOT NULL,
  lines_added INTEGER NOT NULL DEFAULT 0,
  lines_removed INTEGER NOT NULL DEFAULT 0,
  files_changed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_activity_commits_project_time ON activity_commits(project_id, committed_at);
CREATE TABLE activity_scan_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE activity_github_prs (
  repository TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  state TEXT NOT NULL,
  is_draft INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  merged_at TEXT,
  closed_at TEXT,
  additions INTEGER NOT NULL DEFAULT 0,
  deletions INTEGER NOT NULL DEFAULT 0,
  author_login TEXT NOT NULL,
  PRIMARY KEY (repository, number)
);
CREATE INDEX idx_activity_github_prs_created ON activity_github_prs(created_at);
CREATE TABLE activity_github_reviews (
  repository TEXT NOT NULL,
  number INTEGER NOT NULL,
  submitted_at TEXT NOT NULL,
  state TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  PRIMARY KEY (repository, number, submitted_at)
);
CREATE INDEX idx_activity_github_reviews_submitted ON activity_github_reviews(submitted_at);
CREATE TABLE activity_github_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"#;

/// Meta key holding the RFC 3339 time the last full commit sweep finished.
pub const META_LAST_COMPLETED_AT: &str = "last_completed_at";
/// Meta key holding the JSON array of author emails the sweep matched on.
pub const META_AUTHOR_EMAILS: &str = "author_emails";
/// Meta key holding the parser version the ledger was built with. Bumping it
/// empties `activity_commits` and rescans.
pub const META_PARSER_VERSION: &str = "parser_version";

/// GitHub meta keys. The login is what every `gh` search is scoped to, so a
/// changed login invalidates the cached PRs and reviews.
pub const GITHUB_META_LOGIN: &str = "login";
pub const GITHUB_META_LAST_FETCHED_AT: &str = "last_fetched_at";
/// When a refresh last started, whether or not it finished.
pub const GITHUB_META_LAST_ATTEMPT_AT: &str = "last_attempt_at";
/// Plain-English reason the last refresh failed. Cleared by a refresh that
/// succeeds; the cached rows stay either way.
pub const GITHUB_META_LAST_ERROR: &str = "last_error";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitRow {
    pub sha: String,
    pub project_id: String,
    pub author_email: String,
    /// RFC 3339 UTC.
    pub committed_at: String,
    pub author_at: String,
    pub lines_added: i64,
    pub lines_removed: i64,
    pub files_changed: i64,
}

/// Upsert one sweep's commits for a project. A commit already in the ledger is
/// replaced rather than skipped: a rebase can restate the same SHA's numstat
/// under a different project after a repo moves.
pub fn upsert_commits(connection: &Connection, commits: &[CommitRow]) -> ArgmaxResult<()> {
    let transaction = connection.unchecked_transaction().map_err(sqlite_error)?;
    {
        let mut statement = transaction
            .prepare_cached(
                r#"
                INSERT INTO activity_commits (
                  sha, project_id, author_email, committed_at, author_at,
                  lines_added, lines_removed, files_changed
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(sha) DO UPDATE SET
                  project_id = excluded.project_id,
                  author_email = excluded.author_email,
                  committed_at = excluded.committed_at,
                  author_at = excluded.author_at,
                  lines_added = excluded.lines_added,
                  lines_removed = excluded.lines_removed,
                  files_changed = excluded.files_changed
                "#,
            )
            .map_err(sqlite_error)?;
        for commit in commits {
            statement
                .execute((
                    commit.sha.as_str(),
                    commit.project_id.as_str(),
                    commit.author_email.as_str(),
                    commit.committed_at.as_str(),
                    commit.author_at.as_str(),
                    commit.lines_added,
                    commit.lines_removed,
                    commit.files_changed,
                ))
                .map_err(sqlite_error)?;
        }
    }
    transaction.commit().map_err(sqlite_error)
}

/// Forget everything a project contributed. Called for projects that left the
/// `projects` table and before a project is reparsed from scratch.
pub fn delete_project_commits(connection: &Connection, project_id: &str) -> ArgmaxResult<()> {
    connection
        .execute(
            "DELETE FROM activity_commits WHERE project_id = ?",
            [project_id],
        )
        .map_err(sqlite_error)?;
    Ok(())
}

/// Drop a project's commits from `since` onward. A sweep re-reads that whole
/// span, so the parse is authoritative for it — and clearing first is what
/// keeps a rebased branch from leaving its old SHAs behind to be counted twice.
pub fn delete_project_commits_since(
    connection: &Connection,
    project_id: &str,
    since: &str,
) -> ArgmaxResult<()> {
    connection
        .execute(
            "DELETE FROM activity_commits WHERE project_id = ? AND committed_at >= ?",
            [project_id, since],
        )
        .map_err(sqlite_error)?;
    Ok(())
}

/// Project ids the ledger holds commits for, so a sweep can notice projects
/// that were removed while the app was closed.
pub fn list_commit_project_ids(connection: &Connection) -> ArgmaxResult<Vec<String>> {
    let mut statement = connection
        .prepare_cached("SELECT DISTINCT project_id FROM activity_commits ORDER BY project_id")
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(sqlite_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)
}

/// Every commit with `committed_at` in `[from, to)`, oldest first. The window
/// is widened by the caller so a local day at either edge is whole.
pub fn list_commits_between(
    connection: &Connection,
    from: &str,
    to: &str,
) -> ArgmaxResult<Vec<CommitRow>> {
    let mut statement = connection
        .prepare_cached(
            r#"
            SELECT sha, project_id, author_email, committed_at, author_at,
                   lines_added, lines_removed, files_changed
            FROM activity_commits
            WHERE committed_at >= ? AND committed_at < ?
            ORDER BY committed_at
            "#,
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([from, to], |row| {
            Ok(CommitRow {
                sha: row.get(0)?,
                project_id: row.get(1)?,
                author_email: row.get(2)?,
                committed_at: row.get(3)?,
                author_at: row.get(4)?,
                lines_added: row.get(5)?,
                lines_removed: row.get(6)?,
                files_changed: row.get(7)?,
            })
        })
        .map_err(sqlite_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)
}

/// Oldest `committed_at` in the ledger, which is what decides whether the
/// previous window can be reported honestly.
pub fn earliest_commit_at(connection: &Connection) -> ArgmaxResult<Option<String>> {
    connection
        .prepare_cached("SELECT MIN(committed_at) FROM activity_commits")
        .map_err(sqlite_error)?
        .query_row([], |row| row.get::<_, Option<String>>(0))
        .optional()
        .map(Option::flatten)
        .map_err(sqlite_error)
}

/// Newest `committed_at` per project across the whole ledger, not just the
/// window — a repository with no commits in the window still says when it was
/// last touched.
pub fn latest_commit_per_project(connection: &Connection) -> ArgmaxResult<Vec<(String, String)>> {
    let mut statement = connection
        .prepare_cached(
            "SELECT project_id, MAX(committed_at) FROM activity_commits GROUP BY project_id",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(sqlite_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)
}

pub fn clear_commits(connection: &Connection) -> ArgmaxResult<()> {
    connection
        .execute("DELETE FROM activity_commits", [])
        .map_err(sqlite_error)?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequestRow {
    pub repository: String,
    pub number: i64,
    pub title: String,
    pub url: String,
    /// `open` / `merged` / `closed`, already normalized from GitHub's enum.
    pub state: String,
    pub is_draft: bool,
    pub created_at: String,
    pub merged_at: Option<String>,
    pub closed_at: Option<String>,
    pub additions: i64,
    pub deletions: i64,
    pub author_login: String,
}

pub fn upsert_pull_requests(connection: &Connection, rows: &[PullRequestRow]) -> ArgmaxResult<()> {
    let transaction = connection.unchecked_transaction().map_err(sqlite_error)?;
    {
        let mut statement = transaction
            .prepare_cached(
                r#"
                INSERT INTO activity_github_prs (
                  repository, number, title, url, state, is_draft, created_at,
                  merged_at, closed_at, additions, deletions, author_login
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(repository, number) DO UPDATE SET
                  title = excluded.title,
                  url = excluded.url,
                  state = excluded.state,
                  is_draft = excluded.is_draft,
                  created_at = excluded.created_at,
                  merged_at = excluded.merged_at,
                  closed_at = excluded.closed_at,
                  additions = excluded.additions,
                  deletions = excluded.deletions,
                  author_login = excluded.author_login
                "#,
            )
            .map_err(sqlite_error)?;
        for row in rows {
            statement
                .execute((
                    row.repository.as_str(),
                    row.number,
                    row.title.as_str(),
                    row.url.as_str(),
                    row.state.as_str(),
                    super::bool_to_i64(row.is_draft),
                    row.created_at.as_str(),
                    row.merged_at.as_deref(),
                    row.closed_at.as_deref(),
                    row.additions,
                    row.deletions,
                    row.author_login.as_str(),
                ))
                .map_err(sqlite_error)?;
        }
    }
    transaction.commit().map_err(sqlite_error)
}

/// Every cached PR created or merged in `[from, to)`. Both edges are checked in
/// SQL so an old PR merged inside the window still shows up.
pub fn list_pull_requests_touching(
    connection: &Connection,
    from: &str,
    to: &str,
) -> ArgmaxResult<Vec<PullRequestRow>> {
    let mut statement = connection
        .prepare_cached(
            r#"
            SELECT repository, number, title, url, state, is_draft, created_at,
                   merged_at, closed_at, additions, deletions, author_login
            FROM activity_github_prs
            WHERE (created_at >= ? AND created_at < ?)
               OR (merged_at IS NOT NULL AND merged_at >= ? AND merged_at < ?)
            "#,
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([from, to, from, to], |row| {
            Ok(PullRequestRow {
                repository: row.get(0)?,
                number: row.get(1)?,
                title: row.get(2)?,
                url: row.get(3)?,
                state: row.get(4)?,
                is_draft: row.get::<_, i64>(5)? != 0,
                created_at: row.get(6)?,
                merged_at: row.get(7)?,
                closed_at: row.get(8)?,
                additions: row.get(9)?,
                deletions: row.get(10)?,
                author_login: row.get(11)?,
            })
        })
        .map_err(sqlite_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewRow {
    pub repository: String,
    pub number: i64,
    pub submitted_at: String,
    /// `approved` / `changes_requested` / `commented`.
    pub state: String,
    pub title: String,
    pub url: String,
}

pub fn upsert_reviews(connection: &Connection, rows: &[ReviewRow]) -> ArgmaxResult<()> {
    let transaction = connection.unchecked_transaction().map_err(sqlite_error)?;
    {
        let mut statement = transaction
            .prepare_cached(
                r#"
                INSERT INTO activity_github_reviews (
                  repository, number, submitted_at, state, title, url
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(repository, number, submitted_at) DO UPDATE SET
                  state = excluded.state,
                  title = excluded.title,
                  url = excluded.url
                "#,
            )
            .map_err(sqlite_error)?;
        for row in rows {
            statement
                .execute((
                    row.repository.as_str(),
                    row.number,
                    row.submitted_at.as_str(),
                    row.state.as_str(),
                    row.title.as_str(),
                    row.url.as_str(),
                ))
                .map_err(sqlite_error)?;
        }
    }
    transaction.commit().map_err(sqlite_error)
}

pub fn list_reviews_between(
    connection: &Connection,
    from: &str,
    to: &str,
) -> ArgmaxResult<Vec<ReviewRow>> {
    let mut statement = connection
        .prepare_cached(
            r#"
            SELECT repository, number, submitted_at, state, title, url
            FROM activity_github_reviews
            WHERE submitted_at >= ? AND submitted_at < ?
            ORDER BY submitted_at DESC
            "#,
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([from, to], |row| {
            Ok(ReviewRow {
                repository: row.get(0)?,
                number: row.get(1)?,
                submitted_at: row.get(2)?,
                state: row.get(3)?,
                title: row.get(4)?,
                url: row.get(5)?,
            })
        })
        .map_err(sqlite_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)
}

/// Drop the cached GitHub half. Called when the `gh` login changes: PRs and
/// reviews are scoped to one login, so keeping another account's rows would
/// silently inflate the page.
pub fn clear_github_cache(connection: &Connection) -> ArgmaxResult<()> {
    connection
        .execute("DELETE FROM activity_github_prs", [])
        .map_err(sqlite_error)?;
    connection
        .execute("DELETE FROM activity_github_reviews", [])
        .map_err(sqlite_error)?;
    Ok(())
}

/// `project_id` → `owner/name` for every project whose GitHub remote has been
/// discovered. Read-only on purpose: `projects::get_project_remote` shells out
/// to git and writes what it finds, which the summary's pooled read-only
/// connection cannot do. The sweep calls that one; this reads the result.
pub fn list_project_remotes(connection: &Connection) -> ArgmaxResult<Vec<(String, String)>> {
    let mut statement = connection
        .prepare_cached(
            "SELECT id, repo_remote_owner, repo_remote_name FROM projects
             WHERE repo_remote_owner IS NOT NULL AND repo_remote_name IS NOT NULL",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([], |row| {
            let id: String = row.get(0)?;
            let owner: String = row.get(1)?;
            let name: String = row.get(2)?;
            Ok((id, format!("{owner}/{name}")))
        })
        .map_err(sqlite_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)
}

pub fn get_meta(connection: &Connection, key: &str) -> ArgmaxResult<Option<String>> {
    connection
        .prepare_cached("SELECT value FROM activity_scan_meta WHERE key = ?")
        .map_err(sqlite_error)?
        .query_row([key], |row| row.get::<_, String>(0))
        .optional()
        .map_err(sqlite_error)
}

pub fn set_meta(connection: &Connection, key: &str, value: &str) -> ArgmaxResult<()> {
    connection
        .execute(
            "INSERT INTO activity_scan_meta (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [key, value],
        )
        .map_err(sqlite_error)?;
    Ok(())
}

pub fn get_github_meta(connection: &Connection, key: &str) -> ArgmaxResult<Option<String>> {
    connection
        .prepare_cached("SELECT value FROM activity_github_meta WHERE key = ?")
        .map_err(sqlite_error)?
        .query_row([key], |row| row.get::<_, String>(0))
        .optional()
        .map_err(sqlite_error)
}

pub fn set_github_meta(connection: &Connection, key: &str, value: &str) -> ArgmaxResult<()> {
    connection
        .execute(
            "INSERT INTO activity_github_meta (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [key, value],
        )
        .map_err(sqlite_error)?;
    Ok(())
}

pub fn clear_github_meta(connection: &Connection, key: &str) -> ArgmaxResult<()> {
    connection
        .execute("DELETE FROM activity_github_meta WHERE key = ?", [key])
        .map_err(sqlite_error)?;
    Ok(())
}
