//! Grok Build's folder-trust store, edited the way Grok itself edits it.
//!
//! Grok gates repo-local MCP servers (and project hooks, and repo-local LSP
//! servers) on whether the user has trusted the folder. The decision lives in
//! one global file, `$GROK_HOME/trusted_folders.toml`, defaulting to
//! `~/.grok/trusted_folders.toml`:
//!
//! ```toml
//! [folders."/Users/me/dev/thing"]
//! trusted = true
//! decided_at = 1788149659
//! ```
//!
//! Verified against `grok inspect --json` 1.0.13: with a `.grok/config.toml`
//! present and no entry, `projectTrusted` is `false` and the `argmax` server
//! is absent; adding the entry flips both. Grok matches the *canonicalised*
//! path (a `/tmp/...` key does not match a `/private/tmp/...` cwd), so the key
//! is `fs::canonicalize`d before it is written or looked for.
//!
//! Trust is coarser than the launch that needs it, so the grant is scoped as
//! tightly as the launch: written when a Grok child spawns, removed when it
//! exits, ref-counted so parallel sessions over one checkout hold it together.
//! Two things are never touched: an entry that already existed when we first
//! looked (that is the user's own decision, not ours), and an entry whose
//! `decided_at` has changed under us (the user trusted the folder themselves
//! while we held it). Both leave the store as we found it.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// One grant Argmax owns: how many live launches want it, and the timestamp we
/// wrote, which is what proves the entry in the file is still ours.
struct Grant {
    holders: usize,
    decided_at: i64,
}

fn grants() -> &'static Mutex<HashMap<PathBuf, Grant>> {
    static GRANTS: OnceLock<Mutex<HashMap<PathBuf, Grant>>> = OnceLock::new();
    GRANTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Record `workspace_path` as trusted, so Grok loads the `.grok/config.toml`
/// Argmax wrote beside it. Returns the canonical path when a matching
/// [`release`] is owed, and `None` when there is nothing to undo — the folder
/// was already trusted, the path is one Grok itself refuses to record, or
/// there is no Grok home to write into.
pub fn grant(workspace_path: &Path) -> Option<PathBuf> {
    let folder = fs::canonicalize(workspace_path).ok()?;
    if !is_recordable(&folder) {
        return None;
    }
    let store = store_path()?;
    let key = folder.to_string_lossy().into_owned();

    let mut held = grants()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(grant) = held.get_mut(&folder) {
        grant.holders += 1;
        return Some(folder);
    }
    let existing = fs::read_to_string(&store).unwrap_or_default();
    if find_entry(&existing, &key).is_some() {
        // The user's own decision. Leave it, and owe no cleanup.
        return None;
    }
    let decided_at = now_seconds();
    let Some(updated) = with_entry(&existing, &key, decided_at) else {
        return None;
    };
    if !write_store(&store, &updated) {
        return None;
    }
    held.insert(
        folder.clone(),
        Grant {
            holders: 1,
            decided_at,
        },
    );
    Some(folder)
}

/// Drop one holder of the grant on `folder`, removing the entry once the last
/// one goes — unless the stored `decided_at` has changed, which means the user
/// re-trusted the folder themselves and the entry is no longer ours to remove.
pub fn release(folder: &Path) {
    let Some(store) = store_path() else {
        return;
    };
    let key = folder.to_string_lossy().into_owned();

    let mut held = grants()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(grant) = held.get_mut(folder) else {
        return;
    };
    grant.holders -= 1;
    if grant.holders > 0 {
        return;
    }
    let decided_at = grant.decided_at;
    held.remove(folder);

    let existing = fs::read_to_string(&store).unwrap_or_default();
    if decided_at_for(&existing, &key) != Some(decided_at) {
        return;
    }
    if let Some(updated) = without_entry(&existing, &key) {
        write_store(&store, &updated);
    }
}

/// Under test the store is a throwaway file, resolved without consulting the
/// environment at all, so no test — including one that reaches this module
/// indirectly through a launch — can write the developer's own
/// `~/.grok/trusted_folders.toml`. Entries are keyed by path, so tests sharing
/// the one file do not collide.
#[cfg(test)]
pub(super) fn store_path() -> Option<PathBuf> {
    static STORE: OnceLock<tempfile::TempDir> = OnceLock::new();
    let home = STORE.get_or_init(|| tempfile::tempdir().expect("temp grok home"));
    Some(home.path().join("trusted_folders.toml"))
}

