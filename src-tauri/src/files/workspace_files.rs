// File-tree + file-content service backing the
// right-panel "Files" view.

// Listing is git-aware (tracked + untracked, respecting `.gitignore`) so the tree mirrors what
// the user actually cares about — no `node_modules` noise. Reads are
// size-capped and binary-aware so a stray click on a multi-MB asset
// doesn't ship megabytes of garbage to the renderer.

use std::{
    collections::{BTreeSet, HashMap},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, UNIX_EPOCH},
};

use serde::Serialize;
use specta::Type;
use tokio::{fs as tokio_fs, io::AsyncReadExt};

use super::git_grep_parser::{
    parse_git_grep_output, GrepParseOptions, WorkspaceContentSearchResult,
};
use crate::error::{ArgmaxError, ArgmaxResult};
use crate::git::exec::{run_git_text, run_git_text_with_allowed_exit_codes};
use crate::persistence::database::Database;
use crate::persistence::projects::require_project;
use crate::persistence::workspaces::find_workspace_by_id;
use crate::util::sync::LockOrRecover;
use crate::util::workspace_paths::{resolve_inside, PathError};
use crate::workspaces::WorkspaceTargetKind;

/// Files larger than this are skipped — preview is not a download manager.
pub const MAX_PREVIEW_BYTES: u64 = 1_048_576;

/// Header sample read for binary detection (NUL byte sniff).
const BINARY_SNIFF_BYTES: usize = 4096;

/// Writes larger than this are rejected. Shared with the IPC schema cap
/// in `validation::MAX_FILE_CONTENT_BYTES` so both boundaries agree.
pub const MAX_WRITE_BYTES: usize = crate::ipc::validation::MAX_FILE_CONTENT_BYTES;

const GIT_TIMEOUT: Duration = Duration::from_secs(30);

