//! Completion notices for launched sessions. The provider lifecycle owns turn
//! transitions; this policy owns quiet windows, notice content, and inbox rows.
//!
//! A notice is two things. The inbox row is the durable result: it is written,
//! and `session_wait` is woken, the moment the turn ends. The wake that starts
//! a turn in the launcher is automatic and may be held for a short window, so
//! siblings that finish together cost the launcher one turn rather than one
//! each. Holding the wake never holds the result.

use super::{runtime::sqlite_error, session_service::MessageOrigin};
use crate::{
    error::ArgmaxResult,
    persistence::{
        database::Database,
        events::{find_event_by_id, latest_agent_answer, latest_user_message_id},
        session_messages::{
            clear_wake_due, insert_session_message, is_message_delivered, list_due_wakes,
            mark_message_delivered, mark_wake_due, NewSessionMessage, SessionMessage,
            COMPLETION_KIND, MAX_MESSAGE_BODY_CHARS,
        },
        sessions::find_session_by_id,
        workspaces::find_workspace_by_id,
    },
    sessions::state::SessionState,
    util::sync::LockOrRecover,
};
use serde_json::Value;
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};
use uuid::Uuid;

/// How much of a child's final answer a completion notice carries. The notice
/// is a summary handed back through the inbox, which has its own reply ceiling
/// — a whole transcript-length answer belongs to `session_read`.
const NOTICE_ANSWER_CHARS: usize = 4 * 1024;
/// How much of the learnings section a capped notice keeps. The head already
/// spent the budget; this is the tail that made the answer worth reading.
const NOTICE_LEARNINGS_CHARS: usize = 2 * 1024;
/// The section an Arc member is asked to end its final answer with. The
/// coordinator is the only writer of the arc folder, so the notice is the one
/// channel a member's learnings travel on — a cap that drops it costs the Arc
/// the whole point of the turn. See docs/arcs.md.
const LEARNINGS_HEADING: &str = "Learnings for the arc";
/// How long a launched chat the user is talking to in its own tab must stay
/// quiet before its launcher hears about it, as one digest rather than a turn
/// per reply.
const USER_TURN_DIGEST_QUIET_SECS: u64 = 900;
/// How long the automatic wake waits for sibling notices to the same launcher.
/// A fixed window from the first notice, not a sliding one, so a steady trickle
/// of finishes cannot hold the wake back for ever.
pub(super) const COMPLETION_BATCH_WINDOW: Duration = Duration::from_secs(2);
/// Results one batch row carries. A launcher has at most this many launches,
/// so a larger pile is several batches, never one that cannot fit its row.
const MAX_BATCH_MEMBERS: usize = 20;
/// The longest label a pointer line repeats.
const POINTER_LABEL_CHARS: usize = 80;
/// Room kept per result for the pointer line that stands in for one too large
/// to share the row. The line is fixed text, two session ids and a label capped
/// at `POINTER_LABEL_CHARS`, which is well under this.
const BATCH_POINTER_RESERVE: usize = 400;

/// The head of a long answer plus, when the answer ends with one, its
/// learnings section. A member's most valuable paragraph is its last, and a
/// plain head cut threw it away: over the first real Arc only 31 of 86
/// notices still carried the section the member wrote it for.
fn cap_notice_answer(answer: &str) -> String {
    if answer.chars().count() <= NOTICE_ANSWER_CHARS {
        return answer.to_string();
    }
    let cut = char_offset(answer, NOTICE_ANSWER_CHARS);
    // Cut on a line boundary so the head does not end mid-sentence.
    let head = answer[..cut]
        .rfind('\n')
        .map(|end| &answer[..end])
        .unwrap_or(&answer[..cut])
        .trim_end();
    match learnings_offset(answer, cut) {
        Some(start) => format!(
            "{head}\n\n(… middle truncated …)\n\n{}",
            cap_learnings_section(&answer[start..])
        ),
        None => format!("{head}\n\n(truncated)"),
    }
}

/// Where the learnings section starts, if it starts past `after` — a heading
/// already inside the head needs no second copy.
fn learnings_offset(answer: &str, after: usize) -> Option<usize> {
    let mut start = 0;
    for line in answer.split_inclusive('\n') {
        if start >= after && is_learnings_heading(line) {
            return Some(start);
        }
        start += line.len();
    }
    None
}

/// `## Learnings for the arc`, `**Learnings for the arc**`, or the bare line —
/// members write all three.
fn is_learnings_heading(line: &str) -> bool {
    let line = line.trim();
    let line = line.trim_start_matches('#').trim();
    let line = line.trim_start_matches("**").trim_end_matches("**").trim();
    let line = line.trim_end_matches([':', '.']).trim();
    line.eq_ignore_ascii_case(LEARNINGS_HEADING)
}

fn cap_learnings_section(section: &str) -> String {
    if section.chars().count() <= NOTICE_LEARNINGS_CHARS {
        return section.to_string();
    }
    let cut = char_offset(section, NOTICE_LEARNINGS_CHARS);
    format!("{}\n\n(truncated)", section[..cut].trim_end())
}

/// The byte offset of the `chars`th character, or the end of the string.
fn char_offset(text: &str, chars: usize) -> usize {
    text.char_indices()
        .nth(chars)
        .map(|(index, _)| index)
        .unwrap_or(text.len())
}

/// The sentence the launcher reads above the answer. The two shapes differ
/// only here, so the lookups that fill them stay in one place.
fn notice_body(
    shape: &NoticeShape,
    session_id: &str,
    label: &str,
    state: SessionState,
    at: &str,
    answer: &str,
) -> String {
    let when = notice_local_time(at);
    match shape {
        NoticeShape::Finished { direct_exchanges } => {
            let aside = direct_exchanges
                .as_ref()
                .map(|exchanges| {
                    format!(
                        " (the user also had {} direct exchange(s) with it since {})",
                        exchanges.count, exchanges.since
                    )
                })
                .unwrap_or_default();
            format!(
                "Session {session_id} ({label}) finished with state {state} at {when}.{aside} Final answer:\n{answer}"
            )
        }
        NoticeShape::UserTurnDigest(exchanges) => format!(
            "Session {session_id} ({label}) answered the user directly {} time(s) since {} and has been quiet for {} minutes; latest answer at {when}:\n{answer}",
            exchanges.count,
            exchanges.since,
            USER_TURN_DIGEST_QUIET_SECS / 60,
        ),
    }
}

/// Whether the newest `user.message` is one the person typed in the chat's own
/// tab: a turn from another session carries an `origin`, a Goal's or the
/// scheduler's carries a `starter`, and the session's first message is the
/// prompt its launcher sent.
fn turn_was_user_driven(latest_payload: &Value, is_first: bool) -> bool {
    !is_first && latest_payload.get("origin").is_none() && latest_payload.get("starter").is_none()
}

/// Every prompt the session has ever taken, clear boundaries included — only
/// the very first one can be the launch prompt.
fn count_user_messages(connection: &rusqlite::Connection, session_id: &str) -> ArgmaxResult<i64> {
    connection
        .prepare_cached(
            "SELECT COUNT(*) FROM events WHERE session_id = ? AND type = 'user.message'",
        )
        .map_err(sqlite_error)?
        .query_row([session_id], |row| row.get::<_, i64>(0))
        .map_err(sqlite_error)
}

