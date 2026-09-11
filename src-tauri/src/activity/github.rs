//! The Activity page's GitHub half: pull requests the user authored and
//! reviews they submitted, read through `gh` and cached in SQLite.
//!
//! The page never waits on this. `activity:summary` reads whatever is cached
//! and kicks a refresh off in the background when the cache is older than
//! [`REFRESH_INTERVAL`]. A refresh that fails records why and leaves the cache
//! alone, so a flaky network shows yesterday's numbers with a note rather than
//! an empty page.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Months, Utc};
use rusqlite::Connection;
use serde_json::Value;

use crate::activity::{ActivityGithubState, LEDGER_MONTHS};
use crate::error::{ArgmaxError, ArgmaxResult};
use crate::persistence::activity::{self as storage, PullRequestRow, ReviewRow};
use crate::persistence::time::now_iso;
use crate::persistence::Database;
use crate::util::gh_runner::GhRunner;

/// A refresh runs at most this often. GitHub's search API is the rate-limited
/// one (30 requests a minute), and the page is opened far more often than a
/// PR's state changes.
pub const REFRESH_INTERVAL: Duration = Duration::from_secs(10 * 60);
/// How long a failed refresh holds off the next attempt. Without it every
/// page read during a GitHub outage would restart the whole paginated fetch.
pub const RETRY_INTERVAL: Duration = Duration::from_secs(60);
/// One refresh at a time: a page read that lands mid-fetch must not start a
/// second walk over the same pages.
static REFRESH_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// GitHub search caps a result set at 1000 anyway; this stops a pathological
/// `pageInfo` loop from paging forever.
const MAX_PAGES: usize = 10;

const PR_QUERY: &str = r#"
query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number
        title
        url
        state
        isDraft
        createdAt
        mergedAt
        closedAt
        additions
        deletions
        repository { nameWithOwner }
        author { login }
      }
    }
  }
}
"#;

const REVIEW_QUERY: &str = r#"
query($q: String!, $login: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number
        title
        url
        repository { nameWithOwner }
        reviews(first: 50, author: $login) {
          nodes { state submittedAt }
        }
      }
    }
  }
}
"#;

/// What the summary read reports. `available` says the app knows which GitHub
/// account this is; `error` is the last refresh failure, which can be set
/// while cached rows are still being served.
pub fn cached_state(connection: &Connection) -> ArgmaxResult<ActivityGithubState> {
    let login = storage::get_github_meta(connection, storage::GITHUB_META_LOGIN)?;
    Ok(ActivityGithubState {
        available: login.is_some(),
        last_fetched_at: storage::get_github_meta(
            connection,
            storage::GITHUB_META_LAST_FETCHED_AT,
        )?,
        error: storage::get_github_meta(connection, storage::GITHUB_META_LAST_ERROR)?,
        login,
    })
}

/// Whether the cache is old enough to refresh. A cache that was never filled
/// is always stale.
pub fn is_stale(state: &ActivityGithubState, now: DateTime<Utc>) -> bool {
    let Some(fetched) = state
        .last_fetched_at
        .as_deref()
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
    else {
        return true;
    };
    now.signed_duration_since(fetched.with_timezone(&Utc))
        .to_std()
        .map(|elapsed| elapsed >= REFRESH_INTERVAL)
        .unwrap_or(false)
}

/// Refresh the cache in the background if it is stale. Errors are recorded in
/// `activity_github_meta`, never returned: the caller has already answered.
pub fn spawn_refresh_if_stale(
    database: Arc<Database>,
    runner: GhRunner,
    cwd: String,
    state: &ActivityGithubState,
    now: DateTime<Utc>,
) {
    if !is_stale(state, now) {
        return;
    }
    {
        let connection = database.read_connection();
        let last_attempt =
            storage::get_github_meta(&connection, storage::GITHUB_META_LAST_ATTEMPT_AT)
                .ok()
                .flatten();
        if !attempt_due(last_attempt.as_deref(), now) {
            return;
        }
    }
    if REFRESH_IN_FLIGHT.swap(true, Ordering::AcqRel) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        if let Err(error) = refresh(&database, runner, cwd, now).await {
            tracing::warn!(target: "activity", error = %error, "activity GitHub refresh failed");
        }
        REFRESH_IN_FLIGHT.store(false, Ordering::Release);
    });
}