/// `$GROK_HOME/trusted_folders.toml`, else `~/.grok/trusted_folders.toml`.
#[cfg(not(test))]
fn store_path() -> Option<PathBuf> {
    let home = match std::env::var_os("GROK_HOME") {
        Some(value) if !value.is_empty() => PathBuf::from(value),
        _ => PathBuf::from(std::env::var_os("HOME")?).join(".grok"),
    };
    Some(home.join("trusted_folders.toml"))
}

/// Grok refuses to record "an over-broad root (home, filesystem root, or
/// non-absolute path)". Refuse the same set rather than write an entry Grok
/// would never have written.
fn is_recordable(folder: &Path) -> bool {
    if !folder.is_absolute() || folder.parent().is_none() {
        return false;
    }
    match std::env::var_os("HOME") {
        Some(home) => folder != Path::new(&home),
        None => true,
    }
}

/// Replace the store in one step, so a reader never sees a half-written file.
fn write_store(store: &Path, body: &str) -> bool {
    let Some(parent) = store.parent() else {
        return false;
    };
    if let Err(error) = fs::create_dir_all(parent) {
        tracing::warn!(?error, path = %store.display(), "could not create the Grok home");
        return false;
    }
    let staged = store.with_extension("toml.argmax-tmp");
    if let Err(error) = fs::write(&staged, body) {
        tracing::warn!(?error, path = %staged.display(), "could not stage the Grok trust store");
        return false;
    }
    if let Err(error) = fs::rename(&staged, store) {
        tracing::warn!(?error, path = %store.display(), "could not replace the Grok trust store");
        let _ = fs::remove_file(&staged);
        return false;
    }
    true
}

fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or_default()
}

/// The table header Grok writes for one folder: `[folders."<path>"]`. A TOML
/// basic string escapes exactly as a JSON string does.
fn header_for(folder: &str) -> String {
    format!(
        "[folders.{}]",
        serde_json::Value::String(folder.to_string())
    )
}

/// The line range `[start, end)` of the folder's table, header included, or
/// `None` when the folder has no entry.
fn find_entry(body: &str, folder: &str) -> Option<(usize, usize)> {
    let header = header_for(folder);
    let lines: Vec<&str> = body.lines().collect();
    let start = lines.iter().position(|line| line.trim() == header)?;
    let end = lines
        .iter()
        .skip(start + 1)
        .position(|line| line.trim_start().starts_with('['))
        .map(|offset| start + 1 + offset)
        .unwrap_or(lines.len());
    Some((start, end))
}

fn decided_at_for(body: &str, folder: &str) -> Option<i64> {
    let (start, end) = find_entry(body, folder)?;
    body.lines()
        .take(end)
        .skip(start + 1)
        .find_map(|line| line.trim().strip_prefix("decided_at"))
        .and_then(|rest| rest.trim().strip_prefix('='))
        .and_then(|value| value.trim().parse().ok())
}

/// The store with the folder appended as a trusted entry, or `None` when it is
/// already there. Every existing byte is carried over unchanged.
fn with_entry(body: &str, folder: &str, decided_at: i64) -> Option<String> {
    if find_entry(body, folder).is_some() {
        return None;
    }
    let mut updated = body.to_string();
    if !updated.is_empty() {
        if !updated.ends_with('\n') {
            updated.push('\n');
        }
        if !updated.ends_with("\n\n") {
            updated.push('\n');
        }
    }
    updated.push_str(&format!(
        "{}\ntrusted = true\ndecided_at = {decided_at}\n",
        header_for(folder)
    ));
    Some(updated)
}

/// The store with the folder's entry dropped, or `None` when it is not there.
/// The blank line that separated it goes with it; nothing else moves.
fn without_entry(body: &str, folder: &str) -> Option<String> {
    let (start, mut end) = find_entry(body, folder)?;
    let lines: Vec<&str> = body.lines().collect();
    while end < lines.len() && lines[end].trim().is_empty() {
        end += 1;
    }
    let mut kept: Vec<&str> = lines[..start].to_vec();
    kept.extend_from_slice(&lines[end..]);
    while kept.last().is_some_and(|line| line.trim().is_empty()) {
        kept.pop();
    }
    if kept.is_empty() {
        return Some(String::new());
    }
    Some(format!("{}\n", kept.join("\n")))
}