/// The moment a notice reports, in the machine's zone. A coordinator reads
/// its members' notices with no clock of its own and dates its notes from
/// them; over a multi-day Arc that drifted by hours. chrono's `Local` offset
/// carries no zone name, so this prints the numeric offset rather than an
/// abbreviation like `CEST`.
fn notice_local_time(at: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(at)
        .map(|moment| {
            moment
                .with_timezone(&chrono::Local)
                .format("%Y-%m-%d %H:%M %:z")
                .to_string()
        })
        .unwrap_or_else(|_| at.to_string())
}

/// A label short enough that a pointer line stays inside its reserve.
fn capped_label(label: &str) -> String {
    let label = label.trim().replace(['\n', '\r'], " ");
    if label.chars().count() <= POINTER_LABEL_CHARS {
        return label;
    }
    let head: String = label.chars().take(POINTER_LABEL_CHARS - 3).collect();
    format!("{head}...")
}

/// One notice standing for several. Each result keeps its own body, and with
/// it the finish time the child wrote. A result that would push the row past
/// the inbox body cap becomes a pointer to `session_read` instead of being cut
/// mid-answer.
fn batch_notice(notices: &[CompletionNotice]) -> CompletionNotice {
    debug_assert!(notices.len() <= MAX_BATCH_MEMBERS);
    let count = notices.len();
    let first = &notices[0];
    let mut body = format!(
        "{count} sessions you launched finished within a few seconds of each other. Each result below keeps its own finish time.\n"
    );
    let mut used = body.chars().count();
    for (index, notice) in notices.iter().enumerate() {
        let section = format!("\n--- {}/{count} ---\n{}\n", index + 1, notice.body);
        let pointers_after = count - index - 1;
        let fits = used + section.chars().count() + BATCH_POINTER_RESERVE * pointers_after
            <= MAX_MESSAGE_BODY_CHARS;
        let section = if fits {
            section
        } else {
            format!(
                "\n--- {}/{count} ---\nSession {id} ({label}) finished. Its result did not fit in this message. Read it with session_read on session {id}.\n",
                index + 1,
                id = notice.origin.session_id,
                label = capped_label(&notice.origin.label),
            )
        };
        used += section.chars().count();
        body.push_str(&section);
    }
    let message_id = format!(
        "completion-batch:{}:{}",
        first.to_session_id, first.message_id
    );
    CompletionNotice {
        message_id: message_id.clone(),
        to_session_id: first.to_session_id.clone(),
        body,
        origin: MessageOrigin {
            session_id: first.origin.session_id.clone(),
            label: format!("{count} launched sessions"),
            kind: COMPLETION_KIND.to_string(),
            message_id: Some(message_id),
        },
    }
}

/// A recorded completion notice, on its way to the launching session as a
/// turn. The row is already in `session_messages`; this is the delivery.
#[derive(Debug, Clone)]
pub(super) struct CompletionNotice {
    pub(super) message_id: String,
    pub(super) to_session_id: String,
    pub(super) body: String,
    pub(super) origin: MessageOrigin,
}

/// What a completion notice is reporting, which is the one thing that differs
/// between the two bodies the launcher can receive.
enum NoticeShape {
    /// A turn the launcher itself set off. `direct_exchanges` folds in a
    /// digest the user's own replies had opened and this turn cancels.
    Finished {
        direct_exchanges: Option<DirectExchanges>,
    },
    /// The user had been replying in the launched chat's own tab, and it has
    /// now been quiet for `USER_TURN_DIGEST_QUIET_SECS`.
    UserTurnDigest(DirectExchanges),
}

/// Turns the person drove in a launched chat themselves, since `since`.
#[derive(Debug, Clone, PartialEq)]
struct DirectExchanges {
    count: u32,
    since: String,
}

/// A launched chat's open quiet window. `token` is unique per scheduling, so
/// the timer that wakes to a replaced or cancelled window does nothing.
struct UserTurnDigest {
    token: String,
    exchanges: DirectExchanges,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
}

/// Notices for one launcher whose automatic wake is waiting out the window.
struct OpenBatch {
    notices: Vec<CompletionNotice>,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
}

pub(super) struct CompletionNoticePolicy {
    database: Arc<Database>,
    window: Duration,
    digests: Mutex<HashMap<String, UserTurnDigest>>,
    batches: Mutex<HashMap<String, OpenBatch>>,
    delivery_tasks: Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>,
    /// Tells waiters a row exists. Runs as soon as the row is written.
    announce: Arc<dyn Fn(&str) + Send + Sync>,
    deliver: Arc<dyn Fn(CompletionNotice) -> NoticeDelivery + Send + Sync>,
}

type NoticeDelivery = Pin<Box<dyn Future<Output = ()> + Send>>;

impl Drop for CompletionNoticePolicy {
    fn drop(&mut self) {
        for digest in self
            .digests
            .lock_or_recover("user turn digests")
            .values_mut()
        {
            if let Some(task) = digest.task.take() {
                task.abort();
            }
        }
        for batch in self
            .batches
            .lock_or_recover("completion batches")
            .values_mut()
        {
            if let Some(task) = batch.task.take() {
                task.abort();
            }
        }
        for (_, task) in self
            .delivery_tasks
            .lock_or_recover("completion notice deliveries")
            .drain()
        {
            task.abort();
        }
    }
}

impl CompletionNoticePolicy {
    pub(super) fn new(
        database: Arc<Database>,
        window: Duration,
        announce: impl Fn(&str) + Send + Sync + 'static,
        deliver: impl Fn(CompletionNotice) -> NoticeDelivery + Send + Sync + 'static,
    ) -> Arc<Self> {
        Arc::new(Self {
            database,
            window,
            digests: Mutex::new(HashMap::new()),
            batches: Mutex::new(HashMap::new()),
            delivery_tasks: Mutex::new(HashMap::new()),
            announce: Arc::new(announce),
            deliver: Arc::new(deliver),
        })
    }

    pub(super) fn turn_ended(
        self: &Arc<Self>,
        session_id: &str,
        state: SessionState,
        at: &str,
    ) -> ArgmaxResult<()> {
        if !self.session_has_launcher(session_id)? {
            return Ok(());
        }
        if self.turn_was_driven_by_the_user(session_id)? {
            self.schedule_user_turn_digest(session_id, state, at);
            return Ok(());
        }
        let direct_exchanges = self.take_user_turn_digest(session_id);
        self.emit_completion_notice(
            session_id,
            state,
            at,
            NoticeShape::Finished { direct_exchanges },
        );
        Ok(())
    }

    fn session_has_launcher(&self, session_id: &str) -> ArgmaxResult<bool> {
        let connection = self.database.read_connection();
        let session = find_session_by_id(&connection, session_id)?;
        Ok(session
            .launched_by_session_id
            .is_some_and(|parent| parent != session_id))
    }

