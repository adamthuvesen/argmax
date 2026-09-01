//! Diffs Argmax measures itself, for providers that report a file write
//! without saying what changed.
//!
//! Codex's `file_change` item carries a path and a kind and nothing else, so
//! the chat had no line stat and no inline diff for a Codex edit. The provider
//! stream cannot supply one: measured against a live run, `item.started` lands
//! 0.4 ms before the write reaches disk, and `item.completed` 1.4 ms after it,
//! so there is no moment at which Argmax could read the "before" content.
//!
//! Instead the worktree is marked as a git tree when the turn starts, and each
//! write re-marks only the paths it reported. `before → after` on those two
//! trees is the write's own diff. The mark advances with every write, so two
//! edits to one file are two diffs, not one counted twice, and work that was
//! already uncommitted when the turn began belongs to nobody.
//!
//! Every failure — no git repo, a lost mark, a path outside the workspace, a
//! diff over the cap — leaves the stat absent. A missing number is honest; a
//! number measured against the wrong baseline is not.

use std::{
    collections::HashMap,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
};

use serde_json::Value;
use tokio::sync::Mutex as AsyncMutex;

use crate::{
    git::tree_snapshot::{diff_path_between_trees, dirty_paths, snapshot_worktree},
    persistence::events::TimelineEvent,
    util::sync::LockOrRecover,
};

/// One path's diff ceiling. A diff this large is a file rewrite, where the
/// stat stops being the thing a reader wants and the payload cost is real.
const MAX_DIFF_BYTES: usize = 128 * 1024;

/// Paths measured for a single write. Codex batches a handful; a report longer
/// than this is a bulk rewrite that isn't worth a git call per entry.
const MAX_PATHS_PER_WRITE: usize = 64;

/// A measured diff, keyed by the path string the provider used so the payload
/// merge can find its entry again.
pub type MeasuredDiff = (String, String);

/// The git mark for a session's current turn.
pub struct TurnMark {
    workspace_path: PathBuf,
    /// The worktree as of the last thing we measured, or `None` while the
    /// opening mark is still being taken and after any failure.
    tree: Option<String>,
}

pub type SharedTurnMark = Arc<AsyncMutex<TurnMark>>;

/// Per-session turn marks. The inner async mutex keeps one session's
/// measurements in write order; the outer lock only guards the map. Each new
/// turn replaces its session's entry, so the map holds one tree id and one path
/// per session seen this app run and needs no eviction of its own.
#[derive(Default)]
pub struct MeasuredDiffs {
    marks: Mutex<HashMap<String, SharedTurnMark>>,
}

impl MeasuredDiffs {
    /// Open a turn: replace any previous mark for the session with a fresh one.
    /// The returned handle is what [`capture_opening_mark`] fills in, and a new
    /// turn starting mid-measurement leaves the old handle orphaned rather than
    /// letting a stale write advance the new turn's mark.
    pub fn open_turn(&self, session_id: &str, workspace_path: PathBuf) -> SharedTurnMark {
        let mark = Arc::new(AsyncMutex::new(TurnMark {
            workspace_path,
            tree: None,
        }));
        self.marks
            .lock_or_recover("measured diff marks")
            .insert(session_id.to_string(), Arc::clone(&mark));
        mark
    }

    /// Whether the session's opening mark has landed. The mark is taken off
    /// the send path, so a caller that needs to observe a measured stat (a
    /// test, today) has to wait for it.
    pub fn is_marked(&self, session_id: &str) -> bool {
        self.marks
            .lock_or_recover("measured diff marks")
            .get(session_id)
            .and_then(|mark| mark.try_lock().ok().map(|mark| mark.tree.is_some()))
            .unwrap_or(false)
    }

