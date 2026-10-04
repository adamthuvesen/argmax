// Native provider continuity: per-session provider bindings (so A -> B -> A
// resumes A's own conversation), fork lineage, and the fork merge ledger.
// docs/providers.md#native-continuity-and-forks has the rules these rows
// serve. Cursors are event ids, not rowids, so a VACUUM that renumbers rowids
// cannot move a boundary; the rowid is looked up when it is compared.

use rusqlite::{params, Connection, OptionalExtension, Row};
use sha2::{Digest, Sha256};

use super::{sqlite_error, time::now_iso};
use crate::error::{ArgmaxError, ArgmaxResult};

/// Registered by migration v65.
///
/// `provider_bindings`: one native conversation a session holds with one
/// provider. `sessions.provider_conversation_id` stays the pointer to the
/// `active` row; a provider switch parks it with the newest event id the
/// provider had seen (`delivered_through_event_id`), and a return resumes it.
/// `pending_since_event_id` is set when a parked binding is rejoined and
/// cleared only once the provider shows output: until then every native resume
/// of it still owes the provider the messages after that event, so a launch
/// that failed before admission cannot lose them.
/// `provider_binding_turns` maps a visible user message to the provider's own
/// id for the turn it started, which is what an exact native fork needs.
///
/// `session_forks`: the lineage record. `boundary_event_id` is the user message
/// that started the selected turn; `source_last_event_id` is the last source
/// event the child copied. The source is `SET NULL` when it is deleted: the
/// child keeps its history, but a missing source is never an exact native fork. `native_mode` says how the child's first turn may
/// continue the provider conversation, and `native_*` hold the material.
///
/// `fork_merges`: the idempotent ledger for bringing a fork's findings back.
/// `marker_id` is the id printed in the merge message's footer. It is what finds
/// the message in the source, so a claim copied onto a moved fork keeps it.
/// `UNIQUE (fork_id, through_event_id)` is what stops a repeated click from
/// delivering twice.
pub const MIGRATION_SQL: &str = r#"
CREATE TABLE provider_bindings (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  working_dir TEXT NOT NULL,
  config_identity TEXT NOT NULL,
  delivered_through_event_id TEXT,
  pending_since_event_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('active', 'parked', 'invalid')),
  invalid_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (session_id, provider, conversation_id)
);
CREATE INDEX idx_provider_bindings_session
  ON provider_bindings(session_id, provider, state);

-- Chats that already hold a native id get it as their live binding, so a
-- switch away from them can be switched back. Their launch config is unknown:
-- the empty identity matches any.
INSERT INTO provider_bindings
  (id, session_id, provider, conversation_id, working_dir, config_identity, state,
   created_at, updated_at)
SELECT lower(hex(randomblob(16))), s.id, s.provider, s.provider_conversation_id, w.path, '',
       'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM sessions s JOIN workspaces w ON w.id = s.workspace_id
WHERE s.provider_conversation_id IS NOT NULL AND s.provider_conversation_id <> ''
  -- A child still waiting to fork its source holds the source's id, not its own.
  AND s.resume_fork = 0;

CREATE TABLE provider_binding_turns (
  binding_id TEXT NOT NULL REFERENCES provider_bindings(id) ON DELETE CASCADE,
  user_event_id TEXT NOT NULL,
  provider_turn_id TEXT NOT NULL,
  PRIMARY KEY (binding_id, user_event_id)
);

CREATE TABLE session_forks (
  id TEXT PRIMARY KEY,
  source_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  child_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  boundary_event_id TEXT,
  source_last_event_id TEXT,
  child_base_event_id TEXT,
  workspace_mode TEXT NOT NULL CHECK (workspace_mode IN ('shared', 'isolated')),
  native_mode TEXT NOT NULL CHECK (native_mode IN ('none', 'resume-fork', 'codex-last-turn')),
  native_provider TEXT,
  native_conversation_id TEXT,
  native_turn_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_session_forks_source ON session_forks(source_session_id);

CREATE TABLE fork_merges (
  id TEXT PRIMARY KEY,
  marker_id TEXT NOT NULL,
  fork_id TEXT NOT NULL REFERENCES session_forks(id) ON DELETE CASCADE,
  from_event_id TEXT,
  through_event_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('sending', 'sent')),
  created_at TEXT NOT NULL,
  UNIQUE (fork_id, through_event_id)
);
"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BindingState {
    Active,
    Parked,
    Invalid,
}