    /// Whether the turn that just ended is one the person typed in this
    /// chat's own tab. The launch prompt is the session's first `user.message`
    /// and belongs to the launcher; every later automatic turn — an agent's
    /// `session_message`, a completion notice — carries an `origin`. What is
    /// left is the person.
    fn turn_was_driven_by_the_user(&self, session_id: &str) -> ArgmaxResult<bool> {
        let connection = self.database.read_connection();
        let latest = latest_user_message_id(&connection, session_id)?
            .map(|id| find_event_by_id(&connection, &id))
            .transpose()?
            .flatten();
        let Some(latest) = latest else {
            return Ok(false);
        };
        let is_first = count_user_messages(&connection, session_id)? <= 1;
        Ok(turn_was_user_driven(&latest.payload, is_first))
    }

    /// Restart the launched chat's quiet window. Only the timer that still
    /// owns the window delivers, so a burst of replies costs the launcher one
    /// turn rather than one per reply.
    fn schedule_user_turn_digest(
        self: &Arc<Self>,
        session_id: &str,
        state: SessionState,
        at: &str,
    ) {
        let token = Uuid::new_v4().to_string();
        let mut digests = self.digests.lock_or_recover("user turn digests");
        let digest = digests
            .entry(session_id.to_string())
            .or_insert_with(|| UserTurnDigest {
                token: token.clone(),
                exchanges: DirectExchanges {
                    count: 0,
                    since: notice_local_time(at),
                },
                task: None,
            });
        if let Some(task) = digest.task.take() {
            task.abort();
        }
        digest.token = token.clone();
        digest.exchanges.count = digest.exchanges.count.saturating_add(1);
        let exchanges = digest.exchanges.clone();
        let policy = Arc::downgrade(self);
        let session_id = session_id.to_string();
        let at = at.to_string();
        digest.task = Some(tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(USER_TURN_DIGEST_QUIET_SECS)).await;
            let Some(policy) = policy.upgrade() else {
                return;
            };
            {
                let mut digests = policy.digests.lock_or_recover("user turn digests");
                if digests.get(&session_id).map(|digest| digest.token.as_str()) != Some(&token) {
                    return;
                }
                digests.remove(&session_id);
            }
            policy.emit_completion_notice(
                &session_id,
                state,
                &at,
                NoticeShape::UserTurnDigest(exchanges),
            );
        }));
    }

    /// Close an open quiet window, so the turn that closed it reports the
    /// user's exchanges rather than leaving a second notice behind.
    fn take_user_turn_digest(&self, session_id: &str) -> Option<DirectExchanges> {
        self.digests
            .lock_or_recover("user turn digests")
            .remove(session_id)
            .map(|mut digest| {
                if let Some(task) = digest.task.take() {
                    task.abort();
                }
                digest.exchanges
            })
    }

    fn emit_completion_notice(
        self: &Arc<Self>,
        session_id: &str,
        state: SessionState,
        at: &str,
        shape: NoticeShape,
    ) {
        match self.build_completion_notice(session_id, state, at, shape) {
            Ok(Some(notice)) => {
                // The row is durable and the launcher's `session_wait` wakes
                // now. Only the turn that tells an idle launcher waits.
                (self.announce)(&notice.to_session_id);
                self.hold_for_batch(notice);
            }
            Ok(None) => {}
            Err(error) => tracing::warn!(
                session_id,
                ?error,
                "failed to record the completion notice for the launching session"
            ),
        }
    }

    /// Add the notice to its launcher's open window, opening one if needed.
    fn hold_for_batch(self: &Arc<Self>, notice: CompletionNotice) {
        let launcher_id = notice.to_session_id.clone();
        let mut batches = self.batches.lock_or_recover("completion batches");
        let batch = batches
            .entry(launcher_id.clone())
            .or_insert_with(|| OpenBatch {
                notices: Vec::new(),
                task: None,
            });
        if batch
            .notices
            .iter()
            .any(|held| held.message_id == notice.message_id)
        {
            return;
        }
        batch.notices.push(notice);
        if batch.task.is_some() {
            return;
        }
        let policy = Arc::downgrade(self);
        let window = self.window;
        batch.task = Some(tauri::async_runtime::spawn(async move {
            tokio::time::sleep(window).await;
            if let Some(policy) = policy.upgrade() {
                policy.flush_batch(&launcher_id);
            }
        }));
    }

    /// Close a launcher's window and wake it once for what is still unread.
    fn flush_batch(self: &Arc<Self>, launcher_id: &str) {
        let Some(batch) = self
            .batches
            .lock_or_recover("completion batches")
            .remove(launcher_id)
        else {
            return;
        };
        match self.coalesce(&batch.notices) {
            Ok(wakes) => {
                for notice in wakes {
                    self.start_delivery(notice);
                }
            }
            Err(error) => {
                // Every row is still in the inbox. Wake per notice rather than
                // leave the launcher unwoken.
                tracing::warn!(launcher_id, ?error, "could not batch completion notices");
                for notice in batch.notices {
                    self.start_delivery(notice);
                }
            }
        }
    }

    /// The notices to wake the launcher with, from the ones still unread.
    /// A result its launcher already collected (`session_wait`, `inbox_read`)
    /// needs no wake. One unread result is sent as it is. Several become a
    /// batch row that carries each result whole, written in the same
    /// transaction that closes the individual rows: the individual rows stay
    /// as the durable record, the batch row is what the launcher still has to
    /// collect if its wake never lands.
    fn coalesce(&self, notices: &[CompletionNotice]) -> ArgmaxResult<Vec<CompletionNotice>> {
        let mut connection = self.database.connection();
        let transaction = connection.transaction().map_err(sqlite_error)?;
        let mut unread = Vec::new();
        for notice in notices {
            if !is_message_delivered(&transaction, &notice.message_id)? {
                unread.push(notice.clone());
            }
        }
        let mut wakes = Vec::new();
        let mut announce = false;
        for members in unread.chunks(MAX_BATCH_MEMBERS) {
            let [only] = members else {
                let batch = batch_notice(members);
                let row = NewSessionMessage {
                    id: batch.message_id.clone(),
                    from_session_id: None,
                    to_session_id: batch.to_session_id.clone(),
                    body: batch.body.clone(),
                    kind: COMPLETION_KIND.to_string(),
                };
                // Already written means an earlier flush owns this batch.
                if insert_session_message(&transaction, &row)? {
                    mark_wake_due(&transaction, &batch.message_id)?;
                    for member in members {
                        mark_message_delivered(&transaction, &member.message_id)?;
                    }
                    announce = true;
                    wakes.push(batch);
                }
                continue;
            };
            wakes.push(only.clone());
        }
        transaction.commit().map_err(sqlite_error)?;
        if announce {
            // The batch row is new to a launcher blocked in `session_wait`.
            (self.announce)(&unread[0].to_session_id);
        }
        Ok(wakes)
    }

    /// Boot: wake launchers whose coalescing window died with the app. The
    /// durable `wake_due_at` mark says which completion rows never had their
    /// wake attempted. Rows already collected, rows held in the follow-up
    /// journal (the composer shows them as paused or unsent), and rows from
    /// before the mark existed are not woken for. Launchers whose workspace is
    /// being archived are dropped, as at write time. Individual rows go through
    /// the same window as live ones so siblings still coalesce; a batch row is
    /// already one notice and is delivered as it is. Delivery then follows the
    /// ordinary policy: a launcher with no turn running gets one, one that is
    /// running queues it.
    pub(super) fn recover_pending_wakes(self: &Arc<Self>) -> ArgmaxResult<usize> {
        let due = list_due_wakes(&self.database.read_connection())?;
        let mut woken = 0;
        for row in due {
            let known = self
                .delivery_tasks
                .lock_or_recover("completion notice deliveries")
                .contains_key(&row.id);
            if known {
                continue;
            }
            let Some(notice) = self.notice_from_row(&row)? else {
                clear_wake_due(&self.database.connection(), &row.id)?;
                continue;
            };
            woken += 1;
            if row.id.starts_with("completion-batch:") {
                self.start_delivery(notice);
            } else {
                self.hold_for_batch(notice);
            }
        }
        Ok(woken)
    }

    /// Rebuild the in-memory notice for a durable row, or `None` when its
    /// launcher can no longer be woken.
    fn notice_from_row(&self, row: &SessionMessage) -> ArgmaxResult<Option<CompletionNotice>> {
        let connection = self.database.read_connection();
        let Ok(launcher) = find_session_by_id(&connection, &row.to_session_id) else {
            return Ok(None);
        };
        let workspace = find_workspace_by_id(&connection, &launcher.workspace_id)?;
        if matches!(
            workspace.state.as_str(),
            "archiving" | "archive-failed" | "archived"
        ) {
            return Ok(None);
        }
        let (child_id, label) = match row.id.strip_prefix("completion-batch:") {
            // `completion-batch:<launcher>:completion:<child>:<turn end>`
            Some(rest) => {
                let child = rest
                    .split(':')
                    .skip_while(|part| *part != "completion")
                    .nth(1)
                    .unwrap_or(&row.to_session_id)
                    .to_string();
                (child, "launched sessions".to_string())
            }
            None => {
                let child = row
                    .from_session_id
                    .clone()
                    .unwrap_or_else(|| row.to_session_id.clone());
                let label = find_session_by_id(&connection, &child)
                    .and_then(|child| find_workspace_by_id(&connection, &child.workspace_id))
                    .map(|workspace| workspace.task_label)
                    .unwrap_or_else(|_| child.clone());
                (child, label)
            }
        };
        Ok(Some(CompletionNotice {
            message_id: row.id.clone(),
            to_session_id: row.to_session_id.clone(),
            body: row.body.clone(),
            origin: MessageOrigin {
                session_id: child_id,
                label,
                kind: COMPLETION_KIND.to_string(),
                message_id: Some(row.id.clone()),
            },
        }))
    }

    fn start_delivery(self: &Arc<Self>, notice: CompletionNotice) {
        let message_id = notice.message_id.clone();
        let delivery = (self.deliver)(notice);
        let policy = Arc::downgrade(self);
        let mut tasks = self
            .delivery_tasks
            .lock_or_recover("completion notice deliveries");
        let completed_id = message_id.clone();
        let task = tauri::async_runtime::spawn(async move {
            delivery.await;
            if let Some(policy) = policy.upgrade() {
                // Attempted, whatever came of it: boot must not wake again.
                if let Err(error) = clear_wake_due(&policy.database.connection(), &completed_id) {
                    tracing::warn!(?error, "could not clear a completion wake mark");
                }
                policy
                    .delivery_tasks
                    .lock_or_recover("completion notice deliveries")
                    .remove(&completed_id);
            }
        });
        tasks.insert(message_id, task);
    }

    fn build_completion_notice(
        &self,
        session_id: &str,
        state: SessionState,
        at: &str,
        shape: NoticeShape,
    ) -> ArgmaxResult<Option<CompletionNotice>> {
        let mut connection = self.database.connection();
        let session = find_session_by_id(&connection, session_id)?;
        let Some(parent_id) = session.launched_by_session_id.clone() else {
            return Ok(None);
        };
        if parent_id == session_id {
            return Ok(None);
        }
        let Ok(parent) = find_session_by_id(&connection, &parent_id) else {
            return Ok(None);
        };
        let parent_workspace = find_workspace_by_id(&connection, &parent.workspace_id)?;
        if matches!(
            parent_workspace.state.as_str(),
            "archiving" | "archive-failed" | "archived"
        ) {
            return Ok(None);
        }
        let label = find_workspace_by_id(&connection, &session.workspace_id)
            .map(|workspace| workspace.task_label)
            .unwrap_or_else(|_| session_id.to_string());
        let answer = latest_agent_answer(&connection, session_id)?
            .filter(|text| !text.trim().is_empty())
            .map(|text| cap_notice_answer(&text))
            .unwrap_or_else(|| "(the session produced no assistant message)".to_string());
        let body = notice_body(&shape, session_id, &label, state, at, &answer);
        // A check-in wake exists to poke a chat that has not reported back.
        // This one just did, so the routine has nothing left to ask.
        if let Err(error) = crate::persistence::routines::delete_routine(
            &connection,
            &crate::session_control::check_in_routine_id(session_id),
        ) {
            tracing::debug!(session_id, ?error, "no check-in routine to clear");
        }
        let message = NewSessionMessage {
            // Deterministic, so a retry of the same turn end writes the same
            // row rather than a second notice.
            id: format!("completion:{session_id}:{at}"),
            from_session_id: Some(session_id.to_string()),
            to_session_id: parent_id.clone(),
            body: body.clone(),
            kind: COMPLETION_KIND.to_string(),
        };
        // The row and its wake mark commit together: a crash between them
        // would leave an unread row that boot never wakes the launcher for.
        let transaction = connection.transaction().map_err(sqlite_error)?;
        if !insert_session_message(&transaction, &message)? {
            return Ok(None);
        }
        mark_wake_due(&transaction, &message.id)?;
        transaction.commit().map_err(sqlite_error)?;
        Ok(Some(CompletionNotice {
            message_id: message.id.clone(),
            to_session_id: parent_id,
            body,
            origin: MessageOrigin {
                session_id: session_id.to_string(),
                label,
                kind: COMPLETION_KIND.to_string(),
                message_id: Some(message.id),
            },
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::session_messages::{
        count_undelivered_messages, take_undelivered_messages,
    };
    use serde_json::json;

    fn long_answer(marker: &str) -> String {
        let mut answer = String::new();
        while answer.chars().count() <= NOTICE_ANSWER_CHARS {
            answer.push_str(marker);
            answer.push('\n');
        }
        answer
    }

    #[test]
    fn a_long_answer_without_learnings_keeps_the_head() {
        let capped = cap_notice_answer(&long_answer("body line"));
        assert!(capped.starts_with("body line\n"));
        assert!(capped.ends_with("\n\n(truncated)"));
        assert!(!capped.contains("(… middle truncated …)"));
        // The head stops on a line boundary rather than mid-word.
        assert!(capped.trim_end_matches("\n\n(truncated)").ends_with("line"));
    }

    #[test]
    fn a_long_answer_keeps_a_learnings_section_past_the_cut() {
        let answer = format!(
            "{}## Learnings for the arc\n\n- Worktrees vanish mid-task.\n- The hook runs twice.\n",
            long_answer("body line")
        );
        let capped = cap_notice_answer(&answer);
        assert!(capped.starts_with("body line\n"));
        assert!(capped.contains("(… middle truncated …)"));
        assert!(capped.contains("## Learnings for the arc"));
        assert!(capped.contains("- Worktrees vanish mid-task."));
        assert!(capped.ends_with("- The hook runs twice.\n"));
    }

    #[test]
    fn a_bold_learnings_heading_past_the_cut_counts() {
        let answer = format!(
            "{}**learnings for the arc**\n\n- Grok announces then acts.\n",
            long_answer("body line")
        );
        let capped = cap_notice_answer(&answer);
        assert!(capped.contains("**learnings for the arc**"));
        assert!(capped.contains("- Grok announces then acts."));
    }

    #[test]
    fn learnings_already_inside_the_head_are_not_repeated() {
        let answer = format!(
            "## Learnings for the arc\n\n- Said once.\n{}",
            long_answer("body line")
        );
        let capped = cap_notice_answer(&answer);
        assert_eq!(capped.matches("Learnings for the arc").count(), 1);
        assert_eq!(capped.matches("- Said once.").count(), 1);
        assert!(capped.ends_with("\n\n(truncated)"));
    }

    #[test]
    fn an_overlong_learnings_section_is_itself_capped() {
        let mut learnings = String::from("## Learnings for the arc\n");
        while learnings.chars().count() <= NOTICE_LEARNINGS_CHARS {
            learnings.push_str("- one more thing\n");
        }
        let capped = cap_notice_answer(&format!("{}{learnings}", long_answer("body line")));
        assert!(capped.contains("## Learnings for the arc"));
        assert!(capped.ends_with("\n\n(truncated)"));
        assert!(capped.chars().count() < NOTICE_ANSWER_CHARS + NOTICE_LEARNINGS_CHARS + 64);
    }

    #[test]
    fn a_composer_turn_after_the_launch_prompt_is_user_driven() {
        let composer = json!({ "source": "composer", "agentMode": "auto" });
        assert!(turn_was_user_driven(&composer, false));
        // The launch prompt looks the same and belongs to the launcher.
        assert!(!turn_was_user_driven(&composer, true));
    }

    #[test]
    fn a_turn_with_an_origin_is_not_user_driven() {
        let from_agent = json!({
            "source": "composer",
            "agentMode": "auto",
            "origin": { "sessionId": "parent", "label": "Coordinator", "kind": "message" },
        });
        assert!(!turn_was_user_driven(&from_agent, false));
    }

    #[test]
    fn a_scheduled_or_goal_wake_is_not_user_driven() {
        let from_schedule =
            json!({ "source": "composer", "agentMode": "auto", "starter": "schedule" });
        let from_goal = json!({ "source": "composer", "agentMode": "auto", "starter": "goal" });
        assert!(!turn_was_user_driven(&from_schedule, false));
        assert!(!turn_was_user_driven(&from_goal, false));
    }

    #[test]
    fn a_finished_notice_carries_the_local_time() {
        let body = notice_body(
            &NoticeShape::Finished {
                direct_exchanges: None,
            },
            "session-1",
            "Fix the cap",
            SessionState::Complete,
            "2026-09-20T12:32:10.123Z",
            "All done.",
        );
        assert!(
            body.starts_with("Session session-1 (Fix the cap) finished with state complete at ")
        );
        assert!(body.contains("2026-09-20 ") || body.contains("2026-09-19 "));
        assert!(body.ends_with(". Final answer:\nAll done."));
    }

    #[test]
    fn a_finished_notice_folds_in_the_users_own_exchanges() {
        let body = notice_body(
            &NoticeShape::Finished {
                direct_exchanges: Some(DirectExchanges {
                    count: 3,
                    since: "2026-09-20 09:05 +02:00".to_string(),
                }),
            },
            "session-1",
            "Fix the cap",
            SessionState::Complete,
            "2026-09-20T12:32:10.123Z",
            "All done.",
        );
        assert!(body.contains(
            " (the user also had 3 direct exchange(s) with it since 2026-09-20 09:05 +02:00) Final answer:"
        ));
    }

    #[test]
    fn a_digest_notice_names_the_count_and_the_quiet_window() {
        let body = notice_body(
            &NoticeShape::UserTurnDigest(DirectExchanges {
                count: 18,
                since: "2026-09-20 09:05 +02:00".to_string(),
            }),
            "session-1",
            "Fix the cap",
            SessionState::Complete,
            "2026-09-20T12:32:10.123Z",
            "All done.",
        );
        assert!(body.starts_with(
            "Session session-1 (Fix the cap) answered the user directly 18 time(s) since 2026-09-20 09:05 +02:00 and has been quiet for 15 minutes; latest answer at "
        ));
        assert!(body.ends_with(":\nAll done."));
    }

    const WINDOW: Duration = Duration::from_millis(150);

    struct Harness {
        database: Arc<Database>,
        policy: Arc<CompletionNoticePolicy>,
        announced: Arc<Mutex<Vec<String>>>,
        delivered: Arc<Mutex<Vec<CompletionNotice>>>,
    }

    fn harness() -> Harness {
        let database = Arc::new(Database::open_in_memory().expect("open db"));
        {
            let connection = database.connection();
            connection
                .execute(
                    "INSERT INTO projects (id, name, repo_path, current_branch, worktree_location, created_at, updated_at) VALUES ('p1', 'p1', '/tmp/p1', 'main', '~/.argmax', 't', 't')",
                    [],
                )
                .expect("project");
            connection
                .execute(
                    "INSERT INTO workspaces (id, project_id, task_label, branch, base_ref, path, state, last_activity_at, created_at, updated_at) VALUES ('w1', 'p1', 'task', 'b', 'main', '/tmp/w1', 'running', 't', 't', 't')",
                    [],
                )
                .expect("workspace");
            for (id, launched_by) in [
                ("parent", None),
                ("other-parent", None),
                ("c1", Some("parent")),
                ("c2", Some("parent")),
                ("c3", Some("parent")),
                ("d1", Some("other-parent")),
            ] {
                connection
                    .execute(
                        "INSERT INTO sessions (id, workspace_id, provider, model_label, model_id, permission_mode, agent_mode, prompt, state, attention, started_at, last_activity_at, launched_by_session_id, launch_depth, launch_kind) VALUES (?, 'w1', 'claude', 'S', 'm', 'auto-approve', 'auto', 'p', 'complete', 'none', 't', 't', ?, 1, 'agent')",
                        rusqlite::params![id, launched_by],
                    )
                    .expect("session");
                connection
                    .execute(
                        "INSERT INTO events (id, session_id, type, message, payload_json, created_at) VALUES (?, ?, 'user.message', 'launch prompt', '{}', 't')",
                        rusqlite::params![format!("u-{id}"), id],
                    )
                    .expect("prompt");
                connection
                    .execute(
                        "INSERT INTO events (id, session_id, type, message, payload_json, created_at) VALUES (?, ?, 'message.completed', ?, '{}', 't')",
                        rusqlite::params![format!("a-{id}"), id, format!("result of {id}")],
                    )
                    .expect("answer");
            }
        }
        let announced = Arc::new(Mutex::new(Vec::new()));
        let delivered = Arc::new(Mutex::new(Vec::new()));
        let policy = CompletionNoticePolicy::new(
            Arc::clone(&database),
            WINDOW,
            {
                let announced = Arc::clone(&announced);
                move |launcher: &str| {
                    announced.lock().unwrap().push(launcher.to_string());
                }
            },
            {
                let delivered = Arc::clone(&delivered);
                move |notice| {
                    delivered.lock().unwrap().push(notice);
                    Box::pin(async {})
                }
            },
        );
        Harness {
            database,
            policy,
            announced,
            delivered,
        }
    }

    async fn after_window() {
        tokio::time::sleep(WINDOW * 4).await;
    }

    #[tokio::test]
    async fn siblings_finishing_together_wake_the_launcher_once_and_keep_every_result() {
        let h = harness();
        for (child, at) in [
            ("c1", "2026-10-04T10:00:00.100Z"),
            ("c2", "2026-10-04T10:00:00.200Z"),
            ("c3", "2026-10-04T10:00:00.300Z"),
        ] {
            h.policy
                .turn_ended(child, SessionState::Complete, at)
                .expect("turn ended");
        }

        // Inside the window the results are already durable and waiters woke;
        // only the automatic turn is being held.
        assert_eq!(h.announced.lock().unwrap().len(), 3);
        assert!(h.delivered.lock().unwrap().is_empty());
        assert_eq!(
            count_undelivered_messages(&h.database.connection(), "parent").unwrap(),
            3
        );

        after_window().await;

        let delivered = h.delivered.lock().unwrap();
        assert_eq!(delivered.len(), 1, "one wake for three siblings");
        let batch = &delivered[0];
        assert!(batch.message_id.starts_with("completion-batch:parent:"));
        // Always an origin: a batched wake is never mistaken for the person.
        assert_eq!(batch.origin.kind, COMPLETION_KIND);
        assert_eq!(
            batch.origin.message_id.as_deref(),
            Some(batch.message_id.as_str())
        );
        for child in ["c1", "c2", "c3"] {
            assert!(
                batch.body.contains(&format!("result of {child}")),
                "{}",
                batch.body
            );
            assert!(batch.body.contains(&format!("Session {child} (")));
        }
        assert!(batch.body.contains("--- 1/3 ---") && batch.body.contains("--- 3/3 ---"));
        // The three results stay as rows with their own times; the batch row is
        // the one thing the launcher still has to collect.
        let mut connection = h.database.connection();
        let rows: Vec<String> = connection
            .prepare("SELECT id FROM session_messages WHERE to_session_id = 'parent' ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(rows.len(), 4, "{rows:?}");
        let undelivered =
            take_undelivered_messages(&mut connection, "parent", 10, 100_000).unwrap();
        assert_eq!(undelivered.len(), 1);
        assert_eq!(undelivered[0].id, batch.message_id);
        // The batch woke a `session_wait` that was blocked on the launcher.
        assert_eq!(h.announced.lock().unwrap().len(), 4);
    }

    #[tokio::test]
    async fn a_lone_notice_is_delivered_unchanged_after_the_window() {
        let h = harness();
        h.policy
            .turn_ended("c1", SessionState::Complete, "2026-10-04T10:00:00.100Z")
            .expect("turn ended");
        after_window().await;
        let delivered = h.delivered.lock().unwrap();
        assert_eq!(delivered.len(), 1);
        assert_eq!(
            delivered[0].message_id,
            "completion:c1:2026-10-04T10:00:00.100Z"
        );
        assert!(delivered[0].body.starts_with("Session c1 ("));
        assert_eq!(delivered[0].origin.kind, COMPLETION_KIND);
    }

    #[tokio::test]
    async fn results_collected_inside_the_window_are_not_woken_for_again() {
        let h = harness();
        for (child, at) in [
            ("c1", "2026-10-04T10:00:00.100Z"),
            ("c2", "2026-10-04T10:00:00.200Z"),
            ("c3", "2026-10-04T10:00:00.300Z"),
        ] {
            h.policy
                .turn_ended(child, SessionState::Complete, at)
                .expect("turn ended");
        }
        // `session_wait` takes two of them before the window closes.
        {
            let mut connection = h.database.connection();
            let taken = take_undelivered_messages(&mut connection, "parent", 2, 100_000).unwrap();
            assert_eq!(taken.len(), 2);
        }
        after_window().await;
        let delivered = h.delivered.lock().unwrap();
        assert_eq!(delivered.len(), 1);
        assert!(
            delivered[0].message_id.starts_with("completion:c"),
            "a single unread result is sent as itself"
        );
    }

    #[tokio::test]
    async fn nothing_wakes_when_every_result_was_already_collected() {
        let h = harness();
        for (child, at) in [
            ("c1", "2026-10-04T10:00:00.100Z"),
            ("c2", "2026-10-04T10:00:00.200Z"),
        ] {
            h.policy
                .turn_ended(child, SessionState::Complete, at)
                .expect("turn ended");
        }
        take_undelivered_messages(&mut h.database.connection(), "parent", 10, 100_000).unwrap();
        after_window().await;
        assert!(h.delivered.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn windows_are_per_launcher_and_a_late_finish_opens_a_new_one() {
        let h = harness();
        h.policy
            .turn_ended("c1", SessionState::Complete, "2026-10-04T10:00:00.100Z")
            .unwrap();
        h.policy
            .turn_ended("d1", SessionState::Complete, "2026-10-04T10:00:00.150Z")
            .unwrap();
        after_window().await;
        assert_eq!(
            h.delivered.lock().unwrap().len(),
            2,
            "two launchers, two wakes"
        );

        h.policy
            .turn_ended("c2", SessionState::Complete, "2026-10-04T10:00:09.000Z")
            .unwrap();
        after_window().await;
        let delivered = h.delivered.lock().unwrap();
        assert_eq!(delivered.len(), 3, "a later finish is not lost");
        assert!(delivered[2].body.contains("result of c2"));
    }

    fn notice_with_body(child: &str, body: String) -> CompletionNotice {
        CompletionNotice {
            message_id: format!("completion:{child}:t"),
            to_session_id: "parent".to_string(),
            body,
            origin: MessageOrigin {
                session_id: child.to_string(),
                label: format!("task {child}"),
                kind: COMPLETION_KIND.to_string(),
                message_id: Some(format!("completion:{child}:t")),
            },
        }
    }

    #[test]
    fn a_batch_never_cuts_a_result_and_points_at_those_that_do_not_fit() {
        let big = "x".repeat(MAX_MESSAGE_BODY_CHARS / 2);
        let notices = vec![
            notice_with_body("c1", format!("first {big}")),
            notice_with_body("c2", format!("second {big}")),
            notice_with_body("c3", "third small".to_string()),
        ];
        let batch = batch_notice(&notices);
        assert!(batch.body.chars().count() <= MAX_MESSAGE_BODY_CHARS);
        assert!(batch.body.contains(&format!("first {big}")));
        assert!(
            !batch.body.contains("second xxx"),
            "an oversize result is never half-quoted"
        );
        assert!(batch
            .body
            .contains("Read it with session_read on session c2"));
        assert!(
            batch.body.contains("session_read on session c3") || batch.body.contains("third small")
        );
    }

    /// A policy over an existing database, as after a restart. With
    /// `never_finish` its wake never completes, which is a crash mid-attempt.
    fn policy_over(
        database: &Arc<Database>,
        window: Duration,
        never_finish: bool,
    ) -> (
        Arc<CompletionNoticePolicy>,
        Arc<Mutex<Vec<CompletionNotice>>>,
    ) {
        let delivered = Arc::new(Mutex::new(Vec::new()));
        let policy = CompletionNoticePolicy::new(Arc::clone(database), window, |_: &str| {}, {
            let delivered = Arc::clone(&delivered);
            move |notice| {
                delivered.lock().unwrap().push(notice);
                if never_finish {
                    Box::pin(std::future::pending())
                } else {
                    Box::pin(async {})
                }
            }
        });
        (policy, delivered)
    }

    fn seed_child(database: &Database, id: &str, label: &str) {
        let connection = database.connection();
        connection
            .execute(
                "INSERT INTO workspaces (id, project_id, task_label, branch, base_ref, path, state, last_activity_at, created_at, updated_at) VALUES (?, 'p1', ?, 'b', 'main', '/tmp/w', 'running', 't', 't', 't')",
                rusqlite::params![format!("w-{id}"), label],
            )
            .expect("workspace");
        connection
            .execute(
                "INSERT INTO sessions (id, workspace_id, provider, model_label, model_id, permission_mode, agent_mode, prompt, state, attention, started_at, last_activity_at, launched_by_session_id, launch_depth, launch_kind) VALUES (?, ?, 'claude', 'S', 'm', 'auto-approve', 'auto', 'p', 'complete', 'none', 't', 't', 'parent', 1, 'agent')",
                rusqlite::params![id, format!("w-{id}")],
            )
            .expect("session");
        for (event, kind, text) in [
            (
                format!("u-{id}"),
                "user.message",
                "launch prompt".to_string(),
            ),
            (
                format!("a-{id}"),
                "message.completed",
                format!("result of {id}"),
            ),
        ] {
            connection
                .execute(
                    "INSERT INTO events (id, session_id, type, message, payload_json, created_at) VALUES (?, ?, ?, ?, '{}', 't')",
                    rusqlite::params![event, id, kind, text],
                )
                .expect("event");
        }
    }

    fn finish(h: &Harness, children: &[&str]) {
        for (index, child) in children.iter().enumerate() {
            h.policy
                .turn_ended(
                    child,
                    SessionState::Complete,
                    &format!("2026-10-04T10:00:00.{:03}Z", index + 1),
                )
                .expect("turn ended");
        }
    }

    #[tokio::test]
    async fn a_restart_inside_the_window_still_wakes_the_launcher_for_what_is_unread() {
        let h = harness();
        // A completion row from before wake marks existed: never woken for.
        h.database
            .connection()
            .execute(
                "INSERT INTO session_messages (id, from_session_id, to_session_id, body, kind, created_at) VALUES ('completion:old:t', 'c1', 'parent', 'old result', 'completion', 't')",
                [],
            )
            .unwrap();
        let (long_window, nothing) = policy_over(&h.database, Duration::from_secs(60), false);
        for (child, at) in [
            ("c1", "2026-10-04T10:00:00.100Z"),
            ("c2", "2026-10-04T10:00:00.200Z"),
            ("c3", "2026-10-04T10:00:00.300Z"),
        ] {
            long_window
                .turn_ended(child, SessionState::Complete, at)
                .unwrap();
        }
        assert!(nothing.lock().unwrap().is_empty());
        // The launcher collected the first one before the app went down.
        {
            let mut connection = h.database.connection();
            connection
                .execute(
                    "UPDATE session_messages SET delivered_at = 't' WHERE id = 'completion:old:t'",
                    [],
                )
                .unwrap();
            let taken = take_undelivered_messages(&mut connection, "parent", 1, 100_000).unwrap();
            assert_eq!(taken[0].id, "completion:c1:2026-10-04T10:00:00.100Z");
        }
        // The app restarts: the window and its task are gone.
        drop(long_window);
        let (after_restart, delivered) = policy_over(&h.database, WINDOW, false);

        assert_eq!(after_restart.recover_pending_wakes().unwrap(), 2);
        assert!(
            delivered.lock().unwrap().is_empty(),
            "siblings still coalesce"
        );
        after_window().await;

        let delivered = delivered.lock().unwrap();
        assert_eq!(delivered.len(), 1, "one wake for the two unread results");
        assert!(delivered[0]
            .message_id
            .starts_with("completion-batch:parent:"));
        assert!(delivered[0].body.contains("result of c2"));
        assert!(delivered[0].body.contains("result of c3"));
        assert!(
            !delivered[0].body.contains("result of c1"),
            "collected work is not replayed"
        );
        assert!(!delivered[0].body.contains("old result"));
        // Attempted once: the next boot has nothing to wake.
        assert!(list_due_wakes(&h.database.connection()).unwrap().is_empty());
        assert_eq!(after_restart.recover_pending_wakes().unwrap(), 0);
    }

    #[tokio::test]
    async fn a_restart_leaves_rows_the_follow_up_journal_already_holds() {
        let h = harness();
        let (long_window, _) = policy_over(&h.database, Duration::from_secs(60), false);
        for (child, at) in [
            ("c1", "2026-10-04T10:00:00.100Z"),
            ("c2", "2026-10-04T10:00:00.200Z"),
        ] {
            long_window
                .turn_ended(child, SessionState::Complete, at)
                .unwrap();
        }
        // The composer queue holds c1's notice as a paused row.
        h.database
            .connection()
            .execute(
                "INSERT INTO pending_messages (id, session_id, position, content, agent_mode, origin_json, queued_at, delivery_state, updated_at) VALUES ('q1', 'parent', 0, 'x', 'auto', '{\"sessionId\":\"c1\",\"label\":\"t\",\"kind\":\"completion\",\"messageId\":\"completion:c1:2026-10-04T10:00:00.100Z\"}', 't', 'recovered', 't')",
                [],
            )
            .unwrap();
        drop(long_window);
        let (after_restart, delivered) = policy_over(&h.database, WINDOW, false);
        assert_eq!(after_restart.recover_pending_wakes().unwrap(), 1);
        after_window().await;
        let delivered = delivered.lock().unwrap();
        assert_eq!(delivered.len(), 1);
        assert_eq!(
            delivered[0].message_id,
            "completion:c2:2026-10-04T10:00:00.200Z"
        );
    }

    /// The row and its wake mark are one write. If the mark cannot be written,
    /// no unmarked row is left behind for boot to miss, and the same turn end
    /// can be recorded again once the fault clears.
    #[tokio::test]
    async fn a_completion_row_and_its_wake_mark_are_written_together_or_not_at_all() {
        let h = harness();
        h.database
            .connection()
            .execute_batch(
                "CREATE TRIGGER refuse_wake_mark BEFORE UPDATE OF wake_due_at ON session_messages
                 WHEN NEW.wake_due_at IS NOT NULL
                 BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
            )
            .unwrap();
        let at = "2026-10-04T10:00:00.100Z";
        // The notice is not recorded (the failure is logged) and nothing wakes.
        h.policy
            .turn_ended("c1", SessionState::Complete, at)
            .unwrap();
        let rows: i64 = h
            .database
            .connection()
            .query_row("SELECT COUNT(*) FROM session_messages", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(rows, 0, "a row without its wake mark must not survive");
        assert!(h.announced.lock().unwrap().is_empty());

        // The fault clears; the same turn end records both, as one.
        h.database
            .connection()
            .execute_batch("DROP TRIGGER refuse_wake_mark")
            .unwrap();
        h.policy
            .turn_ended("c1", SessionState::Complete, at)
            .unwrap();
        let due = list_due_wakes(&h.database.connection()).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].id, format!("completion:c1:{at}"));

        // A restart before the window closed still wakes the launcher.
        drop(h.policy);
        let (after_restart, delivered) = policy_over(&h.database, WINDOW, false);
        assert_eq!(after_restart.recover_pending_wakes().unwrap(), 1);
        after_window().await;
        let delivered = delivered.lock().unwrap();
        assert_eq!(delivered.len(), 1);
        assert_eq!(delivered[0].message_id, format!("completion:c1:{at}"));
    }

    #[tokio::test]
    async fn a_restart_does_not_wake_a_launcher_whose_workspace_is_archived() {
        let h = harness();
        let (long_window, _) = policy_over(&h.database, Duration::from_secs(60), false);
        long_window
            .turn_ended("c1", SessionState::Complete, "2026-10-04T10:00:00.100Z")
            .unwrap();
        drop(long_window);
        h.database
            .connection()
            .execute(
                "UPDATE workspaces SET state = 'archived' WHERE id = 'w1'",
                [],
            )
            .unwrap();
        let (after_restart, delivered) = policy_over(&h.database, WINDOW, false);
        assert_eq!(after_restart.recover_pending_wakes().unwrap(), 0);
        after_window().await;
        assert!(delivered.lock().unwrap().is_empty());
        assert!(list_due_wakes(&h.database.connection()).unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_batch_whose_wake_never_finished_is_delivered_as_the_same_batch_after_restart() {
        let h = harness();
        let (crashing, _) = policy_over(&h.database, WINDOW, true);
        for (child, at) in [
            ("c1", "2026-10-04T10:00:00.100Z"),
            ("c2", "2026-10-04T10:00:00.200Z"),
        ] {
            crashing
                .turn_ended(child, SessionState::Complete, at)
                .unwrap();
        }
        after_window().await;
        // The batch row exists and its wake never finished.
        assert_eq!(list_due_wakes(&h.database.connection()).unwrap().len(), 1);
        drop(crashing);

        let (after_restart, delivered) = policy_over(&h.database, WINDOW, false);
        assert_eq!(after_restart.recover_pending_wakes().unwrap(), 1);
        tokio::time::sleep(Duration::from_millis(50)).await;
        let delivered = delivered.lock().unwrap();
        assert_eq!(delivered.len(), 1);
        assert!(delivered[0]
            .message_id
            .starts_with("completion-batch:parent:"));
        assert_eq!(
            delivered[0].origin.session_id, "c1",
            "origin names a real child"
        );
        assert!(
            delivered[0].body.contains("result of c1")
                && delivered[0].body.contains("result of c2")
        );
    }

    #[tokio::test]
    async fn a_flushed_wake_is_marked_attempted_and_the_individual_results_stay_readable() {
        let h = harness();
        finish(&h, &["c1", "c2"]);
        assert_eq!(list_due_wakes(&h.database.connection()).unwrap().len(), 2);
        after_window().await;
        assert!(list_due_wakes(&h.database.connection()).unwrap().is_empty());

        // The individual rows keep their body and timestamp, whoever collects.
        let connection = h.database.connection();
        let rows: Vec<(String, String, Option<String>)> = connection
            .prepare("SELECT id, body, delivered_at FROM session_messages WHERE id LIKE 'completion:%' ORDER BY id")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(rows.len(), 2);
        for (id, body, delivered_at) in rows {
            assert!(
                body.contains("finished with state complete at "),
                "{id}: {body}"
            );
            assert!(
                delivered_at.is_some(),
                "closed because the batch carries it"
            );
        }
    }

    #[tokio::test]
    async fn a_pile_larger_than_one_row_becomes_several_batches() {
        let h = harness();
        let extra: Vec<String> = (0..24).map(|index| format!("k{index}")).collect();
        for child in &extra {
            seed_child(&h.database, child, "task");
        }
        let children: Vec<&str> = extra.iter().map(String::as_str).collect();
        finish(&h, &children);
        after_window().await;
        let delivered = h.delivered.lock().unwrap();
        assert_eq!(delivered.len(), 2, "20 and 4");
        assert!(delivered[0].body.starts_with("20 sessions"));
        assert!(delivered[1].body.starts_with("4 sessions"));
        for notice in delivered.iter() {
            assert!(notice.body.chars().count() <= MAX_MESSAGE_BODY_CHARS);
        }
    }

    #[test]
    fn twenty_children_with_the_longest_labels_still_fit_one_row_with_every_session_named() {
        let label = "L".repeat(500);
        let notices: Vec<CompletionNotice> = (0..MAX_BATCH_MEMBERS)
            .map(|index| {
                let child = format!("{index:02}-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
                // A real body names its session in its first line.
                let mut notice = notice_with_body(
                    &child,
                    format!("Session {child} (task) finished.\n{}", "y".repeat(6_200)),
                );
                notice.origin.label = label.clone();
                notice
            })
            .collect();
        let batch = batch_notice(&notices);
        assert!(
            batch.body.chars().count() <= MAX_MESSAGE_BODY_CHARS,
            "{}",
            batch.body.chars().count()
        );
        assert!(
            !batch.body.ends_with("(truncated)"),
            "the row must not be cut by the inbox cap"
        );
        for notice in &notices {
            assert!(
                batch.body.contains(&notice.origin.session_id),
                "{} is missing",
                notice.origin.session_id
            );
        }
        let pointers: Vec<&str> = batch
            .body
            .lines()
            .filter(|line| line.contains("did not fit"))
            .collect();
        assert!(!pointers.is_empty());
        for pointer in pointers {
            assert!(
                pointer.chars().count() <= BATCH_POINTER_RESERVE,
                "{} chars: {pointer}",
                pointer.chars().count()
            );
        }
        assert!(batch.body.contains("Read it with session_read on session"));
    }
}