    /// Measure what `paths` looked like before this write against what they
    /// look like now, and advance the mark. Returns one entry per path that
    /// actually changed and fits the cap.
    pub async fn measure(&self, session_id: &str, paths: &[String]) -> Vec<MeasuredDiff> {
        let Some(mark) = self
            .marks
            .lock_or_recover("measured diff marks")
            .get(session_id)
            .map(Arc::clone)
        else {
            return Vec::new();
        };
        let mut mark = mark.lock().await;
        let Some(before) = mark.tree.clone() else {
            return Vec::new();
        };
        let workspace_path = mark.workspace_path.clone();
        let targets = measurable_paths(&workspace_path, paths);
        if targets.is_empty() {
            return Vec::new();
        }

        let relative = targets
            .iter()
            .map(|(_, relative)| relative.clone())
            .collect::<Vec<_>>();
        let after = match snapshot_worktree(&workspace_path, Some(&before), &relative).await {
            Ok(tree) => tree,
            Err(error) => {
                tracing::debug!(%error, session_id, "could not re-mark worktree for a file change");
                return Vec::new();
            }
        };

        let mut measured = Vec::new();
        for (reported, relative) in &targets {
            match diff_path_between_trees(
                &workspace_path,
                &before,
                &after,
                relative,
                MAX_DIFF_BYTES,
            )
            .await
            {
                Ok(Some(diff)) if !diff.trim().is_empty() => {
                    measured.push((reported.clone(), diff));
                }
                Ok(_) => {}
                Err(error) => {
                    tracing::debug!(%error, session_id, path = %relative, "could not diff a file change");
                }
            }
        }
        mark.tree = Some(after);
        measured
    }
}

/// Take the opening mark for a turn. Runs off the send path: a large repo
/// spends a few hundred milliseconds here, while the agent's first write is a
/// model round-trip away.
pub async fn capture_opening_mark(mark: SharedTurnMark) {
    let mut mark = mark.lock().await;
    let workspace_path = mark.workspace_path.clone();
    let dirty = match dirty_paths(&workspace_path).await {
        Ok(paths) => paths,
        Err(error) => {
            tracing::debug!(%error, path = %workspace_path.display(), "no git mark for this turn");
            return;
        }
    };
    // Only the already-dirty paths need staging: everything else is identical
    // to HEAD, which the mark is seeded from. On a 1900-file repo that is the
    // difference between 140 ms and 570 ms.
    match snapshot_worktree(&workspace_path, None, &dirty).await {
        Ok(tree) => mark.tree = Some(tree),
        Err(error) => {
            tracing::debug!(%error, path = %workspace_path.display(), "could not mark worktree at turn start");
        }
    }
}

/// Paths a completed file-change tool reported without saying what changed.
///
/// Recognition is by payload shape, not by provider: any tool whose name reads
/// as a file change and whose entries carry a path but no diff, patch, or
/// content. Deletions are skipped — a deleted file's content never reached us,
/// so it carries no line stat by design.
pub fn paths_awaiting_diff(event: &TimelineEvent) -> Vec<String> {
    if event.r#type != "command.completed" {
        return Vec::new();
    }
    if !is_file_change_tool(event.payload.get("name").and_then(Value::as_str)) {
        return Vec::new();
    }
    let mut paths = Vec::new();
    for entry in change_entries(&event.payload) {
        if entry.get("unified_diff").is_some()
            || entry.get("diff").is_some()
            || entry.get("patch").is_some()
            || entry.get("content").is_some()
        {
            continue;
        }
        if is_deletion(entry) {
            continue;
        }
        let Some(path) = entry.get("path").and_then(Value::as_str) else {
            continue;
        };
        if !paths.iter().any(|seen| seen == path) {
            paths.push(path.to_string());
        }
    }
    paths.truncate(MAX_PATHS_PER_WRITE);
    paths
}

/// Write measured diffs onto a file-change payload, in both the `input.changes`
/// the chat reads and the top-level `changes` mirror. Returns whether anything
/// was written.
pub fn merge_measured_diffs(payload: &mut Value, measured: &[MeasuredDiff]) -> bool {
    if measured.is_empty() {
        return false;
    }
    let mut merged = false;
    for key in ["input", "changes"] {
        let target = if key == "input" {
            payload
                .get_mut("input")
                .and_then(|input| input.get_mut("changes"))
        } else {
            payload.get_mut("changes")
        };
        let Some(Value::Array(entries)) = target else {
            continue;
        };
        for entry in entries.iter_mut() {
            let Some(object) = entry.as_object_mut() else {
                continue;
            };
            let Some(path) = object
                .get("path")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
            else {
                continue;
            };
            if object.contains_key("unified_diff") {
                continue;
            }
            let Some((_, diff)) = measured.iter().find(|(reported, _)| *reported == path) else {
                continue;
            };
            object.insert("unified_diff".to_string(), Value::String(diff.clone()));
            merged = true;
        }
    }
    merged
}