#[cfg(test)]
mod tests {
    use super::*;

    const OTHERS: &str = "[folders.\"/Users/me/dev/menti/argmax\"]\ntrusted = true\ndecided_at = 1788149659\n\n[folders.\"/Users/me/dotfiles\"]\ntrusted = true\ndecided_at = 1788065646\n";

    #[test]
    fn an_entry_is_appended_in_groks_own_shape() {
        let updated = with_entry("", "/repo/wt", 1788149659).expect("appended");
        assert_eq!(
            updated,
            "[folders.\"/repo/wt\"]\ntrusted = true\ndecided_at = 1788149659\n"
        );
        assert_eq!(decided_at_for(&updated, "/repo/wt"), Some(1788149659));
    }

    #[test]
    fn appending_leaves_every_other_entry_byte_for_byte() {
        let updated = with_entry(OTHERS, "/repo/wt", 42).expect("appended");
        assert!(updated.starts_with(OTHERS));
        assert_eq!(
            &updated[OTHERS.len()..],
            "\n[folders.\"/repo/wt\"]\ntrusted = true\ndecided_at = 42\n"
        );
    }

    #[test]
    fn a_folder_that_is_already_trusted_is_left_alone() {
        assert!(with_entry(OTHERS, "/Users/me/dotfiles", 42).is_none());
        assert!(with_entry(OTHERS, "/Users/me/dev/menti/argmax", 42).is_none());
    }

    #[test]
    fn removing_our_entry_restores_the_store_exactly() {
        let updated = with_entry(OTHERS, "/repo/wt", 42).expect("appended");
        assert_eq!(
            without_entry(&updated, "/repo/wt").expect("removed"),
            OTHERS
        );
    }

    #[test]
    fn removing_the_middle_entry_keeps_its_neighbours() {
        let removed = without_entry(OTHERS, "/Users/me/dev/menti/argmax").expect("removed");
        assert_eq!(
            removed,
            "[folders.\"/Users/me/dotfiles\"]\ntrusted = true\ndecided_at = 1788065646\n"
        );
    }

    #[test]
    fn removing_the_only_entry_empties_the_store() {
        let one = with_entry("", "/repo/wt", 42).expect("appended");
        assert_eq!(without_entry(&one, "/repo/wt").expect("removed"), "");
        assert!(without_entry("", "/repo/wt").is_none());
    }

    #[test]
    fn a_path_with_a_quote_stays_a_valid_basic_string() {
        let updated = with_entry("", "/repo/od\"d", 42).expect("appended");
        assert!(updated.starts_with("[folders.\"/repo/od\\\"d\"]\n"));
        assert_eq!(decided_at_for(&updated, "/repo/od\"d"), Some(42));
        assert_eq!(without_entry(&updated, "/repo/od\"d").expect("removed"), "");
    }

    #[test]
    fn the_store_round_trips_through_a_real_file() {
        let home = tempfile::tempdir().expect("temp grok home");
        let store = home.path().join("trusted_folders.toml");
        fs::write(&store, OTHERS).expect("seed");

        let body = fs::read_to_string(&store).expect("read");
        let updated = with_entry(&body, "/repo/wt", 42).expect("appended");
        assert!(write_store(&store, &updated));
        assert_eq!(fs::read_to_string(&store).expect("read"), updated);
        assert!(!store.with_extension("toml.argmax-tmp").exists());

        let body = fs::read_to_string(&store).expect("read");
        assert_eq!(decided_at_for(&body, "/repo/wt"), Some(42));
        let restored = without_entry(&body, "/repo/wt").expect("removed");
        assert!(write_store(&store, &restored));
        assert_eq!(fs::read_to_string(&store).expect("read"), OTHERS);
    }

    #[test]
    fn an_over_broad_root_is_never_recorded() {
        assert!(!is_recordable(Path::new("/")));
        assert!(!is_recordable(Path::new("relative/path")));
        if let Some(home) = std::env::var_os("HOME") {
            assert!(!is_recordable(Path::new(&home)));
            assert!(is_recordable(&PathBuf::from(&home).join("dev")));
        }
    }
}