// IPC constructs a short-lived service for each request, so file locks need
// process lifetime rather than service lifetime. The key is the caller's
// canonical root plus its validated relative path, which keeps project and
// workspace views of the same checkout in one save order.
static FILE_WRITE_LOCKS: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileEntry {
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum WorkspaceFilePreview {
    Text {
        content: String,
        size: u64,
        #[serde(rename = "mtimeMs")]
        mtime_ms: f64,
    },
    Skipped {
        reason: SkippedReason,
        #[serde(skip_serializing_if = "Option::is_none")]
        size: Option<u64>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum SkippedReason {
    NotAFile,
    TooLarge,
    Binary,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileStat {
    #[serde(rename = "mtimeMs")]
    pub mtime_ms: f64,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(tag = "ok")]
pub enum WorkspaceFileWriteResult {
    #[serde(rename = "true")]
    Ok {
        #[serde(rename = "mtimeMs")]
        mtime_ms: f64,
        size: u64,
    },
    #[serde(rename = "false")]
    Stale {
        reason: WriteStaleReason,
        #[serde(rename = "currentMtimeMs")]
        current_mtime_ms: f64,
        size: u64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum WriteStaleReason {
    Stale,
}

pub struct WorkspaceFilesService {
    database: Arc<Database>,
}

impl WorkspaceFilesService {
    pub fn new(database: Arc<Database>) -> Arc<Self> {
        Arc::new(Self { database })
    }

    pub async fn list_files(
        &self,
        kind: WorkspaceTargetKind,
        id: &str,
    ) -> ArgmaxResult<Vec<WorkspaceFileEntry>> {
        list_files_at_path(&self.root_path(kind, id)?).await
    }

    pub async fn read_file(
        &self,
        kind: WorkspaceTargetKind,
        id: &str,
        file_path: &str,
    ) -> ArgmaxResult<WorkspaceFilePreview> {
        read_file_at_path(&self.root_path(kind, id)?, file_path).await
    }

    pub async fn stat_file(
        &self,
        kind: WorkspaceTargetKind,
        id: &str,
        file_path: &str,
    ) -> ArgmaxResult<WorkspaceFileStat> {
        stat_file_at_path(&self.root_path(kind, id)?, file_path).await
    }

    pub async fn write_file(
        &self,
        kind: WorkspaceTargetKind,
        id: &str,
        file_path: &str,
        content: &str,
        expected_mtime_ms: Option<f64>,
    ) -> ArgmaxResult<WorkspaceFileWriteResult> {
        write_file_at_path(
            &self.root_path(kind, id)?,
            file_path,
            content,
            expected_mtime_ms,
        )
        .await
    }

    pub async fn grep_content(
        &self,
        kind: WorkspaceTargetKind,
        id: &str,
        query: &str,
    ) -> ArgmaxResult<WorkspaceContentSearchResult> {
        grep_content_at_path(&self.root_path(kind, id)?, query).await
    }

    fn root_path(&self, kind: WorkspaceTargetKind, id: &str) -> ArgmaxResult<String> {
        let connection = self.database.connection();
        match kind {
            WorkspaceTargetKind::Workspace => Ok(find_workspace_by_id(&connection, id)?.path),
            WorkspaceTargetKind::Project => Ok(require_project(&connection, id)?.repo_path),
        }
    }
}

async fn list_files_at_path(repo_path: &str) -> ArgmaxResult<Vec<WorkspaceFileEntry>> {
    // `ls-files -z --cached --others --exclude-standard` mirrors the IDE
    // view: tracked + untracked-but-not-ignored. De-dupe — a file tracked
    // AND modified in the index can appear twice.
    let stdout = run_git_text(
        Path::new(repo_path),
        [
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ],
        GIT_TIMEOUT,
    )
    .await?;
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for entry in stdout.split('\0') {
        if entry.is_empty() {
            continue;
        }
        seen.insert(entry.to_string());
    }
    Ok(seen
        .into_iter()
        .map(|path| WorkspaceFileEntry { path })
        .collect())
}

async fn read_file_at_path(repo_path: &str, file_path: &str) -> ArgmaxResult<WorkspaceFilePreview> {
    let resolved = resolve_inside_or_err(repo_path, file_path)?;
    let metadata = tokio_fs::symlink_metadata(&resolved)
        .await
        .map_err(io_error)?;

    // Symlinks and directories are not previewable text. We never follow
    // symlinks for the preview — they could point outside the worktree.
    if !metadata.file_type().is_file() {
        return Ok(WorkspaceFilePreview::Skipped {
            reason: SkippedReason::NotAFile,
            size: None,
        });
    }

    if metadata.len() > MAX_PREVIEW_BYTES {
        return Ok(WorkspaceFilePreview::Skipped {
            reason: SkippedReason::TooLarge,
            size: Some(metadata.len()),
        });
    }

    if looks_binary(&resolved).await? {
        return Ok(WorkspaceFilePreview::Skipped {
            reason: SkippedReason::Binary,
            size: Some(metadata.len()),
        });
    }

    let content = tokio_fs::read_to_string(&resolved)
        .await
        .map_err(io_error)?;
    Ok(WorkspaceFilePreview::Text {
        content,
        size: metadata.len(),
        mtime_ms: mtime_ms(&metadata),
    })
}

async fn stat_file_at_path(repo_path: &str, file_path: &str) -> ArgmaxResult<WorkspaceFileStat> {
    let resolved = resolve_inside_or_err(repo_path, file_path)?;
    let metadata = tokio_fs::symlink_metadata(&resolved)
        .await
        .map_err(io_error)?;
    if !metadata.file_type().is_file() {
        return Err(ArgmaxError::service(
            "WORKSPACE_FILE_NOT_REGULAR",
            "filePath does not point to a regular file",
        ));
    }
    Ok(WorkspaceFileStat {
        mtime_ms: mtime_ms(&metadata),
        size: metadata.len(),
    })
}

async fn write_file_at_path(
    repo_path: &str,
    file_path: &str,
    content: &str,
    expected_mtime_ms: Option<f64>,
) -> ArgmaxResult<WorkspaceFileWriteResult> {
    if content.len() > MAX_WRITE_BYTES {
        return Err(ArgmaxError::service(
            "WORKSPACE_WRITE_TOO_LARGE",
            format!("content exceeds {MAX_WRITE_BYTES} bytes"),
        ));
    }
    let lock_key = format!(
        "{}\0{file_path}",
        resolve_inside_or_err(repo_path, ".")?.display()
    );
    let lock = {
        let mut locks = FILE_WRITE_LOCKS.lock_or_recover("workspace file write locks");
        Arc::clone(
            locks
                .entry(lock_key.clone())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
        )
    };
    let guard = lock.lock().await;

    // Resolve and inspect only after acquiring the keyed lock. A queued save
    // therefore compares its expected version to the file produced by the
    // preceding save, rather than to a version observed before it queued.
    let resolved = resolve_inside_or_err(repo_path, file_path)?;
    let resolved_for_spawn = resolved.clone();
    let repo_path = repo_path.to_owned();
    let buf = content.as_bytes().to_vec();
    let result = tokio::task::spawn_blocking(move || {
        atomic_write_file(&repo_path, &resolved_for_spawn, &buf, expected_mtime_ms)
    })
    .await
    .map_err(|error| {
        ArgmaxError::service(
            "WORKSPACE_FILE_JOIN_FAILED",
            format!("write task panicked: {error}"),
        )
    })
    .and_then(|result| result);
    drop(guard);
    let mut locks = FILE_WRITE_LOCKS.lock_or_recover("workspace file write locks");
    if Arc::strong_count(&lock) == 2 {
        locks.remove(&lock_key);
    }
    result
}

fn atomic_write_file(
    repo_path: &str,
    resolved: &Path,
    content: &[u8],
    expected_mtime_ms: Option<f64>,
) -> ArgmaxResult<WorkspaceFileWriteResult> {
    use std::io::Write;

    let metadata = std::fs::symlink_metadata(resolved).map_err(io_error)?;
    if !metadata.file_type().is_file() {
        return Err(ArgmaxError::service(
            "WORKSPACE_FILE_NOT_REGULAR",
            "filePath does not point to a regular file",
        ));
    }
    let current_mtime = mtime_ms(&metadata);
    if let Some(expected) = expected_mtime_ms {
        if (current_mtime - expected).abs() > f64::EPSILON {
            return Ok(stale_write_result(&metadata));
        }
    }

    // Re-resolve the parent after lock acquisition. This catches a parent
    // symlink swap before the temporary file is created outside the workspace.
    let parent = resolved
        .parent()
        .ok_or_else(|| ArgmaxError::service("WORKSPACE_FILE_NO_PARENT", "no parent directory"))?;
    let _ = resolve_inside_or_err(repo_path, parent_relative(repo_path, parent).as_str())?;
    let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(io_error)?;
    staged
        .as_file_mut()
        .set_permissions(metadata.permissions())
        .map_err(io_error)?;
    staged.write_all(content).map_err(io_error)?;
    staged.as_file_mut().sync_all().map_err(io_error)?;

    // Atomic rename replaces an inode, so compare the current destination
    // immediately before it. An external write or replacement becomes a
    // conflict and leaves both the original and staged data intact.
    let current = std::fs::symlink_metadata(resolved).map_err(io_error)?;
    if !same_file_version(&metadata, &current) {
        return Ok(stale_write_result(&current));
    }
    staged
        .persist(resolved)
        .map_err(|error| io_error(error.error))?;

    let after = std::fs::symlink_metadata(resolved).map_err(io_error)?;
    Ok(WorkspaceFileWriteResult::Ok {
        mtime_ms: mtime_ms(&after),
        size: after.len(),
    })
}

fn stale_write_result(metadata: &std::fs::Metadata) -> WorkspaceFileWriteResult {
    WorkspaceFileWriteResult::Stale {
        reason: WriteStaleReason::Stale,
        current_mtime_ms: mtime_ms(metadata),
        size: metadata.len(),
    }
}

fn same_file_version(before: &std::fs::Metadata, current: &std::fs::Metadata) -> bool {
    before.dev() == current.dev()
        && before.ino() == current.ino()
        && before.len() == current.len()
        && mtime_ms(before) == mtime_ms(current)
}

async fn grep_content_at_path(
    repo_path: &str,
    query: &str,
) -> ArgmaxResult<WorkspaceContentSearchResult> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(WorkspaceContentSearchResult {
            files: Vec::new(),
            truncated: false,
        });
    }
    // git grep flags: -n line numbers, --null NUL-separate fields,
    // --no-color strip ANSI, -I skip binaries, -F fixed-string,
    // --untracked include untracked, -e separator so a query starting
    // with '-' isn't parsed as a flag.
    let result = run_git_text_with_allowed_exit_codes(
        Path::new(repo_path),
        [
            "grep",
            "-n",
            "--null",
            "--no-color",
            "-I",
            "-F",
            "--untracked",
            "-e",
            trimmed,
        ],
        &[1],
        GIT_TIMEOUT,
    )
    .await?;
    if result.exit_code == 1 {
        return Ok(WorkspaceContentSearchResult {
            files: Vec::new(),
            truncated: false,
        });
    }
    Ok(parse_git_grep_output(
        &result.stdout,
        &GrepParseOptions {
            max_files: 50,
            max_matches_per_file: 10,
        },
    ))
}

async fn looks_binary(path: &Path) -> ArgmaxResult<bool> {
    let mut file = tokio_fs::File::open(path).await.map_err(io_error)?;
    let mut buffer = [0_u8; BINARY_SNIFF_BYTES];
    let read = file.read(&mut buffer).await.map_err(io_error)?;
    Ok(buffer[..read].contains(&0))
}

fn resolve_inside_or_err(root: &str, candidate: &str) -> ArgmaxResult<PathBuf> {
    resolve_inside(Path::new(root), Path::new(candidate)).map_err(path_error)
}

fn parent_relative(root: &str, parent: &Path) -> String {
    let root = Path::new(root);
    parent
        .strip_prefix(root)
        .map(|relative| relative.to_string_lossy().into_owned())
        .unwrap_or_else(|_| ".".to_string())
}

fn mtime_ms(metadata: &std::fs::Metadata) -> f64 {
    let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
    modified
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

fn io_error(error: std::io::Error) -> ArgmaxError {
    ArgmaxError::service("WORKSPACE_FILE_IO", error.to_string())
}

fn path_error(error: PathError) -> ArgmaxError {
    ArgmaxError::service("WORKSPACE_PATH_INVALID", error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::projects::{persist_project, PersistProjectInput, ProjectSettings};
    use crate::persistence::workspaces::{persist_workspace, PersistWorkspaceInput};
    use std::path::Path;
    use tempfile::TempDir;

    async fn run_git(repo: &Path, args: &[&str]) {
        run_git_text(repo, args, GIT_TIMEOUT)
            .await
            .unwrap_or_else(|error| panic!("git {args:?} failed: {error}"));
    }

    async fn init_repo(dir: &Path) {
        run_git(dir, &["init", "-q", "-b", "main"]).await;
        run_git(dir, &["config", "user.email", "test@argmax.dev"]).await;
        run_git(dir, &["config", "user.name", "Argmax Test"]).await;
        std::fs::write(dir.join("README.md"), "hello\n").unwrap();
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/lib.rs"), "fn main() {}\n").unwrap();
        // .gitignore + an ignored file
        std::fs::write(dir.join(".gitignore"), "ignored.txt\n").unwrap();
        std::fs::write(dir.join("ignored.txt"), "noise\n").unwrap();
        run_git(dir, &["add", "."]).await;
        run_git(dir, &["commit", "-q", "-m", "init"]).await;
    }

    fn fixture_workspace(database: &Arc<Database>, repo_path: &Path) -> String {
        let conn = database.connection();
        persist_project(
            &conn,
            &PersistProjectInput {
                id: "p1".to_string(),
                name: "fixture".to_string(),
                repo_path: repo_path.to_string_lossy().into_owned(),
                default_branch: Some("main".to_string()),
                current_branch: "main".to_string(),
                settings: ProjectSettings {
                    archive_on_merge: false,
                    worktree_location: repo_path.join(".worktrees").to_string_lossy().into_owned(),
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
                task_label: "files-test".to_string(),
                branch: "main".to_string(),
                base_ref: "main".to_string(),
                path: repo_path.to_string_lossy().into_owned(),
                state: "created".to_string(),
                shared_workspace: true,
                kind: "git".to_string(),
                dirty: false,
                changed_files: 0,
            },
        )
        .expect("workspace");
        "w1".to_string()
    }

    #[tokio::test]
    async fn list_files_omits_gitignored_and_dedupes() {
        let repo = TempDir::new().unwrap();
        init_repo(repo.path()).await;
        let data_dir = TempDir::new().unwrap();
        let database = Arc::new(Database::open(data_dir.path().join("argmax.sqlite")).unwrap());
        let workspace_id = fixture_workspace(&database, repo.path());
        let svc = WorkspaceFilesService::new(database);
        let entries = svc
            .list_files(WorkspaceTargetKind::Workspace, &workspace_id)
            .await
            .unwrap();
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
        assert!(paths.contains(&"README.md"));
        assert!(paths.contains(&"src/lib.rs"));
        assert!(!paths.contains(&"ignored.txt"));
    }

    #[tokio::test]
    async fn read_file_returns_text_for_utf8_under_cap() {
        let repo = TempDir::new().unwrap();
        init_repo(repo.path()).await;
        let data_dir = TempDir::new().unwrap();
        let database = Arc::new(Database::open(data_dir.path().join("argmax.sqlite")).unwrap());
        let workspace_id = fixture_workspace(&database, repo.path());
        let svc = WorkspaceFilesService::new(database);
        let preview = svc
            .read_file(WorkspaceTargetKind::Workspace, &workspace_id, "README.md")
            .await
            .unwrap();
        match preview {
            WorkspaceFilePreview::Text { content, .. } => assert_eq!(content, "hello\n"),
            other => panic!("expected text preview, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn read_file_allows_leading_dash_name() {
        let repo = TempDir::new().unwrap();
        init_repo(repo.path()).await;
        std::fs::write(repo.path().join("-notes.md"), "dash file\n").unwrap();

        let data_dir = TempDir::new().unwrap();
        let database = Arc::new(Database::open(data_dir.path().join("argmax.sqlite")).unwrap());
        let workspace_id = fixture_workspace(&database, repo.path());
        let svc = WorkspaceFilesService::new(database);
        let preview = svc
            .read_file(WorkspaceTargetKind::Workspace, &workspace_id, "-notes.md")
            .await
            .unwrap();
        match preview {
            WorkspaceFilePreview::Text { content, .. } => assert_eq!(content, "dash file\n"),
            other => panic!("expected text preview, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn read_file_skips_binary() {
        let repo = TempDir::new().unwrap();
        init_repo(repo.path()).await;
        std::fs::write(repo.path().join("blob.bin"), [0u8, 1u8, 2u8, 0u8, 5u8]).unwrap();
        run_git(repo.path(), &["add", "blob.bin"]).await;
        run_git(repo.path(), &["commit", "-q", "-m", "bin"]).await;

        let data_dir = TempDir::new().unwrap();
        let database = Arc::new(Database::open(data_dir.path().join("argmax.sqlite")).unwrap());
        let workspace_id = fixture_workspace(&database, repo.path());
        let svc = WorkspaceFilesService::new(database);
        let preview = svc
            .read_file(WorkspaceTargetKind::Workspace, &workspace_id, "blob.bin")
            .await
            .unwrap();
        match preview {
            WorkspaceFilePreview::Skipped { reason, .. } => {
                assert_eq!(reason, SkippedReason::Binary);
            }
            other => panic!("expected binary-skip, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn write_file_rejects_stale_mtime() {
        let repo = TempDir::new().unwrap();
        init_repo(repo.path()).await;
        let data_dir = TempDir::new().unwrap();
        let database = Arc::new(Database::open(data_dir.path().join("argmax.sqlite")).unwrap());
        let workspace_id = fixture_workspace(&database, repo.path());
        let svc = WorkspaceFilesService::new(database);
        let result = svc
            .write_file(
                WorkspaceTargetKind::Workspace,
                &workspace_id,
                "README.md",
                "new content\n",
                Some(0.0_f64),
            )
            .await
            .unwrap();
        match result {
            WorkspaceFileWriteResult::Stale { reason, .. } => {
                assert_eq!(reason, WriteStaleReason::Stale);
            }
            other => panic!("expected stale, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn write_file_replaces_content_when_mtime_matches() {
        let repo = TempDir::new().unwrap();
        init_repo(repo.path()).await;
        let data_dir = TempDir::new().unwrap();
        let database = Arc::new(Database::open(data_dir.path().join("argmax.sqlite")).unwrap());
        let workspace_id = fixture_workspace(&database, repo.path());
        let svc = WorkspaceFilesService::new(database);
        let stat = svc
            .stat_file(WorkspaceTargetKind::Workspace, &workspace_id, "README.md")
            .await
            .unwrap();
        let result = svc
            .write_file(
                WorkspaceTargetKind::Workspace,
                &workspace_id,
                "README.md",
                "new content\n",
                Some(stat.mtime_ms),
            )
            .await
            .unwrap();
        match result {
            WorkspaceFileWriteResult::Ok { size, .. } => assert_eq!(size as usize, 12),
            other => panic!("expected ok, got {other:?}"),
        }
        let on_disk = std::fs::read_to_string(repo.path().join("README.md")).unwrap();
        assert_eq!(on_disk, "new content\n");
    }

    #[tokio::test]
    async fn overlapping_writes_use_one_version_and_do_not_overwrite_the_winner() {
        let repo = TempDir::new().unwrap();
        init_repo(repo.path()).await;
        let data_dir = TempDir::new().unwrap();
        let database = Arc::new(Database::open(data_dir.path().join("argmax.sqlite")).unwrap());
        let workspace_id = fixture_workspace(&database, repo.path());
        let svc = WorkspaceFilesService::new(database);
        let expected = svc
            .stat_file(WorkspaceTargetKind::Workspace, &workspace_id, "README.md")
            .await
            .unwrap()
            .mtime_ms;

        let first = svc.write_file(
            WorkspaceTargetKind::Workspace,
            &workspace_id,
            "README.md",
            "first save\n",
            Some(expected),
        );
        let second = svc.write_file(
            WorkspaceTargetKind::Workspace,
            &workspace_id,
            "README.md",
            "second save\n",
            Some(expected),
        );
        let (first, second) = tokio::join!(first, second);
        let results = [first.unwrap(), second.unwrap()];
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, WorkspaceFileWriteResult::Ok { .. }))
                .count(),
            1
        );
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, WorkspaceFileWriteResult::Stale { .. }))
                .count(),
            1
        );
        let on_disk = std::fs::read_to_string(repo.path().join("README.md")).unwrap();
        assert!(on_disk == "first save\n" || on_disk == "second save\n");
    }

    #[tokio::test]
    async fn external_change_returns_stale_and_preserves_external_content() {
        let repo = TempDir::new().unwrap();
        init_repo(repo.path()).await;
        let data_dir = TempDir::new().unwrap();
        let database = Arc::new(Database::open(data_dir.path().join("argmax.sqlite")).unwrap());
        let workspace_id = fixture_workspace(&database, repo.path());
        let svc = WorkspaceFilesService::new(database);
        let expected = svc
            .stat_file(WorkspaceTargetKind::Workspace, &workspace_id, "README.md")
            .await
            .unwrap()
            .mtime_ms;
        tokio::time::sleep(Duration::from_millis(2)).await;
        std::fs::write(repo.path().join("README.md"), "external edit\n").unwrap();

        let result = svc
            .write_file(
                WorkspaceTargetKind::Workspace,
                &workspace_id,
                "README.md",
                "editor edit\n",
                Some(expected),
            )
            .await
            .unwrap();
        assert!(matches!(result, WorkspaceFileWriteResult::Stale { .. }));
        assert_eq!(
            std::fs::read_to_string(repo.path().join("README.md")).unwrap(),
            "external edit\n"
        );
    }

    #[tokio::test]
    async fn rejected_write_leaves_original_file_intact() {
        let repo = TempDir::new().unwrap();
        init_repo(repo.path()).await;
        let data_dir = TempDir::new().unwrap();
        let database = Arc::new(Database::open(data_dir.path().join("argmax.sqlite")).unwrap());
        let workspace_id = fixture_workspace(&database, repo.path());
        let svc = WorkspaceFilesService::new(database);

        let error = svc
            .write_file(
                WorkspaceTargetKind::Workspace,
                &workspace_id,
                "README.md",
                &"x".repeat(MAX_WRITE_BYTES + 1),
                None,
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("content exceeds"));
        assert_eq!(
            std::fs::read_to_string(repo.path().join("README.md")).unwrap(),
            "hello\n"
        );
    }

    #[tokio::test]
    async fn grep_content_finds_query_and_handles_no_match() {
        let repo = TempDir::new().unwrap();
        init_repo(repo.path()).await;
        let data_dir = TempDir::new().unwrap();
        let database = Arc::new(Database::open(data_dir.path().join("argmax.sqlite")).unwrap());
        let workspace_id = fixture_workspace(&database, repo.path());
        let svc = WorkspaceFilesService::new(database);
        let hit = svc
            .grep_content(WorkspaceTargetKind::Workspace, &workspace_id, "hello")
            .await
            .unwrap();
        assert!(hit.files.iter().any(|file| file.path == "README.md"));
        let miss = svc
            .grep_content(
                WorkspaceTargetKind::Workspace,
                &workspace_id,
                "deadbeef-nope",
            )
            .await
            .unwrap();
        assert!(miss.files.is_empty());
        assert!(!miss.truncated);
    }
}
