// GhService shells out to `gh pr view`
// against a session's workspace and persists the result so the renderer can
// render PR status without re-running `gh` on every read.

use std::collections::HashSet;
use std::sync::Arc;

use serde_json::Value;

use crate::error::{ArgmaxError, ArgmaxResult};
use crate::git::ops::{extract_pr_number, extract_pr_url};
use crate::persistence::database::Database;
use crate::persistence::gh::{list_gh_pr_for_session, upsert_gh_pr, GhPrRecord};
use crate::persistence::sessions::find_session_by_id;
use crate::persistence::time::now_iso;
use crate::persistence::workspaces::find_workspace_by_id;
use crate::util::gh_runner::{default_gh_runner, GhRunner};

const PR_VIEW_JSON_FIELDS: &str =
    "number,headRefOid,headRefName,state,statusCheckRollup,createdAt,mergedAt,url";
/// Bound on extra `gh pr view <number>` calls per refresh, after the branch
/// view. A session that accumulated many OPEN rows still finishes a tick.
const MAX_OPEN_PR_NUMBER_VIEWS: usize = 8;
/// PR URLs sit at the end of `gh pr create` stdout. Scanning a huge tool
/// payload for one would be wasted work.
const COMMAND_EVENT_SCAN_TAIL: usize = 8 * 1024;

/// `GhService` keeps the renderer's PR rows fresh. Cheap reads (`list_for_session`)
/// hit SQLite; `refresh` calls out to `gh` and upserts.
pub struct GhService {
    database: Arc<Database>,
    runner: GhRunner,
}

impl GhService {
    pub fn new(database: Arc<Database>) -> Arc<Self> {
        Arc::new(Self {
            database,
            runner: default_gh_runner(),
        })
    }

    pub fn with_runner(database: Arc<Database>, runner: GhRunner) -> Arc<Self> {
        Arc::new(Self { database, runner })
    }

    /// Returns the cached `gh_pr` rows for a session. Cheap — single
    /// read-only DB hit.
    pub fn list_for_session(&self, session_id: &str) -> ArgmaxResult<Vec<GhPrRecord>> {
        let conn = self.database.read_connection();
        list_gh_pr_for_session(&conn, session_id)
    }

    /// Runs `gh pr view --json …` against the session's workspace and upserts
    /// the result. On `gh` failure (no PR / auth / transport) returns the
    /// existing cached rows — historical rows are never deleted because the
    /// timeline still wants to render them.
    ///
    /// After the branch view, re-views this session's already-cached OPEN rows
    /// by number. `gh pr view <branch>` cannot see a PR whose head the
    /// checkout has left, so without the number pass those rows stay OPEN
    /// forever and a PR the agent opened on another branch is never refreshed.
    pub async fn refresh(&self, session_id: &str) -> ArgmaxResult<Vec<GhPrRecord>> {
        let (workspace_project_id, workspace_path, branch, open_numbers, mentioned_numbers) = {
            let conn = self.database.connection();
            let session = find_session_by_id(&conn, session_id)?;
            let workspace = find_workspace_by_id(&conn, &session.workspace_id)?;
            let open_numbers = list_gh_pr_for_session(&conn, session_id)?
                .into_iter()
                .filter(|row| !matches!(row.pr_state.as_deref(), Some("MERGED") | Some("CLOSED")))
                .map(|row| row.pr_number)
                .collect::<Vec<_>>();
            let mentioned_numbers = command_pr_numbers_from_db(&conn, session_id)?;
            (
                workspace.project_id,
                workspace.path,
                workspace.branch,
                open_numbers,
                mentioned_numbers,
            )
        };
        if workspace_path.is_empty() {
            // A persisted workspace always has a path; an empty one signals
            // data corruption. Surface it rather than silently no-op'ing.
            tracing::warn!(%session_id, "gh.refresh: workspace path is empty; returning cached PR rows");
            return self.list_for_session(session_id);
        }

        let mut viewed = HashSet::new();
        // Pass the workspace's own branch so a shared checkout that has since
        // moved still resolves the PR this session is sitting on — `gh pr view`
        // with no ref uses whatever HEAD the directory currently has.
        if let Some(parsed) = self
            .view_pr(&workspace_path, Some(branch.as_str()), session_id)
            .await
        {
            if let Some(pr_number) = parsed.number {
                viewed.insert(pr_number);
            }
            self.upsert_view(session_id, &workspace_project_id, parsed)?;
        }

        for pr_number in open_numbers
            .into_iter()
            .chain(mentioned_numbers)
            .take(MAX_OPEN_PR_NUMBER_VIEWS)
        {
            if !viewed.insert(pr_number) {
                continue;
            }
            if let Some(parsed) = self
                .view_pr(&workspace_path, Some(&pr_number.to_string()), session_id)
                .await
            {
                self.upsert_view(session_id, &workspace_project_id, parsed)?;
            }
        }

        self.list_for_session(session_id)
    }