/// Whether enough time has passed since the last attempt, successful or not,
/// to try again.
pub fn attempt_due(last_attempt_at: Option<&str>, now: DateTime<Utc>) -> bool {
    let Some(attempted) =
        last_attempt_at.and_then(|value| DateTime::parse_from_rfc3339(value).ok())
    else {
        return true;
    };
    now.signed_duration_since(attempted.with_timezone(&Utc))
        .to_std()
        .map(|elapsed| elapsed >= RETRY_INTERVAL)
        .unwrap_or(false)
}

/// One refresh: resolve the login, then the authored PRs (created and merged
/// windows), then the reviews. A failure at any step records the reason and
/// stops; the rows already written stay.
pub async fn refresh(
    database: &Arc<Database>,
    runner: GhRunner,
    cwd: String,
    now: DateTime<Utc>,
) -> ArgmaxResult<()> {
    {
        let connection = database.connection();
        storage::set_github_meta(
            &connection,
            storage::GITHUB_META_LAST_ATTEMPT_AT,
            now_iso().as_str(),
        )?;
    }
    let login = match resolve_login(&runner, &cwd).await {
        Ok(login) => login,
        Err(error) => {
            record_error(database, &error)?;
            return Err(error);
        }
    };
    reconcile_login(database, &login)?;

    let since = since_date(now);
    let result = fetch_and_store(database, &runner, &cwd, &login, &since).await;
    match result {
        Ok(()) => {
            let connection = database.connection();
            storage::set_github_meta(
                &connection,
                storage::GITHUB_META_LAST_FETCHED_AT,
                now_iso().as_str(),
            )?;
            storage::clear_github_meta(&connection, storage::GITHUB_META_LAST_ERROR)
        }
        Err(error) => {
            record_error(database, &error)?;
            Err(error)
        }
    }
}

