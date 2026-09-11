//! Sweeps every registered project's git history into `activity_commits`.
//!
//! The sweep is the only thing that shells out to git; `summary.rs` reads the
//! ledger and nothing else. Each project is re-read over the whole retention
//! window on every sweep — `git log` over 13 months of one author's commits is
//! cheap, and re-reading is what lets a rebased branch replace its old SHAs
//! instead of leaving them behind to be counted twice.

use std::collections::{BTreeSet, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Months, SecondsFormat, Utc};

use crate::activity::git_log::{self, LOG_FORMAT};
use crate::activity::LEDGER_MONTHS;
use crate::error::{ArgmaxError, ArgmaxResult};
use crate::persistence::activity::{self as storage, CommitRow};
use crate::persistence::projects;
use crate::persistence::time::now_iso;
use crate::persistence::Database;
use crate::util::sync::LockOrRecover;

/// Bumping this empties `activity_commits` and rescans, the same contract the
/// Usage scanner's parser version has.
pub const PARSER_VERSION: &str = "1";

/// Repositories read at once. Each one is a `git log` subprocess doing real
/// disk work; four keeps a fifteen-project machine busy without turning a
/// background sweep into a fan.
const MAX_CONCURRENT_REPOS: usize = 4;

/// One `git log --numstat` over 13 months can be large in a monorepo. The
/// shared default caps stdout at 8 MB, which a busy year of numstat rows can
/// pass; 64 MB is the point past which something is wrong rather than merely
/// big.
const LOG_STDOUT_CAP_BYTES: usize = 64 * 1024 * 1024;

/// A `git log` walking every ref of a large repository is slower than the
/// 30-second default the interactive git callers use.
const LOG_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ActivityScanProgress {
    pub scanning: bool,
    pub repos_total: i64,
    pub repos_done: i64,
    /// RFC 3339 UTC of the last sweep that ran to the end.
    pub last_completed_at: Option<String>,
    /// Author emails the last sweep matched on.
    pub author_emails: Vec<String>,
}

pub struct ActivityScanner {
    database: Arc<Database>,
    sweep_lock: Mutex<()>,
    progress: Mutex<ActivityScanProgress>,
}

impl ActivityScanner {
    pub fn new(database: Arc<Database>) -> Self {
        let (last_completed_at, author_emails) = {
            let connection = database.connection();
            let last = storage::get_meta(&connection, storage::META_LAST_COMPLETED_AT)
                .ok()
                .flatten();
            let emails = storage::get_meta(&connection, storage::META_AUTHOR_EMAILS)
                .ok()
                .flatten()
                .and_then(|value| serde_json::from_str::<Vec<String>>(&value).ok())
                .unwrap_or_default();
            (last, emails)
        };
        Self {
            database,
            sweep_lock: Mutex::new(()),
            progress: Mutex::new(ActivityScanProgress {
                last_completed_at,
                author_emails,
                ..ActivityScanProgress::default()
            }),
        }
    }

    pub fn progress(&self) -> ActivityScanProgress {
        self.progress
            .lock_or_recover("activity scan progress")
            .clone()
    }

    /// Whether a sweep has ever run to the end on this ledger.
    pub fn has_completed_once(&self) -> bool {
        self.progress().last_completed_at.is_some()
    }

    /// Run one sweep. `Ok(false)` means another sweep already holds the lock,
    /// which is not a failure — the caller reads whatever that one commits.
    pub fn sweep(&self) -> ArgmaxResult<bool> {
        let Ok(_guard) = self.sweep_lock.try_lock() else {
            return Ok(false);
        };
        let result = self.sweep_locked(Utc::now());
        let mut progress = self.progress.lock_or_recover("activity scan progress");
        progress.scanning = false;
        if result.is_ok() {
            progress.last_completed_at = Some(now_iso());
        }
        result.map(|()| true)
    }