    /// `gh pr view <number>` against the session's workspace. The number is
    /// enough — `gh` talks to the GitHub remote, so this finds a PR opened
    /// from another worktree of the same repo.
    pub async fn refresh_pr_number(
        &self,
        session_id: &str,
        pr_number: i64,
    ) -> ArgmaxResult<Vec<GhPrRecord>> {
        let (workspace_project_id, workspace_path) = {
            let conn = self.database.connection();
            let session = find_session_by_id(&conn, session_id)?;
            let workspace = find_workspace_by_id(&conn, &session.workspace_id)?;
            (workspace.project_id, workspace.path)
        };
        if workspace_path.is_empty() {
            tracing::warn!(%session_id, "gh.refresh_pr_number: workspace path is empty; returning cached PR rows");
            return self.list_for_session(session_id);
        }
        if let Some(parsed) = self
            .view_pr(&workspace_path, Some(&pr_number.to_string()), session_id)
            .await
        {
            self.upsert_view(session_id, &workspace_project_id, parsed)?;
        }
        self.list_for_session(session_id)
    }

    async fn view_pr(
        &self,
        workspace_path: &str,
        reference: Option<&str>,
        session_id: &str,
    ) -> Option<PrViewResponse> {
        let mut args = vec!["pr".into(), "view".into()];
        if let Some(reference) = reference.filter(|name| !name.is_empty()) {
            args.push(reference.to_string());
        }
        args.extend(["--json".into(), PR_VIEW_JSON_FIELDS.into()]);

        let stdout = match (self.runner)(workspace_path.to_string(), args).await {
            Ok(text) => text,
            Err(error) => {
                let category = gh_error_category(&error);
                if category == GhErrorCategory::Unknown {
                    tracing::info!(
                        session_id = %session_id,
                        error = %error,
                        "gh.refresh: gh failed with unknown error"
                    );
                } else if category != GhErrorCategory::NoPr {
                    tracing::warn!(
                        session_id = %session_id,
                        error = %error,
                        category = ?category,
                        "gh.refresh: gh failed"
                    );
                }
                return None;
            }
        };
        serde_json::from_str(stdout.trim()).ok()
    }

    fn upsert_view(
        &self,
        session_id: &str,
        workspace_project_id: &str,
        parsed: PrViewResponse,
    ) -> ArgmaxResult<()> {
        let Some(pr_number) = parsed.number else {
            return Ok(());
        };
        let Some(head_sha) = parsed.head_ref_oid.filter(|sha| !sha.is_empty()) else {
            return Ok(());
        };

        let record = GhPrRecord {
            session_id: session_id.to_string(),
            pr_number,
            head_sha,
            last_seen_check_state: collapse_rollup(parsed.status_check_rollup.as_deref()).into(),
            updated_at: now_iso(),
            pr_state: normalize_pr_state(parsed.state.as_deref()),
            notified_at: None,
            pr_created_at: parsed.created_at.filter(|timestamp| !timestamp.is_empty()),
            pr_merged_at: parsed.merged_at.filter(|timestamp| !timestamp.is_empty()),
            head_ref_name: parsed.head_ref_name.filter(|name| !name.is_empty()),
        };
        let conn = self.database.connection();
        upsert_gh_pr(&conn, &record)?;
        if let Some(url) = parsed.url.as_deref() {
            if let Some(remote) = crate::git::ops::extract_github_remote_from_url(url) {
                let _ = crate::persistence::projects::update_project_remote(
                    &conn,
                    workspace_project_id,
                    Some(&remote),
                );
            }
        }
        Ok(())
    }
}

