// The PR watch pass (docs/gh.md#pr-watch). It runs inside the gh poller's
// tick, after the refresh fanout, and reads the canonical rows that fanout
// just wrote. It never writes `gh_pull_requests` itself: a second writer
// between the tick's snapshot and `detect_transition` would swallow Arc
// events and the check-failure follow-up (docs/adr/0013-pr-watch.md).

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use sha2::{Digest, Sha256};

use super::service::{
    entry_check_state, gh_working_directory, GhCheckState, GhService, PrAuthor, PrFeedbackGraph,
    PrReviewThread, PrWatchView, RollupEntry, PR_UNAVAILABLE_ERROR,
};
use crate::error::ArgmaxResult;
use crate::persistence::database::Database;
use crate::persistence::pr_watches::{
    clear_pr_watch_notice, delete_pr_watch_by_id, list_pr_watches, record_pr_watch_fetch_failure,
    set_pr_watch_not_found_count, stage_pr_watch_notice, update_pr_watch_cursors, watched_pr_state,
    ConflictState, PendingPrWatchNotice, PrWatchCursors, PrWatchRecord, WatchedPrState,
};

/// A notice body stays under this many characters, URL included.
const MAX_NOTICE_CHARS: usize = 4_000;
/// Items listed per section before "and N more".
const MAX_SECTION_ITEMS: usize = 10;
/// A comment's first line is cut to this many characters.
const MAX_SNIPPET_CHARS: usize = 140;

/// One watch notice, ready for `send_system_notice`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrWatchNotice {
    pub watch_id: String,
    pub session_id: String,
    pub pr_number: i64,
    /// `pr-watch:<watchId>:<seq>:<headSha7>`. The sequence is the watch's
    /// own notice count, so every new notice gets a new id, and a redelivered
    /// staged notice keeps its id for the inbox's `INSERT OR IGNORE`.
    pub message_id: String,
    pub body: String,
}

/// Stores and delivers one notice. `Ok` means the message row exists, whether
/// this call inserted it (`true`) or an earlier attempt did (`false`). `Err`
/// means nothing was stored, so the pass keeps its cursors and tries again.
pub type PrWatchNoticeHook = Arc<
    dyn Fn(PrWatchNotice) -> Pin<Box<dyn Future<Output = ArgmaxResult<bool>> + Send>> + Send + Sync,
>;

/// Consecutive ticks on which GitHub had no such PR before the watch ends.
const MAX_NOT_FOUND_TICKS: i64 = 10;
const DEGRADED_FETCH_COUNT: i64 = 3;

/// Every watch's PR, once. Each failure is logged and skips only that PR.
/// `tick_started_at` is when this tick's refresh fanout began: a row older
/// than that was not refreshed this tick.
pub(crate) async fn run_watch_pass(
    database: &Arc<Database>,
    service: &GhService,
    deliver: &PrWatchNoticeHook,
    tick_started_at: &str,
) -> ArgmaxResult<()> {
    let watches = {
        let connection = database.read_connection();
        list_pr_watches(&connection)?
    };
    for watch in watches {
        if let Err(error) = run_one_watch(database, service, deliver, &watch, tick_started_at).await
        {
            tracing::warn!(
                watch_id = %watch.id,
                pr_number = watch.pr_number,
                ?error,
                "gh.watch: watch pass failed; retrying next tick"
            );
        }
    }
    Ok(())
}