async fn fetch_and_store(
    database: &Arc<Database>,
    runner: &GhRunner,
    cwd: &str,
    login: &str,
    since: &str,
) -> ArgmaxResult<()> {
    // Two searches, because `created:>=` alone misses a PR opened last year and
    // merged last week — which is exactly the PR the page wants to show.
    for filter in [
        format!("author:{login} is:pr created:>={since}"),
        format!("author:{login} is:pr merged:>={since}"),
    ] {
        let mut cursor: Option<String> = None;
        for _ in 0..MAX_PAGES {
            let mut args = vec![
                "api".to_string(),
                "graphql".to_string(),
                "-f".to_string(),
                format!("query={PR_QUERY}"),
                "-f".to_string(),
                format!("q={filter}"),
            ];
            if let Some(cursor) = &cursor {
                args.push("-f".to_string());
                args.push(format!("cursor={cursor}"));
            }
            let body = runner(cwd.to_string(), args).await?;
            let page = parse_pull_requests(&body)?;
            {
                let connection = database.connection();
                storage::upsert_pull_requests(&connection, &page.rows)?;
            }
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
    }

    let filter = format!("reviewed-by:{login} -author:{login} is:pr updated:>={since}");
    let mut cursor: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let mut args = vec![
            "api".to_string(),
            "graphql".to_string(),
            "-f".to_string(),
            format!("query={REVIEW_QUERY}"),
            "-f".to_string(),
            format!("q={filter}"),
            "-f".to_string(),
            format!("login={login}"),
        ];
        if let Some(cursor) = &cursor {
            args.push("-f".to_string());
            args.push(format!("cursor={cursor}"));
        }
        let body = runner(cwd.to_string(), args).await?;
        let page = parse_reviews(&body)?;
        {
            let connection = database.connection();
            storage::upsert_reviews(&connection, &page.rows)?;
        }
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    Ok(())
}

async fn resolve_login(runner: &GhRunner, cwd: &str) -> ArgmaxResult<String> {
    let output = runner(
        cwd.to_string(),
        vec![
            "api".to_string(),
            "user".to_string(),
            "--jq".to_string(),
            ".login".to_string(),
        ],
    )
    .await
    .map_err(plain_english)?;
    let login = output.trim().to_string();
    if login.is_empty() {
        return Err(ArgmaxError::service(
            "ACTIVITY_GH_NO_LOGIN",
            "GitHub CLI answered without a username. Run `gh auth login` and try again.",
        ));
    }
    Ok(login)
}

/// A different login means the cached rows belong to someone else. Dropping
/// them is the only honest option: they would otherwise be counted as this
/// account's work.
fn reconcile_login(database: &Arc<Database>, login: &str) -> ArgmaxResult<()> {
    let connection = database.connection();
    let previous = storage::get_github_meta(&connection, storage::GITHUB_META_LOGIN)?;
    if previous.as_deref() != Some(login) {
        storage::clear_github_cache(&connection)?;
        storage::clear_github_meta(&connection, storage::GITHUB_META_LAST_FETCHED_AT)?;
    }
    storage::set_github_meta(&connection, storage::GITHUB_META_LOGIN, login)
}

fn record_error(database: &Arc<Database>, error: &ArgmaxError) -> ArgmaxResult<()> {
    let connection = database.connection();
    storage::set_github_meta(
        &connection,
        storage::GITHUB_META_LAST_ERROR,
        &error.to_string(),
    )
}

/// Turn the runner's transport failures into something a page can print. The
/// two the user can act on are "not installed" and "not signed in".
fn plain_english(error: ArgmaxError) -> ArgmaxError {
    let message = error.to_string();
    if let ArgmaxError::ServiceError { sub_code, .. } = &error {
        if sub_code == "GH_SPAWN_FAILED" {
            return ArgmaxError::service(
                "ACTIVITY_GH_MISSING",
                "GitHub CLI (gh) is not installed, so pull requests and reviews are unavailable.",
            );
        }
    }
    let lowered = message.to_ascii_lowercase();
    if lowered.contains("gh auth login") || lowered.contains("authentication") {
        return ArgmaxError::service(
            "ACTIVITY_GH_UNAUTHENTICATED",
            "GitHub CLI is not signed in. Run `gh auth login` to show pull requests and reviews.",
        );
    }
    error
}

/// Search filters take a date, not an instant.
fn since_date(now: DateTime<Utc>) -> String {
    now.checked_sub_months(Months::new(LEDGER_MONTHS))
        .unwrap_or(now)
        .format("%Y-%m-%d")
        .to_string()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequestPage {
    pub rows: Vec<PullRequestRow>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewPage {
    pub rows: Vec<ReviewRow>,
    pub next_cursor: Option<String>,
}

pub fn parse_pull_requests(body: &str) -> ArgmaxResult<PullRequestPage> {
    let search = search_node(body)?;
    let mut rows = Vec::new();
    for node in nodes(&search) {
        // A search over `type: ISSUE` also returns issues, which carry none of
        // these fields; the inline fragment leaves them absent rather than null.
        let (Some(number), Some(repository)) = (
            node.get("number").and_then(Value::as_i64),
            node.pointer("/repository/nameWithOwner")
                .and_then(Value::as_str),
        ) else {
            continue;
        };
        let merged_at = optional_string(node.get("mergedAt"));
        let closed_at = optional_string(node.get("closedAt"));
        rows.push(PullRequestRow {
            repository: repository.to_string(),
            number,
            title: node
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            url: node
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            state: pr_state(
                node.get("state").and_then(Value::as_str),
                merged_at.is_some(),
            )
            .to_string(),
            is_draft: node
                .get("isDraft")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            created_at: node
                .get("createdAt")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            merged_at,
            closed_at,
            additions: node.get("additions").and_then(Value::as_i64).unwrap_or(0),
            deletions: node.get("deletions").and_then(Value::as_i64).unwrap_or(0),
            author_login: node
                .pointer("/author/login")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        });
    }
    Ok(PullRequestPage {
        rows,
        next_cursor: next_cursor(&search),
    })
}

pub fn parse_reviews(body: &str) -> ArgmaxResult<ReviewPage> {
    let search = search_node(body)?;
    let mut rows = Vec::new();
    for node in nodes(&search) {
        let (Some(number), Some(repository)) = (
            node.get("number").and_then(Value::as_i64),
            node.pointer("/repository/nameWithOwner")
                .and_then(Value::as_str),
        ) else {
            continue;
        };
        let title = node
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let url = node
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let submissions = node
            .pointer("/reviews/nodes")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        for review in submissions {
            // A PENDING review has no `submittedAt`: it was never sent, so it
            // is not a review the user gave.
            let Some(submitted_at) = optional_string(review.get("submittedAt")) else {
                continue;
            };
            rows.push(ReviewRow {
                repository: repository.to_string(),
                number,
                submitted_at,
                state: review_state(review.get("state").and_then(Value::as_str)).to_string(),
                title: title.clone(),
                url: url.clone(),
            });
        }
    }
    Ok(ReviewPage {
        rows,
        next_cursor: next_cursor(&search),
    })
}

fn search_node(body: &str) -> ArgmaxResult<Value> {
    let parsed: Value = serde_json::from_str(body).map_err(|error| {
        ArgmaxError::service(
            "ACTIVITY_GH_BAD_JSON",
            format!("GitHub returned something that is not JSON: {error}"),
        )
    })?;
    // GraphQL reports failures in a 200 body; without this, a permission error
    // reads as "you have no pull requests".
    if let Some(message) = parsed
        .pointer("/errors/0/message")
        .and_then(Value::as_str)
        .filter(|message| !message.is_empty())
    {
        return Err(ArgmaxError::service(
            "ACTIVITY_GH_GRAPHQL_ERROR",
            message.to_string(),
        ));
    }
    parsed.pointer("/data/search").cloned().ok_or_else(|| {
        ArgmaxError::service(
            "ACTIVITY_GH_UNEXPECTED_SHAPE",
            "GitHub's answer had no search results in it",
        )
    })
}

fn nodes(search: &Value) -> Vec<Value> {
    search
        .get("nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn next_cursor(search: &Value) -> Option<String> {
    let has_next = search
        .pointer("/pageInfo/hasNextPage")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !has_next {
        return None;
    }
    search
        .pointer("/pageInfo/endCursor")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn optional_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// GitHub reports `MERGED` on the PR state, but a search result for an old
/// schema can report `CLOSED` with a `mergedAt`. The timestamp wins.
fn pr_state(state: Option<&str>, merged: bool) -> &'static str {
    if merged {
        return "merged";
    }
    match state {
        Some("MERGED") => "merged",
        Some("CLOSED") => "closed",
        _ => "open",
    }
}

fn review_state(state: Option<&str>) -> &'static str {
    match state {
        Some("APPROVED") => "approved",
        Some("CHANGES_REQUESTED") => "changes_requested",
        _ => "commented",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PR_PAGE: &str = r#"{
      "data": { "search": {
        "pageInfo": { "hasNextPage": true, "endCursor": "Y3Vyc29yOjE=" },
        "nodes": [
          { "number": 12, "title": "Add the Activity page", "url": "https://github.com/menti/argmax/pull/12",
            "state": "MERGED", "isDraft": false, "createdAt": "2026-09-01T08:00:00Z",
            "mergedAt": "2026-09-02T09:30:00Z", "closedAt": "2026-09-02T09:30:00Z",
            "additions": 400, "deletions": 12,
            "repository": { "nameWithOwner": "menti/argmax" }, "author": { "login": "adam" } },
          { "number": 13, "title": "Draft", "url": "https://github.com/menti/argmax/pull/13",
            "state": "OPEN", "isDraft": true, "createdAt": "2026-09-03T08:00:00Z",
            "mergedAt": null, "closedAt": null, "additions": 1, "deletions": 0,
            "repository": { "nameWithOwner": "menti/argmax" }, "author": { "login": "adam" } },
          { "number": 14, "title": "Abandoned", "url": "https://github.com/menti/argmax/pull/14",
            "state": "CLOSED", "isDraft": false, "createdAt": "2026-08-01T08:00:00Z",
            "mergedAt": null, "closedAt": "2026-08-02T08:00:00Z", "additions": 2, "deletions": 2,
            "repository": { "nameWithOwner": "menti/argmax" }, "author": { "login": "adam" } },
          { "title": "An issue, not a pull request" }
        ]
      } }
    }"#;

    const LAST_PR_PAGE: &str = r#"{
      "data": { "search": { "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": [] } }
    }"#;

    const REVIEW_PAGE: &str = r#"{
      "data": { "search": {
        "pageInfo": { "hasNextPage": false, "endCursor": null },
        "nodes": [
          { "number": 900, "title": "Their change", "url": "https://github.com/menti/other/pull/900",
            "repository": { "nameWithOwner": "menti/other" },
            "reviews": { "nodes": [
              { "state": "APPROVED", "submittedAt": "2026-09-04T10:00:00Z" },
              { "state": "CHANGES_REQUESTED", "submittedAt": "2026-09-03T10:00:00Z" },
              { "state": "COMMENTED", "submittedAt": "2026-09-02T10:00:00Z" },
              { "state": "PENDING", "submittedAt": null }
            ] } }
        ]
      } }
    }"#;

    #[test]
    fn pull_request_states_map_and_issues_are_skipped() {
        let page = parse_pull_requests(PR_PAGE).expect("page");

        assert_eq!(
            page.rows
                .iter()
                .map(|row| (row.number, row.state.as_str(), row.is_draft))
                .collect::<Vec<_>>(),
            vec![
                (12, "merged", false),
                (13, "open", true),
                (14, "closed", false)
            ]
        );
        assert_eq!(page.rows[0].repository, "menti/argmax");
        assert_eq!(page.rows[0].additions, 400);
        assert_eq!(page.rows[0].author_login, "adam");
        assert_eq!(page.next_cursor.as_deref(), Some("Y3Vyc29yOjE="));
    }

    #[test]
    fn pagination_stops_when_there_is_no_next_page() {
        let page = parse_pull_requests(LAST_PR_PAGE).expect("page");
        assert!(page.rows.is_empty());
        assert_eq!(page.next_cursor, None);
    }

    #[test]
    fn one_row_per_review_submission_with_pending_dropped() {
        let page = parse_reviews(REVIEW_PAGE).expect("page");

        assert_eq!(
            page.rows
                .iter()
                .map(|row| (row.state.as_str(), row.submitted_at.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("approved", "2026-09-04T10:00:00Z"),
                ("changes_requested", "2026-09-03T10:00:00Z"),
                ("commented", "2026-09-02T10:00:00Z"),
            ]
        );
        assert_eq!(page.rows[0].repository, "menti/other");
        assert_eq!(page.rows[0].number, 900);
        assert_eq!(page.rows[0].title, "Their change");
    }

    #[test]
    fn a_graphql_error_body_is_an_error_not_an_empty_page() {
        let body = r#"{"errors":[{"message":"Resource not accessible by integration"}]}"#;
        let error = parse_pull_requests(body).expect_err("graphql error");
        assert!(error.to_string().contains("not accessible"));
    }

    #[test]
    fn staleness_follows_the_refresh_interval() {
        let now: DateTime<Utc> = "2026-09-10T12:00:00Z".parse().expect("now");
        let fresh = ActivityGithubState {
            available: true,
            login: Some("adam".into()),
            error: None,
            last_fetched_at: Some("2026-09-10T11:55:00Z".into()),
        };
        let old = ActivityGithubState {
            last_fetched_at: Some("2026-09-10T11:45:00Z".into()),
            ..fresh.clone()
        };
        let never = ActivityGithubState {
            last_fetched_at: None,
            ..fresh.clone()
        };

        assert!(!is_stale(&fresh, now));
        assert!(is_stale(&old, now));
        assert!(is_stale(&never, now));
    }

    #[test]
    fn a_failed_attempt_holds_off_the_retry() {
        let now: DateTime<Utc> = "2026-09-10T12:00:00Z".parse().expect("now");
        assert!(attempt_due(None, now));
        assert!(!attempt_due(Some("2026-09-10T11:59:30Z"), now));
        assert!(attempt_due(Some("2026-09-10T11:58:00Z"), now));
        assert!(attempt_due(Some("not a date"), now));
    }
}