/// GitHub PR numbers mentioned in a completed tool event's stdout. Used to
/// notice `gh pr create` (and similar) without waiting for the poller, which
/// only views `workspace.branch`.
pub fn pr_numbers_from_command_event(event_type: &str, message: &str, payload: &Value) -> Vec<i64> {
    if event_type != "command.completed" {
        return Vec::new();
    }
    let mut text = String::new();
    push_scan_text(&mut text, message);
    if let Some(content) = payload.get("content").and_then(Value::as_str) {
        push_scan_text(&mut text, content);
    }
    if let Some(output) = payload.get("aggregated_output").and_then(Value::as_str) {
        push_scan_text(&mut text, output);
    }
    let scan = tail_str(&text, COMMAND_EVENT_SCAN_TAIL);
    let mut numbers = Vec::new();
    let mut rest = scan;
    while let Some(url) = extract_pr_url(rest) {
        if let Some(number) = extract_pr_number(&url) {
            if !numbers.contains(&number) {
                numbers.push(number);
            }
        }
        let Some(next) = rest.find(&url).map(|at| at + url.len()) else {
            break;
        };
        rest = &rest[next..];
    }
    numbers
}

fn push_scan_text(into: &mut String, chunk: &str) {
    if chunk.is_empty() {
        return;
    }
    if !into.is_empty() {
        into.push('\n');
    }
    into.push_str(chunk);
}

fn command_pr_numbers_from_db(
    connection: &rusqlite::Connection,
    session_id: &str,
) -> ArgmaxResult<Vec<i64>> {
    let mut statement = connection
        .prepare_cached(
            r#"
            SELECT message, payload_json
            FROM events
            WHERE session_id = ?1
              AND type = 'command.completed'
              AND (message LIKE '%/pull/%' OR payload_json LIKE '%/pull/%')
            ORDER BY created_at DESC
            LIMIT 20
            "#,
        )
        .map_err(crate::persistence::sqlite_error)?;
    let mut rows = statement
        .query([session_id])
        .map_err(crate::persistence::sqlite_error)?;
    let mut numbers = Vec::new();
    while let Some(row) = rows.next().map_err(crate::persistence::sqlite_error)? {
        let message: String = row.get(0).map_err(crate::persistence::sqlite_error)?;
        let payload_json: String = row.get(1).map_err(crate::persistence::sqlite_error)?;
        let payload: Value = serde_json::from_str(&payload_json).unwrap_or(Value::Null);
        for number in pr_numbers_from_command_event("command.completed", &message, &payload) {
            if !numbers.contains(&number) {
                numbers.push(number);
            }
        }
    }
    Ok(numbers)
}

fn tail_str(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let start = text.len() - max_bytes;
    match text.get(start..) {
        Some(tail) => tail,
        None => {
            let start = text
                .char_indices()
                .rev()
                .find(|(idx, _)| *idx <= start)
                .map(|(idx, _)| idx)
                .unwrap_or(0);
            &text[start..]
        }
    }
}

// ---------------------------------------------------------------------------
// gh JSON shapes — minimal subset we read.
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Deserialize)]
struct PrViewResponse {
    #[serde(default)]
    number: Option<i64>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default, rename = "headRefOid")]
    head_ref_oid: Option<String>,
    #[serde(default, rename = "headRefName")]
    head_ref_name: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default, rename = "createdAt")]
    created_at: Option<String>,
    #[serde(default, rename = "mergedAt")]
    merged_at: Option<String>,
    #[serde(default, rename = "statusCheckRollup")]
    status_check_rollup: Option<Vec<RollupEntry>>,
}

#[derive(Debug, serde::Deserialize)]
struct RollupEntry {
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    conclusion: Option<String>,
}