fn is_file_change_tool(name: Option<&str>) -> bool {
    let Some(name) = name else { return false };
    let lower = name.to_ascii_lowercase();
    matches!(lower.as_str(), "file_change" | "file-change" | "filechange")
}

fn is_deletion(entry: &Value) -> bool {
    ["kind", "type", "operation"]
        .iter()
        .filter_map(|key| entry.get(*key).and_then(Value::as_str))
        .any(|value| {
            let lower = value.to_ascii_lowercase();
            lower == "delete" || lower == "remove"
        })
}

fn change_entries(payload: &Value) -> Vec<&Value> {
    payload
        .get("input")
        .and_then(|input| input.get("changes"))
        .or_else(|| payload.get("changes"))
        .and_then(Value::as_array)
        .map(|entries| entries.iter().collect())
        .unwrap_or_default()
}

/// Reported paths paired with their repo-relative form, dropping anything the
/// mark cannot speak for: paths outside the workspace, and paths that are not
/// a file on disk right now (a delete has no stat, and a vanished path would
/// make git reject the whole pathspec).
fn measurable_paths(workspace_path: &Path, paths: &[String]) -> Vec<(String, String)> {
    let root =
        std::fs::canonicalize(workspace_path).unwrap_or_else(|_| workspace_path.to_path_buf());
    let mut measurable = Vec::new();
    for reported in paths {
        let Some(relative) = relative_within(&root, workspace_path, reported) else {
            continue;
        };
        if !root.join(&relative).is_file() {
            continue;
        }
        measurable.push((reported.clone(), relative));
    }
    measurable.truncate(MAX_PATHS_PER_WRITE);
    measurable
}