async fn run_one_watch(
    database: &Arc<Database>,
    service: &GhService,
    deliver: &PrWatchNoticeHook,
    watch: &PrWatchRecord,
    tick_started_at: &str,
) -> ArgmaxResult<()> {
    let (pr, cwd, recipient_archived, project_remote) = {
        let connection = database.read_connection();
        let pr = watched_pr_state(&connection, &watch.project_id, watch.pr_number)?;
        let session =
            crate::persistence::sessions::find_session_by_id(&connection, &watch.session_id)?;
        let workspace = crate::persistence::workspaces::find_workspace_by_id(
            &connection,
            &session.workspace_id,
        )?;
        let cwd = gh_working_directory(&connection, &workspace)?;
        let recipient_archived = matches!(
            workspace.state.as_str(),
            "archiving" | "archive-failed" | "archived"
        );
        let project_remote =
            crate::persistence::projects::get_project_remote(&connection, &watch.project_id)?;
        (pr, cwd, recipient_archived, project_remote)
    };

    // A notice staged on an earlier pass whose delivery was not confirmed.
    // Its cursors already moved, so it goes out exactly as staged.
    if let Some(pending) = &watch.pending_notice {
        return deliver_staged(
            database,
            deliver,
            watch,
            pending.clone(),
            recipient_archived,
        )
        .await;
    }

    let Some(pr) = pr else {
        return Ok(());
    };
    // The refresh stores this error when GitHub has no such PR. A PR number
    // that never resolves would otherwise be polled forever.
    if pr.refresh_error.as_deref() == Some(PR_UNAVAILABLE_ERROR) && pr.head_sha.is_empty() {
        if pr.refreshed_at.as_str() < tick_started_at {
            return Ok(());
        }
        let count = watch.not_found_count + 1;
        if count < MAX_NOT_FOUND_TICKS {
            set_pr_watch_not_found_count(&database.connection(), &watch.id, count)?;
            return Ok(());
        }
        let notice = PendingPrWatchNotice {
            id: notice_id(watch, ""),
            body: format!(
                "PR #{} not found; watch removed. GitHub had no such pull request on {count} polls in a row.",
                watch.pr_number
            ),
            ends_watch: true,
        };
        stage_pr_watch_notice(
            &database.connection(),
            &watch.id,
            &current_cursors(watch),
            &notice,
        )?;
        return deliver_staged(database, deliver, watch, notice, recipient_archived).await;
    }
    if watch.not_found_count > 0 {
        set_pr_watch_not_found_count(&database.connection(), &watch.id, 0)?;
    }
    // This tick's refresh failed or did not reach the PR, so the row is stale.
    // Reporting from it could call an already merged PR green. The next tick
    // retries.
    if pr.refresh_error.is_some()
        || pr.head_sha.is_empty()
        || pr.refreshed_at.as_str() < tick_started_at
    {
        return Ok(());
    }

    let view = match service.view_pr_for_watch(&cwd, watch.pr_number).await {
        Ok(view) => view,
        Err(error) => {
            log_fetch_error(watch, "pr view", &error);
            return record_fetch_failure(
                database,
                deliver,
                watch,
                &pr,
                recipient_archived,
                "PR details",
                &error,
            )
            .await;
        }
    };
    // A push landed between the fanout's read and this one. The next tick
    // reads both at the same head.
    if view.head_ref_oid.as_deref() != Some(pr.head_sha.as_str()) {
        return Ok(());
    }

    let terminal = terminal_state(&pr, &view);
    let head_changed = watch.head_sha != pr.head_sha;
    let green_candidate = terminal.is_none()
        && checks_are_green(&view)
        && (head_changed || watch.reported_ready_sha.as_deref() != Some(pr.head_sha.as_str()));
    let wants_threads = terminal.is_none()
        && (watch.seen_feedback_ids.is_none()
            || watch.feedback_fingerprints.is_none()
            || watch.fetch_failure_count > 0
            || head_changed
            || green_candidate
            || view.updated_at != watch.last_pr_updated_at);
    let remote = pr
        .url
        .as_deref()
        .and_then(crate::git::ops::extract_github_remote_from_url)
        .or(project_remote);
    let feedback = match (wants_threads, remote) {
        (true, Some(remote)) => {
            match service.review_threads(&cwd, &remote, watch.pr_number).await {
                Ok(feedback) => Some(feedback),
                Err(error) => {
                    log_fetch_error(watch, "review threads", &error);
                    return record_fetch_failure(
                        database,
                        deliver,
                        watch,
                        &pr,
                        recipient_archived,
                        "review threads",
                        &error,
                    )
                    .await;
                }
            }
        }
        _ => None,
    };
    // A prior failed thread read is only recovered by reading threads. An
    // unavailable repository identity must not turn a partial read into success.
    if watch.fetch_failure_count > 0 && terminal.is_none() && feedback.is_none() {
        return Ok(());
    }

    // Cleanup runs before the merged notice, and so before archive on merge,
    // which waits for this watch to end. It never archives the chat.
    let cleanup = if terminal == Some(Terminal::Merged) && watch.cleanup_on_merge {
        let text = match crate::git::pr_cleanup::cleanup_merged_pr(
            database,
            service,
            &watch.session_id,
            watch.pr_number,
        )
        .await
        {
            Ok(report) => report.text,
            Err(error) => format!("Cleanup failed: {error}"),
        };
        tracing::info!(
            watch_id = %watch.id,
            pr_number = watch.pr_number,
            report = %text,
            "gh.watch: PR cleanup on merge"
        );
        Some(text)
    } else {
        None
    };

    let pass = plan_watch_pass(
        watch,
        &pr,
        &view,
        terminal,
        feedback.as_ref(),
        cleanup.as_deref(),
    );
    let Some(body) = pass.body.clone() else {
        if watch.seen_feedback_ids.is_none()
            || watch.feedback_fingerprints.is_none()
            || pass.cursors != current_cursors(watch)
        {
            let connection = database.connection();
            update_pr_watch_cursors(&connection, &watch.id, &pass.cursors)?;
        }
        return Ok(());
    };

    // An archived chat cannot take a turn, so there is nobody to wake. The
    // watch keeps polling and ends with the PR.
    if recipient_archived {
        if pass.ends_watch {
            let connection = database.connection();
            delete_pr_watch_by_id(&connection, &watch.id)?;
        }
        return Ok(());
    }

    // The notice is staged with the cursors it advances in one write, then
    // delivered, then cleared. A crash in between redelivers this exact
    // notice on the next pass; the inbox ignores a repeated id.
    let notice = PendingPrWatchNotice {
        id: notice_id(watch, &pr.head_sha),
        body,
        ends_watch: pass.ends_watch,
    };
    stage_pr_watch_notice(&database.connection(), &watch.id, &pass.cursors, &notice)?;
    deliver_staged(database, deliver, watch, notice, false).await
}