// ---------------------------------------------------------------------------
// Error categorization — distinguishes "no PR" from "transport broke" so the
// log surface doesn't bury real failures under PR-less branches.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GhErrorCategory {
    Transient,
    Auth,
    RateLimit,
    NoPr,
    Unknown,
}

fn gh_error_category(error: &ArgmaxError) -> GhErrorCategory {
    let text = error.to_string().to_lowercase();
    if text.contains("no pull requests")
        || text.contains("not a git repository")
        || text.contains("no commits between")
    {
        return GhErrorCategory::NoPr;
    }
    if text.contains("authentication")
        || text.contains("unauthorized")
        || text.contains("not authenticated")
        || text.contains("token")
    {
        return GhErrorCategory::Auth;
    }
    if text.contains("rate limit") || text.contains("api rate") {
        return GhErrorCategory::RateLimit;
    }
    if text.contains("timeout") || text.contains("etimedout") || text.contains("network") {
        return GhErrorCategory::Transient;
    }
    GhErrorCategory::Unknown
}

// ---------------------------------------------------------------------------
// Status-check rollup collapse. Mirrors `collapseRollup` in ghService.ts.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GhCheckState {
    Unknown,
    Pending,
    Success,
    Failure,
    Cancelled,
    Skipped,
}

impl From<GhCheckState> for String {
    fn from(value: GhCheckState) -> Self {
        match value {
            GhCheckState::Unknown => "unknown",
            GhCheckState::Pending => "pending",
            GhCheckState::Success => "success",
            GhCheckState::Failure => "failure",
            GhCheckState::Cancelled => "cancelled",
            GhCheckState::Skipped => "skipped",
        }
        .to_string()
    }
}

fn collapse_rollup(rollup: Option<&[RollupEntry]>) -> GhCheckState {
    let Some(entries) = rollup else {
        return GhCheckState::Unknown;
    };
    if entries.is_empty() {
        return GhCheckState::Unknown;
    }
    let mut has_pending = false;
    for entry in entries {
        let state = entry_state(entry);
        match state.as_str() {
            "failure" | "failed" | "timed_out" | "action_required" => return GhCheckState::Failure,
            "cancelled" | "cancel" => return GhCheckState::Cancelled,
            "pending" | "in_progress" | "queued" | "waiting" => has_pending = true,
            _ => {}
        }
    }
    if has_pending {
        return GhCheckState::Pending;
    }
    let all_skipped = entries.iter().all(|entry| {
        let state = entry_state(entry);
        state == "skipped" || state == "neutral"
    });
    if all_skipped {
        GhCheckState::Skipped
    } else {
        GhCheckState::Success
    }
}

fn entry_state(entry: &RollupEntry) -> String {
    entry
        .conclusion
        .clone()
        .or_else(|| entry.state.clone())
        .or_else(|| entry.status.clone())
        .unwrap_or_default()
        .to_lowercase()
}