    fn sweep_locked(&self, now: DateTime<Utc>) -> ArgmaxResult<()> {
        let since = now
            .checked_sub_months(Months::new(LEDGER_MONTHS))
            .unwrap_or(now);
        let since_iso = to_utc_iso(since);

        let projects = {
            let connection = self.database.read_connection();
            projects::list_projects(&connection)?
        };
        {
            let mut progress = self.progress.lock_or_recover("activity scan progress");
            progress.scanning = true;
            progress.repos_total = projects.len() as i64;
            progress.repos_done = 0;
        }

        self.reset_ledger_if_parser_changed()?;
        self.forget_removed_projects(&projects)?;
        self.discover_project_remotes(&projects);

        let global_email = git_config_email(None);
        let mut all_emails: BTreeSet<String> = BTreeSet::new();
        if let Some(email) = &global_email {
            all_emails.insert(email.clone());
        }

        // Every repository's `user.email` is collected before any repository
        // is read: a commit authored under one repo's identity can be
        // reachable from another repo's refs, so the filter has to be the
        // union, not a per-repo address.
        for project in &projects {
            if let Some(email) = git_config_email(Some(project.repo_path.as_str())) {
                all_emails.insert(email);
            }
        }

        if all_emails.is_empty() {
            // No configured identity means no way to tell the user's commits
            // from anyone else's. Recording an empty sweep is honest; guessing
            // would put a colleague's work on the user's page.
            tracing::warn!(
                target: "activity",
                "no git user.email is configured, so no commits can be attributed"
            );
        }
        let allowed: HashSet<String> = all_emails
            .iter()
            .map(|email| email.to_ascii_lowercase())
            .collect();
        let emails: Vec<String> = all_emails.into_iter().collect();
        self.store_author_emails(&emails)?;

        for chunk in projects.chunks(MAX_CONCURRENT_REPOS) {
            let parsed = read_logs(chunk, &since_iso, &emails, &allowed);
            for (project, result) in chunk.iter().zip(parsed) {
                match result {
                    Ok(commits) => {
                        if let Err(error) =
                            self.commit_project(project.id.as_str(), &since_iso, commits)
                        {
                            tracing::warn!(
                                target: "activity",
                                project = %project.id,
                                error = %error,
                                "activity sweep could not store a project's commits"
                            );
                        }
                    }
                    Err(error) => {
                        // A repository that moved, was deleted, or is not a git
                        // checkout any more must not fail the whole sweep. Its
                        // existing rows stay until the project itself is gone.
                        tracing::warn!(
                            target: "activity",
                            project = %project.id,
                            path = %project.repo_path,
                            error = %error,
                            "activity sweep skipped a repository"
                        );
                    }
                }
                let mut progress = self.progress.lock_or_recover("activity scan progress");
                progress.repos_done += 1;
            }
        }

        let connection = self.database.connection();
        storage::set_meta(
            &connection,
            storage::META_LAST_COMPLETED_AT,
            now_iso().as_str(),
        )
    }

    fn commit_project(
        &self,
        project_id: &str,
        since_iso: &str,
        commits: Vec<git_log::ParsedCommit>,
    ) -> ArgmaxResult<()> {
        let rows: Vec<CommitRow> = commits
            .into_iter()
            .filter_map(|commit| to_row(project_id, commit))
            .collect();
        let connection = self.database.connection();
        storage::delete_project_commits_since(&connection, project_id, since_iso)?;
        storage::upsert_commits(&connection, &rows)
    }

    fn reset_ledger_if_parser_changed(&self) -> ArgmaxResult<()> {
        let connection = self.database.connection();
        let stored = storage::get_meta(&connection, storage::META_PARSER_VERSION)?;
        if stored.as_deref() == Some(PARSER_VERSION) {
            return Ok(());
        }
        storage::clear_commits(&connection)?;
        storage::set_meta(&connection, storage::META_PARSER_VERSION, PARSER_VERSION)
    }

    /// Fill in each project's GitHub remote while a writer connection is in
    /// hand. `get_project_remote` shells out to `git config` and stores what it
    /// finds, so the summary's read-only connection must never be the one to
    /// call it — but the summary is what needs the answer, to match a pull
    /// request to a local project.
    fn discover_project_remotes(&self, projects: &[projects::ProjectSummary]) {
        let connection = self.database.connection();
        for project in projects {
            if let Err(error) = projects::get_project_remote(&connection, &project.id) {
                tracing::warn!(
                    target: "activity",
                    project = %project.id,
                    error = %error,
                    "could not resolve a project's GitHub remote"
                );
            }
        }
    }

    fn forget_removed_projects(&self, projects: &[projects::ProjectSummary]) -> ArgmaxResult<()> {
        let live: HashSet<&str> = projects.iter().map(|project| project.id.as_str()).collect();
        let connection = self.database.connection();
        for project_id in storage::list_commit_project_ids(&connection)? {
            if !live.contains(project_id.as_str()) {
                storage::delete_project_commits(&connection, &project_id)?;
            }
        }
        Ok(())
    }

    fn store_author_emails(&self, emails: &[String]) -> ArgmaxResult<()> {
        let json = serde_json::to_string(emails).map_err(|error| {
            ArgmaxError::service("ACTIVITY_SCAN_JSON", format!("author emails: {error}"))
        })?;
        {
            let connection = self.database.connection();
            storage::set_meta(&connection, storage::META_AUTHOR_EMAILS, &json)?;
        }
        self.progress
            .lock_or_recover("activity scan progress")
            .author_emails = emails.to_vec();
        Ok(())
    }
}

pub fn spawn_sweep(scanner: &Arc<ActivityScanner>) {
    let scanner = Arc::clone(scanner);
    tauri::async_runtime::spawn_blocking(move || match scanner.sweep() {
        Ok(_) => {}
        Err(error) => {
            tracing::warn!(target: "activity", error = %error, "activity sweep failed")
        }
    });
}