/// Delivers a staged notice, then clears it or ends the watch. `Err` from the
/// hook leaves it staged for the next pass.
async fn deliver_staged(
    database: &Arc<Database>,
    deliver: &PrWatchNoticeHook,
    watch: &PrWatchRecord,
    notice: PendingPrWatchNotice,
    recipient_archived: bool,
) -> ArgmaxResult<()> {
    if !recipient_archived {
        deliver(PrWatchNotice {
            watch_id: watch.id.clone(),
            session_id: watch.session_id.clone(),
            pr_number: watch.pr_number,
            message_id: notice.id.clone(),
            body: notice.body.clone(),
        })
        .await?;
    }
    let connection = database.connection();
    if notice.ends_watch {
        delete_pr_watch_by_id(&connection, &watch.id)
    } else {
        clear_pr_watch_notice(&connection, &watch.id)
    }
}

fn log_fetch_error(watch: &PrWatchRecord, what: &str, error: &super::service::GhFetchError) {
    if error.rate_limited {
        tracing::debug!(
            watch_id = %watch.id,
            pr_number = watch.pr_number,
            "gh.watch: {what} rate limited; skipping this tick"
        );
    } else {
        tracing::warn!(
            watch_id = %watch.id,
            pr_number = watch.pr_number,
            error = %error.message,
            "gh.watch: {what} failed; skipping this tick"
        );
    }
}