fn relative_within(root: &Path, workspace_path: &Path, reported: &str) -> Option<String> {
    let candidate = Path::new(reported);
    let relative = if candidate.is_absolute() {
        let canonical = std::fs::canonicalize(candidate).ok();
        let stripped = canonical
            .as_deref()
            .and_then(|path| path.strip_prefix(root).ok())
            .or_else(|| candidate.strip_prefix(root).ok())
            .or_else(|| candidate.strip_prefix(workspace_path).ok())?;
        stripped.to_path_buf()
    } else {
        candidate.to_path_buf()
    };
    // A relative path the provider handed us is only trustworthy if it stays
    // inside the workspace.
    if relative
        .components()
        .any(|component| matches!(component, Component::ParentDir | Component::RootDir))
    {
        return None;
    }
    let relative = relative.to_str()?.to_string();
    if relative.is_empty() {
        return None;
    }
    Some(relative)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn completion(payload: Value) -> TimelineEvent {
        TimelineEvent {
            id: "event-1".to_string(),
            session_id: "session-1".to_string(),
            r#type: "command.completed".to_string(),
            message: "file_change".to_string(),
            payload,
            created_at: "2026-09-01T08:00:00.000Z".to_string(),
            row_cursor: Some(1),
        }
    }

    #[test]
    fn codex_file_change_without_a_diff_asks_to_be_measured() {
        let event = completion(json!({
            "name": "file_change",
            "input": { "changes": [
                { "kind": "update", "path": "/repo/a.sql" },
                { "kind": "add", "path": "/repo/b.yml" }
            ]}
        }));
        assert_eq!(
            paths_awaiting_diff(&event),
            vec!["/repo/a.sql".to_string(), "/repo/b.yml".to_string()]
        );
    }

    #[test]
    fn a_provider_supplied_diff_is_left_alone() {
        let event = completion(json!({
            "name": "file_change",
            "input": { "changes": [
                { "kind": "update", "path": "/repo/a.sql", "unified_diff": "@@ -1 +1 @@" }
            ]}
        }));
        assert!(paths_awaiting_diff(&event).is_empty());
    }

    #[test]
    fn deletions_and_other_tools_are_skipped() {
        let deletion = completion(json!({
            "name": "file_change",
            "input": { "changes": [{ "kind": "delete", "path": "/repo/gone.sql" }] }
        }));
        assert!(paths_awaiting_diff(&deletion).is_empty());

        let other = completion(json!({
            "name": "shell",
            "input": { "changes": [{ "kind": "update", "path": "/repo/a.sql" }] }
        }));
        assert!(paths_awaiting_diff(&other).is_empty());

        let mut started = completion(json!({
            "name": "file_change",
            "input": { "changes": [{ "kind": "update", "path": "/repo/a.sql" }] }
        }));
        started.r#type = "command.started".to_string();
        assert!(paths_awaiting_diff(&started).is_empty());
    }

    #[test]
    fn merging_writes_the_diff_into_both_change_lists() {
        let mut payload = json!({
            "name": "file_change",
            "changes": [{ "kind": "update", "path": "/repo/a.sql" }],
            "input": { "changes": [{ "kind": "update", "path": "/repo/a.sql" }] }
        });
        let measured = vec![(
            "/repo/a.sql".to_string(),
            "@@ -1 +1 @@\n-old\n+new".to_string(),
        )];
        assert!(merge_measured_diffs(&mut payload, &measured));
        assert_eq!(
            payload["input"]["changes"][0]["unified_diff"],
            json!("@@ -1 +1 @@\n-old\n+new")
        );
        assert_eq!(
            payload["changes"][0]["unified_diff"],
            json!("@@ -1 +1 @@\n-old\n+new")
        );
    }

    #[test]
    fn merging_an_unrelated_path_changes_nothing() {
        let mut payload = json!({
            "input": { "changes": [{ "kind": "update", "path": "/repo/a.sql" }] }
        });
        let measured = vec![("/repo/other.sql".to_string(), "@@ -1 +1 @@".to_string())];
        assert!(!merge_measured_diffs(&mut payload, &measured));
        assert!(payload["input"]["changes"][0].get("unified_diff").is_none());
    }

    #[test]
    fn paths_outside_the_workspace_are_not_measurable() {
        let workspace = tempfile::TempDir::new().expect("temp dir");
        let root = workspace.path();
        std::fs::write(root.join("inside.txt"), "x").expect("write");

        let measurable = measurable_paths(
            root,
            &[
                root.join("inside.txt").to_string_lossy().to_string(),
                "../escape.txt".to_string(),
                "/etc/hosts".to_string(),
                "missing.txt".to_string(),
            ],
        );
        assert_eq!(
            measurable,
            vec![(
                root.join("inside.txt").to_string_lossy().to_string(),
                "inside.txt".to_string()
            )]
        );
    }

    #[tokio::test]
    async fn a_session_with_no_mark_measures_nothing() {
        let diffs = MeasuredDiffs::default();
        assert!(diffs
            .measure("unknown-session", &["/repo/a.sql".to_string()])
            .await
            .is_empty());
    }

    #[tokio::test]
    async fn two_writes_to_one_file_each_report_their_own_lines() {
        let workspace = tempfile::TempDir::new().expect("temp dir");
        let root = workspace.path();
        for args in [
            vec!["init", "--initial-branch=main"],
            vec!["config", "user.email", "test@example.com"],
            vec!["config", "user.name", "Test"],
        ] {
            crate::git::exec::run_git_text(root, args, std::time::Duration::from_secs(30))
                .await
                .expect("git setup");
        }
        std::fs::write(root.join("model.sql"), "one\ntwo\n").expect("write");
        crate::git::exec::run_git_text(root, ["add", "-A"], std::time::Duration::from_secs(30))
            .await
            .expect("git add");
        crate::git::exec::run_git_text(
            root,
            ["commit", "-m", "init"],
            std::time::Duration::from_secs(30),
        )
        .await
        .expect("git commit");

        let diffs = MeasuredDiffs::default();
        let mark = diffs.open_turn("session-1", root.to_path_buf());
        capture_opening_mark(mark).await;

        let reported = root.join("model.sql").to_string_lossy().to_string();
        std::fs::write(root.join("model.sql"), "one\ntwo\nthree\n").expect("write");
        let first = diffs
            .measure("session-1", std::slice::from_ref(&reported))
            .await;
        assert_eq!(first.len(), 1);
        assert!(first[0].1.contains("+three"), "first diff:\n{}", first[0].1);

        std::fs::write(root.join("model.sql"), "one\ntwo\nthree\nfour\n").expect("write");
        let second = diffs
            .measure("session-1", std::slice::from_ref(&reported))
            .await;
        assert_eq!(second.len(), 1);
        assert!(
            second[0].1.contains("+four"),
            "second diff:\n{}",
            second[0].1
        );
        assert!(
            !second[0].1.contains("+three"),
            "the second write must not re-report the first write's line:\n{}",
            second[0].1
        );

        // An unchanged file reports nothing at all.
        assert!(diffs.measure("session-1", &[reported]).await.is_empty());
    }
}