fn normalize_pr_state(raw: Option<&str>) -> Option<String> {
    let raw = raw?;
    let upper = raw.to_uppercase();
    matches!(upper.as_str(), "OPEN" | "CLOSED" | "MERGED").then_some(upper)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::events::{persist_timeline_event, PersistTimelineEventInput};
    use crate::persistence::projects::{persist_project, PersistProjectInput, ProjectSettings};
    use crate::persistence::sessions::{persist_session, PersistSessionInput};
    use crate::persistence::workspaces::{persist_workspace, PersistWorkspaceInput};
    use crate::sessions::state::SessionState;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;
    use tempfile::TempDir;

    struct StubRunner {
        responses: Mutex<Vec<ArgmaxResult<String>>>,
        calls: AtomicUsize,
        last_args: Mutex<Vec<String>>,
    }

    impl StubRunner {
        fn new(responses: Vec<ArgmaxResult<String>>) -> Arc<Self> {
            Arc::new(Self {
                responses: Mutex::new(responses),
                calls: AtomicUsize::new(0),
                last_args: Mutex::new(Vec::new()),
            })
        }

        fn runner(self: Arc<Self>) -> GhRunner {
            Arc::new(move |_cwd, args| {
                let next = {
                    let mut responses = self.responses.lock().expect("stub responses poisoned");
                    *self.last_args.lock().expect("stub args poisoned") = args;
                    self.calls.fetch_add(1, Ordering::SeqCst);
                    if responses.is_empty() {
                        None
                    } else {
                        Some(responses.remove(0))
                    }
                };
                Box::pin(async move {
                    next.unwrap_or_else(|| {
                        Err(ArgmaxError::service(
                            "GH_TEST_EXHAUSTED",
                            "stub runner ran out of responses",
                        ))
                    })
                })
            })
        }

        fn call_count(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }

        fn last_args(&self) -> Vec<String> {
            self.last_args.lock().expect("stub args poisoned").clone()
        }
    }

    fn fixture(database: &Arc<Database>, repo_path: &str) -> (String, String) {
        let conn = database.connection();
        persist_project(
            &conn,
            &PersistProjectInput {
                id: "p1".to_string(),
                name: "fixture".to_string(),
                repo_path: repo_path.to_string(),
                default_branch: Some("main".to_string()),
                current_branch: "main".to_string(),
                settings: ProjectSettings {
                    archive_on_merge: false,
                    worktree_location: format!("{repo_path}/.worktrees"),
                    setup_command: String::new(),
                    check_commands: Vec::new(),
                },
            },
        )
        .expect("project");
        persist_workspace(
            &conn,
            &PersistWorkspaceInput {
                id: "w1".to_string(),
                project_id: "p1".to_string(),
                task_label: "gh-test".to_string(),
                branch: "feature/x".to_string(),
                base_ref: "main".to_string(),
                path: repo_path.to_string(),
                state: "running".to_string(),
                shared_workspace: false,
                kind: "git".to_string(),
                dirty: false,
                changed_files: 0,
            },
        )
        .expect("workspace");
        persist_session(
            &conn,
            &PersistSessionInput {
                id: "s1".to_string(),
                workspace_id: "w1".to_string(),
                provider: "claude".to_string(),
                model_label: "Haiku 4.5".to_string(),
                model_id: "claude-haiku-4.5".to_string(),
                reasoning_effort: None,
                permission_mode: Some("auto-approve".to_string()),
                agent_mode: Some("auto".to_string()),
                prompt: "test".to_string(),
                state: SessionState::Running,
            },
        )
        .expect("session");
        ("s1".to_string(), "w1".to_string())
    }

    fn open_db() -> (TempDir, Arc<Database>) {
        let dir = TempDir::new().unwrap();
        let database = Arc::new(Database::open(dir.path().join("argmax.sqlite")).unwrap());
        (dir, database)
    }

    fn success_payload(pr_number: i64, head_sha: &str, rollup_state: &str) -> String {
        format!(
            r#"{{
                "number": {pr_number},
                "headRefOid": "{head_sha}",
                "headRefName": "feature/x",
                "state": "MERGED",
                "createdAt": "2026-05-24T10:00:00Z",
                "mergedAt": "2026-05-24T11:00:00Z",
                "statusCheckRollup": [{{"conclusion": "{rollup_state}"}}]
            }}"#
        )
    }

    #[tokio::test]
    async fn list_for_session_roundtrip() {
        let (_dir, database) = open_db();
        let (session_id, _) = fixture(&database, "/tmp/argmax-gh-list");
        // Pre-seed an existing row so list_for_session has something to read.
        {
            let conn = database.connection();
            upsert_gh_pr(
                &conn,
                &GhPrRecord {
                    session_id: session_id.clone(),
                    pr_number: 42,
                    head_sha: "deadbeef".to_string(),
                    last_seen_check_state: "success".to_string(),
                    updated_at: now_iso(),
                    pr_state: Some("OPEN".to_string()),
                    notified_at: None,
                    pr_created_at: None,
                    pr_merged_at: None,
                    head_ref_name: None,
                },
            )
            .expect("seed gh_pr");
        }
        let stub = StubRunner::new(Vec::new());
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub).runner());
        let rows = service.list_for_session(&session_id).expect("list");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pr_number, 42);
        assert_eq!(rows[0].last_seen_check_state, "success");
        // Read-only — runner must not have been invoked.
        assert_eq!(stub.call_count(), 0);
    }

    #[tokio::test]
    async fn refresh_upserts_pr_row_from_gh_stdout() {
        let (_dir, database) = open_db();
        let (session_id, _) = fixture(&database, "/tmp/argmax-gh-refresh");
        let stub = StubRunner::new(vec![Ok(success_payload(7, "feedface", "success"))]);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub).runner());

        let rows = service.refresh(&session_id).await.expect("refresh");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pr_number, 7);
        assert_eq!(rows[0].head_sha, "feedface");
        assert_eq!(rows[0].last_seen_check_state, "success");
        assert_eq!(rows[0].pr_state.as_deref(), Some("MERGED"));
        assert_eq!(rows[0].head_ref_name.as_deref(), Some("feature/x"));
        assert_eq!(
            rows[0].pr_created_at.as_deref(),
            Some("2026-05-24T10:00:00Z")
        );
        assert_eq!(
            rows[0].pr_merged_at.as_deref(),
            Some("2026-05-24T11:00:00Z")
        );
        assert_eq!(stub.call_count(), 1);
        assert_eq!(
            stub.last_args(),
            vec![
                "pr",
                "view",
                "feature/x",
                "--json",
                "number,headRefOid,headRefName,state,statusCheckRollup,createdAt,mergedAt,url",
            ]
        );

        // Subsequent gh call returns a failure rollup for a new head — same
        // pr_number, but state moves.
        let stub2 = StubRunner::new(vec![Ok(success_payload(7, "cafef00d", "failure"))]);
        let service2 = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub2).runner());
        let rows = service2.refresh(&session_id).await.expect("refresh2");
        assert_eq!(rows.len(), 1, "still one row — upsert keyed on pr_number");
        assert_eq!(rows[0].head_sha, "cafef00d");
        assert_eq!(rows[0].last_seen_check_state, "failure");
    }

    #[tokio::test]
    async fn refresh_populates_project_remote_from_url() {
        let (_dir, database) = open_db();
        let (session_id, _) = fixture(&database, "/tmp/argmax-gh-remote");
        let payload = r#"{
            "number": 15,
            "headRefOid": "abcd1234",
            "headRefName": "feature/x",
            "state": "OPEN",
            "createdAt": "2026-05-24T10:00:00Z",
            "url": "https://github.com/my-org/my-repo/pull/15"
        }"#;
        let stub = StubRunner::new(vec![Ok(payload.to_string())]);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub).runner());
        let rows = service.refresh(&session_id).await.expect("refresh");
        assert_eq!(rows.len(), 1);
        let conn = database.connection();
        let remote = crate::persistence::projects::get_project_remote(&conn, "p1").unwrap();
        assert_eq!(
            remote,
            Some(crate::persistence::projects::ProjectRemote {
                owner: "my-org".to_string(),
                name: "my-repo".to_string(),
            })
        );
    }

    #[tokio::test]
    async fn refresh_returns_cached_rows_when_gh_fails() {
        let (_dir, database) = open_db();
        let (session_id, _) = fixture(&database, "/tmp/argmax-gh-fail");
        // Seed an existing row so we can distinguish "kept the cache" from
        // "nuked the cache".
        {
            let conn = database.connection();
            upsert_gh_pr(
                &conn,
                &GhPrRecord {
                    session_id: session_id.clone(),
                    pr_number: 99,
                    head_sha: "abc123".to_string(),
                    last_seen_check_state: "pending".to_string(),
                    updated_at: now_iso(),
                    pr_state: Some("OPEN".to_string()),
                    notified_at: None,
                    pr_created_at: None,
                    pr_merged_at: None,
                    head_ref_name: None,
                },
            )
            .expect("seed gh_pr");
        }

        let stub = StubRunner::new(vec![Err(ArgmaxError::service(
            "GH_NON_ZERO_EXIT",
            "no pull requests found for branch feature/x",
        ))]);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub).runner());

        let rows = service.refresh(&session_id).await.expect("returns cache");
        assert_eq!(rows.len(), 1, "row preserved on gh failure");
        assert_eq!(rows[0].pr_number, 99);
        assert_eq!(rows[0].last_seen_check_state, "pending");
        // Branch view failed, then the cached OPEN row is retried by number.
        assert_eq!(stub.call_count(), 2);
    }

    #[tokio::test]
    async fn refresh_updates_cached_open_pr_by_number_when_branch_has_none() {
        let (_dir, database) = open_db();
        let (session_id, _) = fixture(&database, "/tmp/argmax-gh-number");
        {
            let conn = database.connection();
            upsert_gh_pr(
                &conn,
                &GhPrRecord {
                    session_id: session_id.clone(),
                    pr_number: 568,
                    head_sha: "oldsha".to_string(),
                    last_seen_check_state: "pending".to_string(),
                    updated_at: now_iso(),
                    pr_state: Some("OPEN".to_string()),
                    notified_at: None,
                    pr_created_at: None,
                    pr_merged_at: None,
                    head_ref_name: Some("fix/other-worktree".to_string()),
                },
            )
            .expect("seed gh_pr");
        }

        let stub = StubRunner::new(vec![
            Err(ArgmaxError::service(
                "GH_NON_ZERO_EXIT",
                "no pull requests found for branch feature/x",
            )),
            Ok(r#"{
                "number": 568,
                "headRefOid": "newsha",
                "headRefName": "fix/other-worktree",
                "state": "MERGED",
                "mergedAt": "2026-09-07T04:00:00Z",
                "statusCheckRollup": [{"conclusion": "success"}]
            }"#
            .to_string()),
        ]);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub).runner());
        let rows = service.refresh(&session_id).await.expect("refresh");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pr_number, 568);
        assert_eq!(rows[0].head_sha, "newsha");
        assert_eq!(rows[0].pr_state.as_deref(), Some("MERGED"));
        assert_eq!(stub.call_count(), 2);
        assert_eq!(
            stub.last_args(),
            vec![
                "pr",
                "view",
                "568",
                "--json",
                "number,headRefOid,headRefName,state,statusCheckRollup,createdAt,mergedAt,url",
            ]
        );
    }

    #[tokio::test]
    async fn refresh_pr_number_views_that_pr_in_the_workspace() {
        let (_dir, database) = open_db();
        let (session_id, _) = fixture(&database, "/tmp/argmax-gh-by-number");
        let stub = StubRunner::new(vec![Ok(r#"{
            "number": 566,
            "headRefOid": "abc123",
            "headRefName": "refactor/drop-profound",
            "state": "OPEN",
            "createdAt": "2026-09-07T03:14:11Z",
            "statusCheckRollup": [{"conclusion": "pending"}]
        }"#
        .to_string())]);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub).runner());
        let rows = service
            .refresh_pr_number(&session_id, 566)
            .await
            .expect("refresh number");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pr_number, 566);
        assert_eq!(
            rows[0].head_ref_name.as_deref(),
            Some("refactor/drop-profound")
        );
        assert_eq!(
            stub.last_args(),
            vec![
                "pr",
                "view",
                "566",
                "--json",
                "number,headRefOid,headRefName,state,statusCheckRollup,createdAt,mergedAt,url",
            ]
        );
    }

    #[tokio::test]
    async fn refresh_discovers_pr_url_from_recent_command_output() {
        let (_dir, database) = open_db();
        let (session_id, _) = fixture(&database, "/tmp/argmax-gh-from-command");
        {
            let conn = database.connection();
            persist_timeline_event(
                &conn,
                &PersistTimelineEventInput {
                    id: "e-create".to_string(),
                    session_id: session_id.clone(),
                    r#type: "command.completed".to_string(),
                    message: "tool_result".to_string(),
                    payload: serde_json::json!({
                        "content": "https://github.com/mentimeter/revops-backoffice/pull/568"
                    }),
                    created_at: None,
                },
            )
            .expect("command event");
        }
        let stub = StubRunner::new(vec![
            Err(ArgmaxError::service(
                "GH_NON_ZERO_EXIT",
                "no pull requests found for branch feature/x",
            )),
            Ok(r#"{
                "number": 568,
                "headRefOid": "head568",
                "headRefName": "fix/ai-discoverability-headline-metric",
                "state": "OPEN",
                "statusCheckRollup": [{"conclusion": "pending"}]
            }"#
            .to_string()),
        ]);
        let service = GhService::with_runner(Arc::clone(&database), Arc::clone(&stub).runner());
        let rows = service.refresh(&session_id).await.expect("refresh");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pr_number, 568);
        assert_eq!(
            rows[0].head_ref_name.as_deref(),
            Some("fix/ai-discoverability-headline-metric")
        );
        assert_eq!(rows[0].pr_state.as_deref(), Some("OPEN"));
        assert_eq!(stub.call_count(), 2);
    }

    #[test]
    fn pr_numbers_from_command_event_reads_create_stdout() {
        let payload = serde_json::json!({
            "content": "https://github.com/mentimeter/revops-backoffice/pull/568",
            "name": "Bash",
        });
        assert_eq!(
            pr_numbers_from_command_event("command.completed", "tool_result", &payload),
            vec![568]
        );
        assert!(pr_numbers_from_command_event("command.started", "Bash", &payload).is_empty());
        assert!(pr_numbers_from_command_event(
            "command.completed",
            "tool_result",
            &serde_json::json!({"content": "no pr here"})
        )
        .is_empty());
    }

    #[tokio::test]
    async fn refresh_propagates_record_not_found_for_unknown_session() {
        let (_dir, database) = open_db();
        let stub = StubRunner::new(Vec::new());
        let service = GhService::with_runner(Arc::clone(&database), stub.runner());
        let err = service
            .refresh("missing")
            .await
            .expect_err("session lookup fails");
        match err {
            ArgmaxError::RecordNotFound { kind, .. } => assert_eq!(kind, "session"),
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn collapse_rollup_failure_dominates() {
        let rollup = vec![
            RollupEntry {
                state: Some("PENDING".to_string()),
                status: None,
                conclusion: None,
            },
            RollupEntry {
                state: None,
                status: None,
                conclusion: Some("FAILURE".to_string()),
            },
        ];
        assert_eq!(collapse_rollup(Some(&rollup)), GhCheckState::Failure);
    }

    #[test]
    fn collapse_rollup_all_skipped_is_skipped() {
        let rollup = vec![
            RollupEntry {
                state: None,
                status: None,
                conclusion: Some("skipped".to_string()),
            },
            RollupEntry {
                state: None,
                status: None,
                conclusion: Some("neutral".to_string()),
            },
        ];
        assert_eq!(collapse_rollup(Some(&rollup)), GhCheckState::Skipped);
    }

    #[test]
    fn collapse_rollup_empty_is_unknown() {
        assert_eq!(collapse_rollup(None), GhCheckState::Unknown);
        assert_eq!(collapse_rollup(Some(&[])), GhCheckState::Unknown);
    }

    #[test]
    fn normalize_pr_state_passes_canonical_values() {
        assert_eq!(normalize_pr_state(Some("open")).as_deref(), Some("OPEN"));
        assert_eq!(
            normalize_pr_state(Some("MERGED")).as_deref(),
            Some("MERGED")
        );
        assert!(normalize_pr_state(Some("draft")).is_none());
        assert!(normalize_pr_state(None).is_none());
    }

    #[test]
    fn gh_error_category_buckets_known_messages() {
        let auth = ArgmaxError::service("GH_NON_ZERO_EXIT", "gh failed: not authenticated");
        assert_eq!(gh_error_category(&auth), GhErrorCategory::Auth);
        let rate = ArgmaxError::service("GH_NON_ZERO_EXIT", "gh failed: API rate limit exceeded");
        assert_eq!(gh_error_category(&rate), GhErrorCategory::RateLimit);
        let no_pr = ArgmaxError::service("GH_NON_ZERO_EXIT", "gh failed: no pull requests found");
        assert_eq!(gh_error_category(&no_pr), GhErrorCategory::NoPr);
        let unknown = ArgmaxError::service("GH_NON_ZERO_EXIT", "something completely different");
        assert_eq!(gh_error_category(&unknown), GhErrorCategory::Unknown);
    }
}