impl BindingState {
    fn parse(value: &str) -> Self {
        match value {
            "active" => BindingState::Active,
            "parked" => BindingState::Parked,
            _ => BindingState::Invalid,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderBinding {
    pub id: String,
    pub session_id: String,
    pub provider: String,
    pub conversation_id: String,
    pub working_dir: String,
    pub config_identity: String,
    /// Newest event the provider had seen when the session left it. `None`
    /// until the first switch away.
    pub delivered_through_event_id: Option<String>,
    /// Messages after this event are still owed to the provider.
    pub pending_since_event_id: Option<String>,
    pub state: BindingState,
    pub invalid_reason: Option<String>,
}

const BINDING_COLUMNS: &str = "id, session_id, provider, conversation_id, working_dir, \
     config_identity, delivered_through_event_id, pending_since_event_id, state, invalid_reason";

fn binding_from_row(row: &Row<'_>) -> rusqlite::Result<ProviderBinding> {
    Ok(ProviderBinding {
        id: row.get(0)?,
        session_id: row.get(1)?,
        provider: row.get(2)?,
        conversation_id: row.get(3)?,
        working_dir: row.get(4)?,
        config_identity: row.get(5)?,
        delivered_through_event_id: row.get(6)?,
        pending_since_event_id: row.get(7)?,
        state: BindingState::parse(&row.get::<_, String>(8)?),
        invalid_reason: row.get(9)?,
    })
}

/// A fingerprint of the provider configuration a conversation was created
/// under. A native id is only meaningful to the account and config home that
/// issued it, so a different `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or gateway
/// means the id must not be resumed. Only a hash is stored: a base URL may
/// carry credentials.
pub fn config_identity(provider: &str) -> String {
    let keys: &[&str] = match provider {
        "claude" => &["CLAUDE_CONFIG_DIR", "ANTHROPIC_BASE_URL", "HOME"],
        "codex" => &["CODEX_HOME", "OPENAI_BASE_URL", "HOME"],
        "opencode" => &["OPENCODE_CONFIG", "XDG_DATA_HOME", "HOME"],
        "grok" => &["GROK_HOME", "HOME"],
        _ => &["HOME"],
    };
    let environment = crate::providers::environment::build_provider_environment([]);
    let mut hasher = Sha256::new();
    hasher.update(provider.as_bytes());
    for key in keys {
        let value = environment
            .iter()
            .find_map(|(name, value)| (name == key).then_some(value.as_str()))
            .unwrap_or("");
        hasher.update([0]);
        hasher.update(key.as_bytes());
        hasher.update([b'=']);
        hasher.update(value.as_bytes());
    }
    hasher
        .finalize()
        .iter()
        .take(12)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The newest event id of a session, or `None` for an empty timeline.
pub fn newest_event_id(connection: &Connection, session_id: &str) -> ArgmaxResult<Option<String>> {
    connection
        .prepare_cached("SELECT id FROM events WHERE session_id = ? ORDER BY rowid DESC LIMIT 1")
        .map_err(sqlite_error)?
        .query_row([session_id], |row| row.get(0))
        .optional()
        .map_err(sqlite_error)
}

/// The rowid an event id currently has, used only to compare two positions in
/// one session's timeline. `None` when the event no longer exists.
pub fn event_rowid(connection: &Connection, event_id: &str) -> ArgmaxResult<Option<i64>> {
    connection
        .prepare_cached("SELECT rowid FROM events WHERE id = ?")
        .map_err(sqlite_error)?
        .query_row([event_id], |row| row.get(0))
        .optional()
        .map_err(sqlite_error)
}

/// Record that `conversation_id` is the session's live conversation with its
/// current provider. Any other conversation the session held with the same
/// provider is superseded (a fork or a rotated id replaced it), so only a
/// conversation left by a provider *switch* survives to be resumed.
pub fn bind_active(
    connection: &Connection,
    session_id: &str,
    conversation_id: &str,
) -> ArgmaxResult<()> {
    let (provider, working_dir): (String, String) = connection
        .prepare_cached(
            "SELECT s.provider, w.path FROM sessions s \
             JOIN workspaces w ON w.id = s.workspace_id WHERE s.id = ?",
        )
        .map_err(sqlite_error)?
        .query_row([session_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(sqlite_error)?;
    let identity = config_identity(&provider);
    let timestamp = now_iso();
    connection
        .execute(
            "DELETE FROM provider_bindings \
             WHERE session_id = ?1 AND provider = ?2 AND conversation_id <> ?3",
            params![session_id, provider, conversation_id],
        )
        .map_err(sqlite_error)?;
    connection
        .execute(
            "INSERT INTO provider_bindings \
               (id, session_id, provider, conversation_id, working_dir, config_identity, \
                state, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?7) \
             ON CONFLICT (session_id, provider, conversation_id) DO UPDATE SET \
               working_dir = excluded.working_dir, config_identity = excluded.config_identity, \
               state = 'active', invalid_reason = NULL, updated_at = excluded.updated_at",
            params![
                uuid::Uuid::new_v4().to_string(),
                session_id,
                provider,
                conversation_id,
                working_dir,
                identity,
                timestamp,
            ],
        )
        .map_err(sqlite_error)?;
    Ok(())
}

/// The newest event the live provider conversation has seen. A last prompt the
/// provider never answered (a launch that failed before any output) was not
/// admitted, so the boundary stops short of it and the prompt is retold as
/// missed context instead of being lost.
fn delivered_boundary(connection: &Connection, session_id: &str) -> ArgmaxResult<Option<String>> {
    let unanswered_prompt: Option<(String, Option<String>)> = connection
        .prepare_cached(
            "SELECT u.id, (SELECT p.id FROM events p WHERE p.session_id = u.session_id \
                            AND p.rowid < u.rowid ORDER BY p.rowid DESC LIMIT 1) \
             FROM events u WHERE u.session_id = ?1 AND u.type = 'user.message' \
             ORDER BY u.rowid DESC LIMIT 1",
        )
        .map_err(sqlite_error)?
        .query_row([session_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()
        .map_err(sqlite_error)?;
    if let Some((user_event_id, before)) = unanswered_prompt {
        let answered: bool = connection
            .prepare_cached(
                "SELECT EXISTS (SELECT 1 FROM events a WHERE a.session_id = ?1 \
                   AND a.rowid > (SELECT rowid FROM events WHERE id = ?2) \
                   AND a.type NOT IN ('user.message', 'error') AND a.type NOT LIKE 'session.%')",
            )
            .map_err(sqlite_error)?
            .query_row([session_id, user_event_id.as_str()], |row| row.get(0))
            .map_err(sqlite_error)?;
        if !answered {
            return Ok(before);
        }
    }
    newest_event_id(connection, session_id)
}

/// The session is leaving its provider: park the live binding with the newest
/// event the provider has seen, so a return knows what it missed. A rejoin the
/// provider never answered still owes its older boundary, and that stays the
/// boundary: leaving again must not mark B's earlier turns as delivered.
pub fn park_active(connection: &Connection, session_id: &str) -> ArgmaxResult<()> {
    let boundary = delivered_boundary(connection, session_id)?;
    connection
        .execute(
            "UPDATE provider_bindings \
             SET state = 'parked', \
                 delivered_through_event_id = COALESCE(pending_since_event_id, ?2), \
                 pending_since_event_id = NULL, updated_at = ?3 \
             WHERE session_id = ?1 AND state = 'active'",
            params![session_id, boundary, now_iso()],
        )
        .map_err(sqlite_error)?;
    Ok(())
}

/// The newest parked binding the session holds with `provider`.
pub fn find_parked(
    connection: &Connection,
    session_id: &str,
    provider: &str,
) -> ArgmaxResult<Option<ProviderBinding>> {
    connection
        .prepare_cached(&format!(
            "SELECT {BINDING_COLUMNS} FROM provider_bindings \
             WHERE session_id = ? AND provider = ? AND state = 'parked' \
             ORDER BY updated_at DESC LIMIT 1"
        ))
        .map_err(sqlite_error)?
        .query_row([session_id, provider], binding_from_row)
        .optional()
        .map_err(sqlite_error)
}

/// A rejoined binding owes the provider everything after `event_id` until the
/// provider shows output.
pub fn set_pending_since(
    connection: &Connection,
    session_id: &str,
    provider: &str,
    conversation_id: &str,
    event_id: &str,
) -> ArgmaxResult<()> {
    connection
        .execute(
            "UPDATE provider_bindings SET pending_since_event_id = ?4, updated_at = ?5 \
             WHERE session_id = ?1 AND provider = ?2 AND conversation_id = ?3",
            params![session_id, provider, conversation_id, event_id, now_iso()],
        )
        .map_err(sqlite_error)?;
    Ok(())
}

/// The provider showed output, so it holds everything it was owed. Returns
/// whether a debt was cleared.
pub fn clear_pending_since(connection: &Connection, session_id: &str) -> ArgmaxResult<bool> {
    let changes = connection
        .execute(
            "UPDATE provider_bindings SET pending_since_event_id = NULL \
             WHERE session_id = ? AND state = 'active' AND pending_since_event_id IS NOT NULL",
            [session_id],
        )
        .map_err(sqlite_error)?;
    Ok(changes > 0)
}

pub fn find_binding(
    connection: &Connection,
    session_id: &str,
    provider: &str,
    conversation_id: &str,
) -> ArgmaxResult<Option<ProviderBinding>> {
    connection
        .prepare_cached(&format!(
            "SELECT {BINDING_COLUMNS} FROM provider_bindings \
             WHERE session_id = ? AND provider = ? AND conversation_id = ?"
        ))
        .map_err(sqlite_error)?
        .query_row([session_id, provider, conversation_id], binding_from_row)
        .optional()
        .map_err(sqlite_error)
}

pub fn list_bindings(
    connection: &Connection,
    session_id: &str,
) -> ArgmaxResult<Vec<ProviderBinding>> {
    connection
        .prepare_cached(&format!(
            "SELECT {BINDING_COLUMNS} FROM provider_bindings \
             WHERE session_id = ? ORDER BY created_at, rowid"
        ))
        .map_err(sqlite_error)?
        .query_map([session_id], binding_from_row)
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)
}

/// Mark every binding the session still trusts as unusable: `/clear`, or any
/// event after which an old native id no longer describes the chat.
pub fn invalidate_session_bindings(
    connection: &Connection,
    session_id: &str,
    reason: &str,
) -> ArgmaxResult<()> {
    connection
        .execute(
            "UPDATE provider_bindings SET state = 'invalid', invalid_reason = ?2, updated_at = ?3 \
             WHERE session_id = ?1 AND state <> 'invalid'",
            params![session_id, reason, now_iso()],
        )
        .map_err(sqlite_error)?;
    Ok(())
}

/// Forget the live pointer without condemning the session's other bindings.
pub fn forget_active_pointer(connection: &Connection, session_id: &str) -> ArgmaxResult<()> {
    connection
        .execute(
            "UPDATE sessions SET provider_conversation_id = NULL, resume_fork = 0 WHERE id = ?",
            [session_id],
        )
        .map_err(sqlite_error)?;
    Ok(())
}

pub fn has_any_binding(
    connection: &Connection,
    session_id: &str,
    provider: &str,
) -> ArgmaxResult<bool> {
    connection
        .prepare_cached(
            "SELECT EXISTS (SELECT 1 FROM provider_bindings WHERE session_id = ? AND provider = ?)",
        )
        .map_err(sqlite_error)?
        .query_row([session_id, provider], |row| row.get(0))
        .map_err(sqlite_error)
}

pub fn invalidate_binding(
    connection: &Connection,
    session_id: &str,
    provider: &str,
    conversation_id: &str,
    reason: &str,
) -> ArgmaxResult<()> {
    connection
        .execute(
            "UPDATE provider_bindings SET state = 'invalid', invalid_reason = ?4, updated_at = ?5 \
             WHERE session_id = ?1 AND provider = ?2 AND conversation_id = ?3",
            params![session_id, provider, conversation_id, reason, now_iso()],
        )
        .map_err(sqlite_error)?;
    Ok(())
}

/// Remember the provider's own id for the turn a visible user message started.
pub fn record_binding_turn(
    connection: &Connection,
    session_id: &str,
    provider: &str,
    conversation_id: &str,
    user_event_id: &str,
    provider_turn_id: &str,
) -> ArgmaxResult<()> {
    let Some(binding) = find_binding(connection, session_id, provider, conversation_id)? else {
        return Ok(());
    };
    connection
        .execute(
            "INSERT INTO provider_binding_turns (binding_id, user_event_id, provider_turn_id) \
             VALUES (?1, ?2, ?3) \
             ON CONFLICT (binding_id, user_event_id) DO UPDATE SET provider_turn_id = excluded.provider_turn_id",
            params![binding.id, user_event_id, provider_turn_id],
        )
        .map_err(sqlite_error)?;
    Ok(())
}

pub fn binding_turn(
    connection: &Connection,
    session_id: &str,
    provider: &str,
    conversation_id: &str,
    user_event_id: &str,
) -> ArgmaxResult<Option<String>> {
    let Some(binding) = find_binding(connection, session_id, provider, conversation_id)? else {
        return Ok(None);
    };
    connection
        .prepare_cached(
            "SELECT provider_turn_id FROM provider_binding_turns \
             WHERE binding_id = ? AND user_event_id = ?",
        )
        .map_err(sqlite_error)?
        .query_row([binding.id.as_str(), user_event_id], |row| row.get(0))
        .optional()
        .map_err(sqlite_error)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeMode {
    /// The child's first turn starts a fresh conversation from the visible
    /// prefix.
    None,
    /// The child resumes the source conversation with the provider's fork flag.
    /// Exact only while the source has taken no turn past the boundary.
    ResumeFork,
    /// Codex `thread/fork` with `lastTurnId`: exact at any finished turn.
    CodexLastTurn,
}

impl NativeMode {
    pub fn as_str(self) -> &'static str {
        match self {
            NativeMode::None => "none",
            NativeMode::ResumeFork => "resume-fork",
            NativeMode::CodexLastTurn => "codex-last-turn",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "resume-fork" => NativeMode::ResumeFork,
            "codex-last-turn" => NativeMode::CodexLastTurn,
            _ => NativeMode::None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForkRecord {
    pub id: String,
    /// `None` once the source chat was deleted.
    pub source_session_id: Option<String>,
    pub child_session_id: String,
    /// The user message that started the selected turn. `None` for a fork of
    /// the whole session.
    pub boundary_event_id: Option<String>,
    pub source_last_event_id: Option<String>,
    pub child_base_event_id: Option<String>,
    /// `shared` or `isolated`.
    pub workspace_mode: String,
    pub native_mode: NativeMode,
    pub native_provider: Option<String>,
    pub native_conversation_id: Option<String>,
    pub native_turn_id: Option<String>,
    pub created_at: String,
}

const FORK_COLUMNS: &str = "id, source_session_id, child_session_id, boundary_event_id, \
     source_last_event_id, child_base_event_id, workspace_mode, native_mode, native_provider, \
     native_conversation_id, native_turn_id, created_at";

fn fork_from_row(row: &Row<'_>) -> rusqlite::Result<ForkRecord> {
    Ok(ForkRecord {
        id: row.get(0)?,
        source_session_id: row.get(1)?,
        child_session_id: row.get(2)?,
        boundary_event_id: row.get(3)?,
        source_last_event_id: row.get(4)?,
        child_base_event_id: row.get(5)?,
        workspace_mode: row.get(6)?,
        native_mode: NativeMode::parse(&row.get::<_, String>(7)?),
        native_provider: row.get(8)?,
        native_conversation_id: row.get(9)?,
        native_turn_id: row.get(10)?,
        created_at: row.get(11)?,
    })
}

pub fn insert_fork(connection: &Connection, fork: &ForkRecord) -> ArgmaxResult<()> {
    connection
        .execute(
            "INSERT INTO session_forks \
               (id, source_session_id, child_session_id, boundary_event_id, source_last_event_id, \
                child_base_event_id, workspace_mode, native_mode, native_provider, \
                native_conversation_id, native_turn_id, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                fork.id,
                fork.source_session_id,
                fork.child_session_id,
                fork.boundary_event_id,
                fork.source_last_event_id,
                fork.child_base_event_id,
                fork.workspace_mode,
                fork.native_mode.as_str(),
                fork.native_provider,
                fork.native_conversation_id,
                fork.native_turn_id,
                fork.created_at,
            ],
        )
        .map_err(sqlite_error)?;
    Ok(())
}

pub fn fork_for_child(
    connection: &Connection,
    child_session_id: &str,
) -> ArgmaxResult<Option<ForkRecord>> {
    connection
        .prepare_cached(&format!(
            "SELECT {FORK_COLUMNS} FROM session_forks WHERE child_session_id = ?"
        ))
        .map_err(sqlite_error)?
        .query_row([child_session_id], fork_from_row)
        .optional()
        .map_err(sqlite_error)
}

pub fn forks_of_source(
    connection: &Connection,
    source_session_id: &str,
) -> ArgmaxResult<Vec<ForkRecord>> {
    connection
        .prepare_cached(&format!(
            "SELECT {FORK_COLUMNS} FROM session_forks WHERE source_session_id = ? \
             ORDER BY created_at, rowid"
        ))
        .map_err(sqlite_error)?
        .query_map([source_session_id], fork_from_row)
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)
}

/// Spend the fork's native plan: the child's first turn has launched (or the
/// plan stopped being exact), so nothing later may fork the source again.
pub fn clear_fork_native_plan(connection: &Connection, child_session_id: &str) -> ArgmaxResult<()> {
    connection
        .execute(
            "UPDATE session_forks SET native_mode = 'none', native_provider = NULL, \
               native_conversation_id = NULL, native_turn_id = NULL \
             WHERE child_session_id = ?",
            [child_session_id],
        )
        .map_err(sqlite_error)?;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeOutcome {
    /// Reserved; the message may or may not have reached the source. Counts
    /// as merged so an uncertain delivery is never repeated on its own.
    Sending,
    Sent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForkMerge {
    pub id: String,
    /// The id in the message footer; see the table comment.
    pub marker_id: String,
    pub fork_id: String,
    pub from_event_id: Option<String>,
    pub through_event_id: String,
    pub outcome: MergeOutcome,
    pub created_at: String,
}

fn merge_from_row(row: &Row<'_>) -> rusqlite::Result<ForkMerge> {
    Ok(ForkMerge {
        id: row.get(0)?,
        fork_id: row.get(1)?,
        from_event_id: row.get(2)?,
        through_event_id: row.get(3)?,
        outcome: if row.get::<_, String>(4)? == "sent" {
            MergeOutcome::Sent
        } else {
            MergeOutcome::Sending
        },
        created_at: row.get(5)?,
        marker_id: row.get(6)?,
    })
}

const MERGE_COLUMNS: &str =
    "id, fork_id, from_event_id, through_event_id, outcome, created_at, marker_id";

/// The newest merge of a fork, by the position of the child event it reached.
pub fn latest_merge(connection: &Connection, fork_id: &str) -> ArgmaxResult<Option<ForkMerge>> {
    connection
        .prepare_cached(&format!(
            "SELECT {MERGE_COLUMNS} FROM fork_merges m WHERE fork_id = ? \
             ORDER BY (SELECT rowid FROM events WHERE id = m.through_event_id) DESC LIMIT 1"
        ))
        .map_err(sqlite_error)?
        .query_row([fork_id], merge_from_row)
        .optional()
        .map_err(sqlite_error)
}

/// The chat a merge was sent to and the marker its message carries.
pub fn merge_delivery_target(
    connection: &Connection,
    merge_id: &str,
) -> ArgmaxResult<Option<(String, String)>> {
    Ok(connection
        .prepare_cached(
            "SELECT f.source_session_id, m.marker_id FROM fork_merges m \
             JOIN session_forks f ON f.id = m.fork_id WHERE m.id = ?",
        )
        .map_err(sqlite_error)?
        .query_row([merge_id], |row| {
            Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?))
        })
        .optional()
        .map_err(sqlite_error)?
        .and_then(|(source, marker)| source.map(|source| (source, marker))))
}

/// Every claim on a fork, whatever its outcome.
pub fn list_merges(connection: &Connection, fork_id: &str) -> ArgmaxResult<Vec<ForkMerge>> {
    connection
        .prepare_cached(&format!(
            "SELECT {MERGE_COLUMNS} FROM fork_merges WHERE fork_id = ? ORDER BY created_at, rowid"
        ))
        .map_err(sqlite_error)?
        .query_map([fork_id], merge_from_row)
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)
}

pub fn merge_through(
    connection: &Connection,
    fork_id: &str,
    through_event_id: &str,
) -> ArgmaxResult<Option<ForkMerge>> {
    connection
        .prepare_cached(&format!(
            "SELECT {MERGE_COLUMNS} FROM fork_merges WHERE fork_id = ? AND through_event_id = ?"
        ))
        .map_err(sqlite_error)?
        .query_row([fork_id, through_event_id], merge_from_row)
        .optional()
        .map_err(sqlite_error)
}

/// Reserve a merge range. The unique key makes a concurrent or repeated
/// reservation of the same range fail, which the caller reads as "already
/// merged".
pub fn reserve_merge(
    connection: &Connection,
    fork_id: &str,
    from_event_id: Option<&str>,
    through_event_id: &str,
) -> ArgmaxResult<Option<ForkMerge>> {
    let id = uuid::Uuid::new_v4().to_string();
    let inserted = connection
        .execute(
            "INSERT OR IGNORE INTO fork_merges \
               (id, marker_id, fork_id, from_event_id, through_event_id, outcome, created_at) \
             VALUES (?1, ?1, ?2, ?3, ?4, 'sending', ?5)",
            params![id, fork_id, from_event_id, through_event_id, now_iso()],
        )
        .map_err(sqlite_error)?;
    if inserted == 0 {
        return Ok(None);
    }
    merge_through(connection, fork_id, through_event_id)
}

/// A copy of a claim under another fork, for a fork that moved with its chat.
pub fn insert_merge(connection: &Connection, merge: &ForkMerge) -> ArgmaxResult<()> {
    connection
        .execute(
            "INSERT INTO fork_merges \
               (id, marker_id, fork_id, from_event_id, through_event_id, outcome, created_at) \
             VALUES (?1, ?7, ?2, ?3, ?4, ?5, ?6)",
            params![
                merge.id,
                merge.fork_id,
                merge.from_event_id,
                merge.through_event_id,
                match merge.outcome {
                    MergeOutcome::Sending => "sending",
                    MergeOutcome::Sent => "sent",
                },
                merge.created_at,
                merge.marker_id,
            ],
        )
        .map_err(sqlite_error)?;
    Ok(())
}

pub fn mark_merge_sent(connection: &Connection, merge_id: &str) -> ArgmaxResult<()> {
    connection
        .execute(
            "UPDATE fork_merges SET outcome = 'sent' WHERE id = ?",
            [merge_id],
        )
        .map_err(sqlite_error)?;
    Ok(())
}

/// The send was refused before the source admitted it, so the range is free
/// to merge again.
pub fn release_merge(connection: &Connection, merge_id: &str) -> ArgmaxResult<()> {
    let changes = connection
        .execute(
            "DELETE FROM fork_merges WHERE id = ? AND outcome = 'sending'",
            [merge_id],
        )
        .map_err(sqlite_error)?;
    if changes == 0 {
        return Err(ArgmaxError::service(
            "FORK_MERGE_STATE",
            "The merge was already confirmed delivered.",
        ));
    }
    Ok(())
}