/// Run `git log` for a chunk of projects concurrently. The sweep itself is
/// already on the blocking pool, so it owns a throwaway current-thread runtime
/// for the fan-out rather than borrowing the app's shared workers.
fn read_logs(
    projects: &[projects::ProjectSummary],
    since_iso: &str,
    emails: &[String],
    allowed: &HashSet<String>,
) -> Vec<ArgmaxResult<Vec<git_log::ParsedCommit>>> {
    if emails.is_empty() {
        return projects.iter().map(|_| Ok(Vec::new())).collect();
    }
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            let message = format!("failed to start a runtime for git: {error}");
            return projects
                .iter()
                .map(|_| Err(ArgmaxError::service("GIT_RUNTIME_UNAVAILABLE", &message)))
                .collect();
        }
    };
    let args = log_args(since_iso, emails);
    runtime.block_on(async {
        let futures = projects.iter().map(|project| {
            let args = args.clone();
            let path = project.repo_path.clone();
            async move {
                let stdout = crate::git::exec::run_git_text_with_options(
                    &path,
                    &args,
                    crate::git::exec::GitExecOptions {
                        timeout: LOG_TIMEOUT,
                        stdout_cap_bytes: LOG_STDOUT_CAP_BYTES,
                        env: Vec::new(),
                    },
                )
                .await?;
                Ok(git_log::parse_log(&stdout, allowed))
            }
        });
        futures_util::future::join_all(futures).await
    })
}

fn log_args(since_iso: &str, emails: &[String]) -> Vec<String> {
    let mut args = vec![
        "log".to_string(),
        "--all".to_string(),
        "--no-merges".to_string(),
        "--numstat".to_string(),
        format!("--format={LOG_FORMAT}"),
        format!("--since={since_iso}"),
        // `--author` is a regex by default, so an address with a `+` or `.` in
        // it would match more than itself. `--fixed-strings` is what makes the
        // filter mean the address; `parse_log` re-checks the match anyway,
        // since `--author` matches a substring of "Name <email>".
        "--fixed-strings".to_string(),
    ];
    for email in emails {
        args.push(format!("--author={email}"));
    }
    args
}

/// `git config user.email`, in a repository or globally. A missing value, a
/// path that is not a checkout, or a git that will not run all mean "no
/// identity here" — the sweep says so once rather than failing.
fn git_config_email(repo_path: Option<&str>) -> Option<String> {
    let mut command = std::process::Command::new("git");
    if let Some(path) = repo_path {
        command.arg("-C").arg(path);
    }
    command.args(["config", "--get", "user.email"]);
    if repo_path.is_none() {
        command.arg("--global");
    }
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let email = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!email.is_empty()).then_some(email)
}

/// Normalize git's `%cI` / `%aI` to RFC 3339 UTC. The stored strings are
/// compared and range-scanned as text, and `2026-09-01T10:00:00+02:00` does
/// not sort against `2026-09-01T09:30:00Z` — so the offset has to go before
/// the row is stored, not when it is read.
fn to_row(project_id: &str, commit: git_log::ParsedCommit) -> Option<CommitRow> {
    let committed_at = normalize_instant(&commit.committed_at)?;
    // An author date git cannot parse is not worth dropping the commit for;
    // the committer date is what every bucket is cut on.
    let author_at = normalize_instant(&commit.author_at).unwrap_or_else(|| committed_at.clone());
    Some(CommitRow {
        sha: commit.sha,
        project_id: project_id.to_string(),
        author_email: commit.author_email,
        committed_at,
        author_at,
        lines_added: commit.lines_added,
        lines_removed: commit.lines_removed,
        files_changed: commit.files_changed,
    })
}

fn normalize_instant(value: &str) -> Option<String> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|parsed| to_utc_iso(parsed.with_timezone(&Utc)))
}

pub fn to_utc_iso(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_args_filter_by_every_email_as_a_fixed_string() {
        let args = log_args(
            "2025-08-01T00:00:00.000Z",
            &["a+b@example.com".into(), "c@example.com".into()],
        );

        assert!(args.contains(&"--fixed-strings".to_string()));
        assert!(args.contains(&"--author=a+b@example.com".to_string()));
        assert!(args.contains(&"--author=c@example.com".to_string()));
        assert!(args.contains(&"--all".to_string()));
        assert!(args.contains(&"--no-merges".to_string()));
    }

    #[test]
    fn rows_store_utc_so_text_ranges_sort() {
        let row = to_row(
            "p1",
            git_log::ParsedCommit {
                sha: "aaa".into(),
                author_email: "me@example.com".into(),
                author_at: "2026-09-01T10:00:00+02:00".into(),
                committed_at: "2026-09-01T10:05:00+02:00".into(),
                lines_added: 3,
                lines_removed: 1,
                files_changed: 2,
            },
        )
        .expect("row");

        assert_eq!(row.committed_at, "2026-09-01T08:05:00.000Z");
        assert_eq!(row.author_at, "2026-09-01T08:00:00.000Z");
        assert_eq!(row.project_id, "p1");
    }

    #[test]
    fn a_commit_with_an_unparseable_committer_date_is_dropped() {
        assert!(to_row(
            "p1",
            git_log::ParsedCommit {
                sha: "aaa".into(),
                author_email: "me@example.com".into(),
                author_at: "2026-09-01T10:00:00Z".into(),
                committed_at: "not a date".into(),
                lines_added: 0,
                lines_removed: 0,
                files_changed: 0,
            },
        )
        .is_none());
    }
}