async fn record_fetch_failure(
    database: &Arc<Database>,
    deliver: &PrWatchNoticeHook,
    watch: &PrWatchRecord,
    pr: &WatchedPrState,
    recipient_archived: bool,
    what: &str,
    error: &super::service::GhFetchError,
) -> ArgmaxResult<()> {
    let count = (watch.fetch_failure_count + 1).min(DEGRADED_FETCH_COUNT);
    let notice = (count == DEGRADED_FETCH_COUNT && !watch.fetch_degraded && !recipient_archived)
        .then(|| PendingPrWatchNotice {
            id: notice_id(watch, &pr.head_sha),
            body: notice_body(
                watch.pr_number,
                pr,
                &["watch degraded".to_string()],
                &[format!(
                    "Could not complete watch reads on 3 consecutive polls. Feedback and check notices may be delayed. Argmax will keep retrying.\nLast failed read: {what}.\nLast error: {}",
                    first_line(Some(&error.message))
                )],
            ),
            ends_watch: false,
        });
    record_pr_watch_fetch_failure(
        &database.connection(),
        &watch.id,
        count,
        watch.fetch_degraded || notice.is_some(),
        notice.as_ref(),
    )?;
    if let Some(notice) = notice {
        deliver_staged(database, deliver, watch, notice, recipient_archived).await?;
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Terminal {
    Merged,
    Closed,
}

/// The state this pass's own view read wins over the refreshed row.
fn terminal_state(pr: &WatchedPrState, view: &PrWatchView) -> Option<Terminal> {
    let state = view
        .state
        .as_deref()
        .filter(|state| !state.is_empty())
        .or(pr.pr_state.as_deref())?;
    match state.to_ascii_uppercase().as_str() {
        "MERGED" => Some(Terminal::Merged),
        "CLOSED" => Some(Terminal::Closed),
        _ => None,
    }
}

/// Every check on the head finished without failing. An empty rollup is not
/// green: checks register a moment after a push.
fn checks_are_green(view: &PrWatchView) -> bool {
    let entries = view.status_check_rollup.as_deref().unwrap_or_default();
    !entries.is_empty()
        && entries.iter().all(|entry| {
            matches!(
                entry_check_state(entry),
                GhCheckState::Success | GhCheckState::Skipped
            )
        })
}

fn current_cursors(watch: &PrWatchRecord) -> PrWatchCursors {
    PrWatchCursors {
        head_sha: watch.head_sha.clone(),
        seen_check_failures: watch.seen_check_failures.clone(),
        seen_feedback_ids: watch.seen_feedback_ids.clone().unwrap_or_default(),
        feedback_fingerprints: watch.feedback_fingerprints.clone().unwrap_or_default(),
        fetch_failure_count: watch.fetch_failure_count,
        fetch_degraded: watch.fetch_degraded,
        reported_ready_sha: watch.reported_ready_sha.clone(),
        last_pr_updated_at: watch.last_pr_updated_at.clone(),
        conflict_state: watch.conflict_state,
    }
}

/// What this read says about the PR's conflict with its base. `UNKNOWN`, a
/// missing field, and any value Argmax does not know give `None`, which leaves
/// the stored cursor alone: GitHub reports `UNKNOWN` while it recomputes after
/// a push, and treating that as "clean" would announce a conflict twice.
fn observed_conflict(view: &PrWatchView) -> Option<ConflictState> {
    match view.mergeable.as_deref()?.to_ascii_uppercase().as_str() {
        "CONFLICTING" => Some(ConflictState::Conflicting),
        "MERGEABLE" => Some(ConflictState::Clean),
        _ => None,
    }
}

/// What one pass found: the notice to send (if any) and the cursors to store
/// with it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct WatchPass {
    body: Option<String>,
    cursors: PrWatchCursors,
    ends_watch: bool,
}

struct FeedbackItem {
    line: String,
    edited: bool,
}

fn plan_watch_pass(
    watch: &PrWatchRecord,
    pr: &WatchedPrState,
    view: &PrWatchView,
    terminal: Option<Terminal>,
    graph: Option<&PrFeedbackGraph>,
    cleanup: Option<&str>,
) -> WatchPass {
    let threads = graph.map(|graph| graph.threads.as_slice());
    let no_bots = HashSet::new();
    let bots = graph.map_or(&no_bots, |graph| &graph.bot_logins);
    let head = pr.head_sha.as_str();
    let head7: String = head.chars().take(7).collect();
    let head_changed = watch.head_sha != head;
    let mut cursors = PrWatchCursors {
        head_sha: head.to_string(),
        seen_check_failures: if head_changed {
            Vec::new()
        } else {
            watch.seen_check_failures.clone()
        },
        seen_feedback_ids: watch.seen_feedback_ids.clone().unwrap_or_default(),
        feedback_fingerprints: watch.feedback_fingerprints.clone().unwrap_or_default(),
        fetch_failure_count: 0,
        fetch_degraded: false,
        reported_ready_sha: if head_changed {
            None
        } else {
            watch.reported_ready_sha.clone()
        },
        last_pr_updated_at: if threads.is_some() {
            view.updated_at.clone()
        } else {
            watch.last_pr_updated_at.clone()
        },
        conflict_state: watch.conflict_state,
    };
    let mut summary = Vec::new();
    let mut sections = Vec::new();

    if let Some(terminal) = terminal {
        let text = match terminal {
            Terminal::Merged => {
                let merge_commit: String = view
                    .merge_commit
                    .as_ref()
                    .map(|commit| commit.oid.chars().take(7).collect())
                    .unwrap_or_default();
                if merge_commit.is_empty() {
                    "merged".to_string()
                } else {
                    format!("merged as {merge_commit} (head {head7})")
                }
            }
            Terminal::Closed => "closed without merging".to_string(),
        };
        summary.push(text);
        if let Some(report) = cleanup {
            sections.push(format!("Cleanup:\n{report}"));
        }
        sections.push("This watch has ended.".to_string());
        return finish(watch.pr_number, pr, summary, sections, cursors, true);
    }

    if watch.fetch_degraded {
        summary.push("watch recovered".to_string());
        sections.push(
            "PR details and review threads are readable again. Watch notices have resumed."
                .to_string(),
        );
    }

    // Checks failing: each `workflow/name@sha` once per failure. A check seen
    // running or passing again is forgotten, so a re-run that fails on the
    // same head is reported again.
    let mut failing = Vec::new();
    for entry in view.status_check_rollup.as_deref().unwrap_or_default() {
        let key = check_key(entry, head);
        if !matches!(
            entry_check_state(entry),
            GhCheckState::Failure | GhCheckState::Cancelled
        ) {
            cursors.seen_check_failures.retain(|seen| seen != &key);
            continue;
        }
        if cursors.seen_check_failures.contains(&key) || failing.iter().any(|(k, _)| k == &key) {
            continue;
        }
        failing.push((key, check_line(entry)));
    }
    if !failing.is_empty() {
        summary.push(format!(
            "{} failing on {head7}",
            plural(failing.len(), "check", "checks")
        ));
        sections.push(section(
            &format!("Checks failing on {head7}:"),
            failing.iter().map(|(_, line)| line.clone()).collect(),
        ));
        for (key, _) in failing {
            cursors.seen_check_failures.push(key);
        }
    }

    // Merge conflict, once per transition. The terminal branch above returned
    // already, so a merged or closed PR never reports one. A first read of
    // `MERGEABLE` seeds the cursor without a notice; a first read of
    // `CONFLICTING` is reported, because the agent has not been told.
    match (watch.conflict_state, observed_conflict(view)) {
        (prior, Some(ConflictState::Conflicting)) if prior != Some(ConflictState::Conflicting) => {
            let base = view.base_ref_name.as_deref().unwrap_or("its base branch");
            summary.push("merge conflict".to_string());
            sections.push(format!(
                "Merge conflict: this PR cannot merge into {base} until the conflict is resolved. \
                 Update the branch from {base} and resolve it."
            ));
            cursors.conflict_state = Some(ConflictState::Conflicting);
        }
        (Some(ConflictState::Conflicting), Some(ConflictState::Clean)) => {
            summary.push("merge conflict resolved".to_string());
            cursors.conflict_state = Some(ConflictState::Clean);
        }
        (None, Some(ConflictState::Clean)) => {
            cursors.conflict_state = Some(ConflictState::Clean);
        }
        _ => {}
    }

    // New feedback. The first pass seeds what predates the watch.
    let seeding_before = watch
        .seen_feedback_ids
        .is_none()
        .then(|| parse_time(&watch.created_at))
        .flatten();
    let seen: HashSet<&str> = watch
        .seen_feedback_ids
        .as_deref()
        .unwrap_or_default()
        .iter()
        .map(String::as_str)
        .collect();
    let mut feedback: Vec<FeedbackItem> = Vec::new();
    let mut observed_ids = HashSet::new();
    let mut observe = |id: &str,
                       at: Option<&str>,
                       body: Option<&str>,
                       state: &str,
                       reportable: bool,
                       line: String| {
        if !observed_ids.insert(id.to_string()) {
            return;
        }
        let fingerprint = feedback_fingerprint(body, state);
        let previous = cursors
            .feedback_fingerprints
            .insert(id.to_string(), fingerprint.clone());
        let edited = previous.as_ref().is_some_and(|old| old != &fingerprint);
        if seen.contains(id) && !edited {
            // A legacy ID without a hash seeds its baseline without replay.
            return;
        }
        if !seen.contains(id) {
            cursors.seen_feedback_ids.push(id.to_string());
        }
        let predates_watch = seeding_before.is_some_and(|created| {
            at.and_then(parse_time)
                .is_none_or(|item_at| item_at < created)
        });
        if reportable && !predates_watch {
            feedback.push(FeedbackItem {
                line: if edited {
                    format!("edited {line}")
                } else {
                    line
                },
                edited,
            });
        }
    };
    for review in view.reviews.as_deref().unwrap_or_default() {
        let state = review.state.as_deref().unwrap_or("COMMENTED");
        let snippet = first_line(review.body.as_deref());
        // An empty COMMENTED review only wraps thread comments, which are
        // reported on their own.
        let reportable = !(snippet.is_empty() && state == "COMMENTED");
        let on_commit = review
            .commit
            .as_ref()
            .map(|commit| format!(" on {}", commit.oid.chars().take(7).collect::<String>()))
            .unwrap_or_default();
        let line = with_snippet(
            format!(
                "review by {}: {state}{on_commit}",
                author_label(review.author.as_ref(), bots)
            ),
            &snippet,
            None,
        );
        observe(
            &review.id,
            review.submitted_at.as_deref(),
            review.body.as_deref(),
            state,
            reportable,
            line,
        );
    }
    for comment in view.comments.as_deref().unwrap_or_default() {
        let line = with_snippet(
            format!("comment by {}", author_label(comment.author.as_ref(), bots)),
            &first_line(comment.body.as_deref()),
            comment.url.as_deref(),
        );
        observe(
            &comment.id,
            comment.created_at.as_deref(),
            comment.body.as_deref(),
            "",
            comment.viewer_did_author != Some(true),
            line,
        );
    }
    for thread in threads.unwrap_or_default() {
        for comment in &thread.comments.nodes {
            let line = with_snippet(
                format!(
                    "thread comment by {} on {}",
                    author_label(comment.author.as_ref(), bots),
                    thread_location(thread)
                ),
                &first_line(comment.body.as_deref()),
                comment.url.as_deref(),
            );
            observe(
                &comment.id,
                comment.created_at.as_deref(),
                comment.body.as_deref(),
                "",
                comment.viewer_did_author != Some(true),
                line,
            );
        }
    }
    if !feedback.is_empty() {
        let has_edits = feedback.iter().any(|item| item.edited);
        summary.push(plural(
            feedback.len(),
            if has_edits {
                "new or edited feedback item"
            } else {
                "new feedback item"
            },
            if has_edits {
                "new or edited feedback items"
            } else {
                "new feedback items"
            },
        ));
        sections.push(section(
            if has_edits {
                "New or edited feedback:"
            } else {
                "New feedback:"
            },
            feedback.iter().map(|item| item.line.clone()).collect(),
        ));
    }

    // Checks green, once per head. Argmax reports what the merge gate needs
    // and leaves the decision to the agent.
    if checks_are_green(view) && cursors.reported_ready_sha.as_deref() != Some(head) {
        summary.push(format!("checks green on {head7}"));
        let unresolved: Vec<String> = threads
            .unwrap_or_default()
            .iter()
            .filter(|thread| !thread.is_resolved)
            .map(|thread| {
                let first = thread.comments.nodes.first();
                with_snippet(
                    format!(
                        "{} by {}",
                        thread_location(thread),
                        author_label(first.and_then(|comment| comment.author.as_ref()), bots)
                    ),
                    &first_line(first.and_then(|comment| comment.body.as_deref())),
                    first.and_then(|comment| comment.url.as_deref()),
                )
            })
            .collect();
        if unresolved.is_empty() {
            sections.push("No unresolved review threads.".to_string());
        } else {
            sections.push(section(
                &format!("Unresolved review threads ({}):", unresolved.len()),
                unresolved,
            ));
        }
        let requested: Vec<String> = view
            .review_requests
            .as_deref()
            .unwrap_or_default()
            .iter()
            .filter_map(|request| {
                request
                    .login
                    .clone()
                    .or_else(|| request.slug.clone())
                    .or_else(|| request.name.clone())
            })
            .collect();
        if !requested.is_empty() {
            sections.push(format!("Review requested from: {}.", requested.join(", ")));
        }
        // This read, not the stored cursor: after a push GitHub says `UNKNOWN`
        // while it recomputes, and a hint taken from the old cursor would
        // report a conflict the push may have resolved.
        if observed_conflict(view) == Some(ConflictState::Conflicting) {
            sections.push("The PR still has a merge conflict with its base.".to_string());
        }
        sections.push("Apply the merge gate before merging.".to_string());
        cursors.reported_ready_sha = Some(head.to_string());
    }

    finish(watch.pr_number, pr, summary, sections, cursors, false)
}

fn finish(
    pr_number: i64,
    pr: &WatchedPrState,
    summary: Vec<String>,
    sections: Vec<String>,
    cursors: PrWatchCursors,
    ends_watch: bool,
) -> WatchPass {
    let body = (!summary.is_empty()).then(|| notice_body(pr_number, pr, &summary, &sections));
    WatchPass {
        body,
        cursors,
        ends_watch,
    }
}

/// First line `PR #<n> (<title>): <summary>.`, then each section, then the
/// URL alone on the last line. Cut to `MAX_NOTICE_CHARS`, URL kept.
fn notice_body(
    pr_number: i64,
    pr: &WatchedPrState,
    summary: &[String],
    sections: &[String],
) -> String {
    let title = pr.title.as_deref().unwrap_or("untitled");
    let mut text = format!("PR #{pr_number} ({title}): {}.", summary.join(", "));
    for section in sections {
        text.push('\n');
        text.push_str(section);
    }
    let url = pr.url.clone().unwrap_or_default();
    let budget = MAX_NOTICE_CHARS.saturating_sub(url.chars().count() + 1);
    if text.chars().count() > budget {
        text = text.chars().take(budget.saturating_sub(2)).collect();
        text.push_str(" …");
    }
    format!("{text}\n{url}")
}

fn section(heading: &str, items: Vec<String>) -> String {
    let mut lines = vec![heading.to_string()];
    let extra = items.len().saturating_sub(MAX_SECTION_ITEMS);
    lines.extend(
        items
            .into_iter()
            .take(MAX_SECTION_ITEMS)
            .map(|item| format!("- {item}")),
    );
    if extra > 0 {
        lines.push(format!("- and {extra} more"));
    }
    lines.join("\n")
}

fn check_line(entry: &RollupEntry) -> String {
    let name = entry.name.as_deref().unwrap_or("check");
    let label = match entry
        .workflow_name
        .as_deref()
        .filter(|name| !name.is_empty())
    {
        Some(workflow) => format!("{workflow} / {name}"),
        None => name.to_string(),
    };
    match entry.details_url.as_deref().filter(|url| !url.is_empty()) {
        Some(url) => format!("{label}: {url}"),
        None => label,
    }
}

fn with_snippet(prefix: String, snippet: &str, url: Option<&str>) -> String {
    let mut line = prefix;
    if !snippet.is_empty() {
        line.push_str(": ");
        line.push_str(snippet);
    }
    if let Some(url) = url.filter(|url| !url.is_empty()) {
        line.push(' ');
        line.push_str(url);
    }
    line
}

fn thread_location(thread: &PrReviewThread) -> String {
    let path = thread.path.as_deref().unwrap_or("?");
    match thread.line {
        Some(line) => format!("{path}:{line}"),
        None => path.to_string(),
    }
}

/// Bot authors are marked so the agent can apply the merge gate's bot rules.
/// `gh pr view` drops the type, so its authors are matched against the bot
/// logins the GraphQL read found.
fn author_label(author: Option<&PrAuthor>, bots: &HashSet<String>) -> String {
    let Some(author) = author.filter(|author| !author.login.is_empty()) else {
        return "unknown".to_string();
    };
    let is_bot = author.login.ends_with("[bot]")
        || author.typename.as_deref() == Some("Bot")
        || bots.contains(&author.login);
    if is_bot && !author.login.ends_with("[bot]") {
        format!("{} [bot]", author.login)
    } else {
        author.login.clone()
    }
}

fn first_line(body: Option<&str>) -> String {
    let line = body
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default();
    if line.chars().count() > MAX_SNIPPET_CHARS {
        let cut: String = line.chars().take(MAX_SNIPPET_CHARS).collect();
        format!("{cut}…")
    } else {
        line.to_string()
    }
}

fn feedback_fingerprint(body: Option<&str>, state: &str) -> String {
    let mut hash = Sha256::new();
    hash.update((state.len() as u64).to_be_bytes());
    hash.update(state.as_bytes());
    hash.update(body.unwrap_or_default().as_bytes());
    hash.finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn plural(count: usize, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}

fn parse_time(value: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|time| time.with_timezone(&chrono::Utc))
}

fn notice_id(watch: &PrWatchRecord, head_sha: &str) -> String {
    let head7: String = head_sha.chars().take(7).collect();
    format!("pr-watch:{}:{}:{head7}", watch.id, watch.notice_seq + 1)
}

fn check_key(entry: &RollupEntry, head: &str) -> String {
    let name = entry.name.as_deref().unwrap_or("check");
    match entry
        .workflow_name
        .as_deref()
        .filter(|workflow| !workflow.is_empty())
    {
        Some(workflow) => format!("{workflow}/{name}@{head}"),
        None => format!("{name}@{head}"),
    }
}
