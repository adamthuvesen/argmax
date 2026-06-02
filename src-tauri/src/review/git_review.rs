use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use specta::Type;
use tokio::{sync::Semaphore, task::JoinSet};

use crate::{
    error::{ArgmaxError, ArgmaxResult},
    git::exec::{reject_leading_dash, run_git_text, run_git_text_with_allowed_exit_codes},
    persistence::database::Database,
    persistence::projects::require_project,
    persistence::workspaces::find_workspace_by_id,
    util::workspace_paths::{resolve_inside, PathError},
};

pub const DIFF_FANOUT_LIMIT: usize = 8;
pub const PER_FILE_DIFF_CAP_BYTES: usize = 1_048_576;
const GIT_TIMEOUT: Duration = Duration::from_secs(30);

/// Which baseline the review diff is computed against.
///
/// `WorkingTree` is the historical behavior: working tree vs `HEAD` (whatever is
/// uncommitted). `Branch` shows the whole delta from the base branch — committed
/// *and* uncommitted *and* untracked — computed from `merge-base(base_ref, HEAD)`
/// to the working tree, i.e. "everything different from main".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ReviewComparison {
    #[default]
    WorkingTree,
    Branch,
}

/// The diff baseline resolved for a single request. `diff_base` is the git
/// revision the per-file `git diff` runs against (`HEAD` for working-tree mode,
/// the merge-base sha for branch mode); `branch_mode` selects how the file list
/// is gathered.
struct ResolvedComparison {
    diff_base: String,
    branch_mode: bool,
}

async fn resolve_comparison(
    repo_path: &Path,
    base_ref: Option<&str>,
) -> ArgmaxResult<ResolvedComparison> {
    match base_ref {
        None => Ok(ResolvedComparison {
            diff_base: "HEAD".to_owned(),
            branch_mode: false,
        }),
        Some(base_ref) => Ok(ResolvedComparison {
            diff_base: compute_merge_base(repo_path, base_ref).await?,
            branch_mode: true,
        }),
    }
}

/// Resolve the merge-base of `base_ref` and `HEAD` so the branch diff ignores
/// commits that landed on the base branch after this branch forked (the same
/// fork-point a three-dot `base...HEAD` PR diff uses), while still letting the
/// working tree be the right-hand side so uncommitted work is included.
async fn compute_merge_base(repo_path: &Path, base_ref: &str) -> ArgmaxResult<String> {
    reject_leading_dash("base ref", base_ref)?;
    // Exit code 1 = no common ancestor; treat it as a clean "no merge base"
    // rather than a hard git failure so we can return a readable error.
    let exit = run_git_text_with_allowed_exit_codes(
        repo_path,
        ["merge-base", base_ref, "HEAD"],
        &[1],
        GIT_TIMEOUT,
    )
    .await?;
    let sha = exit.stdout.trim();
    if sha.is_empty() {
        return Err(ArgmaxError::service(
            "REVIEW_MERGE_BASE",
            format!("no common ancestor between '{base_ref}' and HEAD"),
        ));
    }
    Ok(sha.to_owned())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFileSummary {
    pub path: String,
    pub status: String,
    pub additions: usize,
    pub deletions: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDiff {
    pub workspace_id: String,
    pub file_path: Option<String>,
    pub content: String,
}

pub async fn list_changed_files(
    database: &Database,
    workspace_id: &str,
    comparison: ReviewComparison,
) -> ArgmaxResult<Vec<ChangedFileSummary>> {
    let workspace = {
        let connection = database.connection();
        find_workspace_by_id(&connection, workspace_id)?
    };
    let base_ref = comparison_base_ref(comparison, &workspace.base_ref);
    list_changed_files_at_path(workspace.path, base_ref).await
}

pub async fn load_diff(
    database: &Database,
    workspace_id: &str,
    file_path: Option<&str>,
    comparison: ReviewComparison,
) -> ArgmaxResult<WorkspaceDiff> {
    let workspace = {
        let connection = database.connection();
        find_workspace_by_id(&connection, workspace_id)?
    };
    let base_ref = comparison_base_ref(comparison, &workspace.base_ref);
    load_diff_at_path(workspace.path, workspace_id.to_owned(), file_path, base_ref).await
}

pub async fn list_changed_files_for_project(
    database: &Database,
    project_id: &str,
    comparison: ReviewComparison,
) -> ArgmaxResult<Vec<ChangedFileSummary>> {
    let project = {
        let connection = database.connection();
        require_project(&connection, project_id)?
    };
    let project_base = project_base_ref(&project.default_branch, &project.current_branch);
    let base_ref = comparison_base_ref(comparison, project_base);
    list_changed_files_at_path(project.repo_path, base_ref).await
}

pub async fn load_diff_for_project(
    database: &Database,
    project_id: &str,
    file_path: Option<&str>,
    comparison: ReviewComparison,
) -> ArgmaxResult<WorkspaceDiff> {
    let project = {
        let connection = database.connection();
        require_project(&connection, project_id)?
    };
    let project_base = project_base_ref(&project.default_branch, &project.current_branch);
    let base_ref = comparison_base_ref(comparison, project_base);
    // The WorkspaceDiff response shape still uses `workspaceId` as the key —
    // we reuse it for the project's repoPath-rooted view; renderer never
    // round-trips this id back, so keeping the type unchanged is safer than
    // forking the shape.
    load_diff_at_path(project.repo_path, project_id.to_owned(), file_path, base_ref).await
}

/// `None` ⇒ working-tree mode (diff vs HEAD); `Some(base_ref)` ⇒ branch mode
/// (diff vs the merge-base with `base_ref`).
fn comparison_base_ref(comparison: ReviewComparison, base_ref: &str) -> Option<&str> {
    match comparison {
        ReviewComparison::WorkingTree => None,
        ReviewComparison::Branch => Some(base_ref),
    }
}

/// A project's review baseline is its default branch, falling back to the
/// currently checked-out branch when no default is recorded.
fn project_base_ref<'a>(default_branch: &'a Option<String>, current_branch: &'a str) -> &'a str {
    default_branch.as_deref().unwrap_or(current_branch)
}

pub async fn list_changed_files_at_path(
    repo_path: impl AsRef<Path>,
    base_ref: Option<&str>,
) -> ArgmaxResult<Vec<ChangedFileSummary>> {
    let repo_path = validate_repo_path(repo_path.as_ref())?;
    let comparison = resolve_comparison(&repo_path, base_ref).await?;
    let files = collect_changed_files(&repo_path, &comparison).await?;
    load_file_summaries(repo_path, files, comparison.diff_base).await
}

pub async fn load_diff_at_path(
    repo_path: impl AsRef<Path>,
    diff_workspace_id: impl Into<String>,
    file_path: Option<&str>,
    base_ref: Option<&str>,
) -> ArgmaxResult<WorkspaceDiff> {
    let repo_path = validate_repo_path(repo_path.as_ref())?;
    let comparison = resolve_comparison(&repo_path, base_ref).await?;
    let diff_workspace_id = diff_workspace_id.into();
    let content = match file_path {
        Some(path) => {
            validate_relative_review_path(&repo_path, path)?;
            // The working-tree status still tells us whether the file is
            // untracked (so we synthesize) versus a regular diff target; in
            // branch mode a committed-but-clean file simply won't appear here
            // and falls through to a plain `git diff <base> -- path`.
            let porcelain = run_git_text(
                &repo_path,
                ["status", "--porcelain=v1", "-z", "--", path],
                GIT_TIMEOUT,
            )
            .await?;
            let file = parse_porcelain_z(&porcelain)
                .into_iter()
                .find(|item| item.path == path);
            // In branch mode a committed-but-clean file isn't in working-tree
            // status. Recover its change entry from the branch-vs-base list,
            // which carries `old_path` for committed renames, so the opened
            // diff renders the same rename the file list shows instead of an
            // orphaned add. A plain `git diff <base> -- path` is the fallback.
            let file = match file {
                Some(file) => Some(file),
                None if comparison.branch_mode => collect_changed_files(&repo_path, &comparison)
                    .await?
                    .into_iter()
                    .find(|item| item.path == path),
                None => None,
            };
            match file {
                Some(file) => load_file_diff(&repo_path, &file, &comparison.diff_base).await?,
                None => {
                    run_git_text(
                        &repo_path,
                        ["diff", comparison.diff_base.as_str(), "--", path],
                        GIT_TIMEOUT,
                    )
                    .await?
                }
            }
        }
        None => {
            let files = collect_changed_files(&repo_path, &comparison).await?;
            let diffs = load_file_diffs(repo_path.clone(), files, comparison.diff_base).await?;
            diffs
                .into_iter()
                .filter(|content| !content.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
        }
    };

    Ok(WorkspaceDiff {
        workspace_id: diff_workspace_id,
        file_path: file_path.map(ToOwned::to_owned),
        content,
    })
}

/// Gather the changed-file list for a comparison.
///
/// Working-tree mode is the porcelain status (the historical behavior). Branch
/// mode lists tracked files changed since the merge-base via
/// `git diff --name-status` (committed + staged + unstaged) and folds in
/// untracked files from porcelain, since `git diff` never reports those.
async fn collect_changed_files(
    repo_path: &Path,
    comparison: &ResolvedComparison,
) -> ArgmaxResult<Vec<ChangedFileSummary>> {
    if !comparison.branch_mode {
        let porcelain =
            run_git_text(repo_path, ["status", "--porcelain=v1", "-z"], GIT_TIMEOUT).await?;
        return Ok(parse_porcelain_z(&porcelain)
            .into_iter()
            .filter(|file| !file.path.ends_with('/'))
            .collect());
    }

    let name_status = run_git_text(
        repo_path,
        ["diff", "--name-status", "-z", comparison.diff_base.as_str()],
        GIT_TIMEOUT,
    )
    .await?;
    let mut files = parse_name_status_z(&name_status);
    let seen: HashSet<String> = files.iter().map(|file| file.path.clone()).collect();

    let porcelain =
        run_git_text(repo_path, ["status", "--porcelain=v1", "-z"], GIT_TIMEOUT).await?;
    for file in parse_porcelain_z(&porcelain) {
        if file.status == "??" && !file.path.ends_with('/') && !seen.contains(&file.path) {
            files.push(file);
        }
    }

    files.retain(|file| !file.path.ends_with('/'));
    Ok(files)
}

async fn load_file_summaries(
    repo_path: PathBuf,
    files: Vec<ChangedFileSummary>,
    diff_base: String,
) -> ArgmaxResult<Vec<ChangedFileSummary>> {
    let semaphore = Arc::new(Semaphore::new(DIFF_FANOUT_LIMIT));
    let diff_base = Arc::new(diff_base);
    let mut tasks = JoinSet::new();
    for (index, file) in files.into_iter().enumerate() {
        let repo_path = repo_path.clone();
        let semaphore = semaphore.clone();
        let diff_base = diff_base.clone();
        tasks.spawn(async move {
            let _permit = semaphore.acquire_owned().await.map_err(|error| {
                ArgmaxError::service(
                    "REVIEW_FANOUT_CLOSED",
                    format!("diff fanout closed: {error}"),
                )
            })?;
            let diff = load_file_diff(&repo_path, &file, &diff_base).await?;
            let (additions, deletions) = count_diff_lines(&diff);
            Ok::<_, ArgmaxError>((
                index,
                ChangedFileSummary {
                    additions,
                    deletions,
                    ..file
                },
            ))
        });
    }

    collect_ordered(tasks).await
}

async fn load_file_diffs(
    repo_path: PathBuf,
    files: Vec<ChangedFileSummary>,
    diff_base: String,
) -> ArgmaxResult<Vec<String>> {
    let semaphore = Arc::new(Semaphore::new(DIFF_FANOUT_LIMIT));
    let diff_base = Arc::new(diff_base);
    let mut tasks = JoinSet::new();
    for (index, file) in files.into_iter().enumerate() {
        let repo_path = repo_path.clone();
        let semaphore = semaphore.clone();
        let diff_base = diff_base.clone();
        tasks.spawn(async move {
            let _permit = semaphore.acquire_owned().await.map_err(|error| {
                ArgmaxError::service(
                    "REVIEW_FANOUT_CLOSED",
                    format!("diff fanout closed: {error}"),
                )
            })?;
            Ok::<_, ArgmaxError>((index, load_file_diff(&repo_path, &file, &diff_base).await?))
        });
    }

    collect_ordered(tasks).await
}

async fn collect_ordered<T: Send + 'static>(
    mut tasks: JoinSet<ArgmaxResult<(usize, T)>>,
) -> ArgmaxResult<Vec<T>> {
    let mut results = Vec::new();
    while let Some(result) = tasks.join_next().await {
        let (index, value) = result.map_err(|error| {
            ArgmaxError::service("REVIEW_TASK_JOIN_FAILED", error.to_string())
        })??;
        results.push((index, value));
    }
    results.sort_by_key(|(index, _)| *index);
    Ok(results.into_iter().map(|(_, value)| value).collect())
}

async fn load_file_diff(
    repo_path: &Path,
    file: &ChangedFileSummary,
    diff_base: &str,
) -> ArgmaxResult<String> {
    let raw = if file.status == "??" {
        synthesize_untracked_diff(repo_path, &file.path).await?
    } else {
        // Pass both sides of a rename/copy so git renders one rename diff
        // instead of an orphaned add (the old path is gone from the base side).
        let mut args = vec!["diff".to_owned(), diff_base.to_owned(), "--".to_owned()];
        if let Some(old_path) = &file.old_path {
            args.push(old_path.clone());
        }
        args.push(file.path.clone());
        run_git_text(repo_path, args, GIT_TIMEOUT).await?
    };
    Ok(cap_diff(raw))
}

fn parse_porcelain_z(value: &str) -> Vec<ChangedFileSummary> {
    if value.is_empty() {
        return Vec::new();
    }

    let records: Vec<_> = value
        .split('\0')
        .filter(|entry| !entry.is_empty())
        .collect();
    let mut out = Vec::new();
    let mut index = 0;
    while index < records.len() {
        let record = records[index];
        if record.len() < 4 {
            index += 1;
            continue;
        }
        let code = &record[..2];
        let status = code.trim();
        let path = record[3..].to_owned();
        let mut old_path = None;
        if code.starts_with('R') || code.starts_with('C') {
            old_path = records.get(index + 1).map(|value| (*value).to_owned());
            index += 1;
        }
        out.push(ChangedFileSummary {
            path,
            status: if status.is_empty() {
                "?".to_owned()
            } else {
                status.to_owned()
            },
            additions: 0,
            deletions: 0,
            old_path,
        });
        index += 1;
    }
    out
}

/// Parse `git diff --name-status -z <base>` output. Records are NUL-separated:
/// a status token followed by one path (`M\0file`), or for renames/copies the
/// `R<score>`/`C<score>` token followed by two paths (`R100\0old\0new`). The
/// status is normalized to a single letter to match `parse_porcelain_z`.
fn parse_name_status_z(value: &str) -> Vec<ChangedFileSummary> {
    let records: Vec<_> = value.split('\0').filter(|entry| !entry.is_empty()).collect();
    let mut out = Vec::new();
    let mut index = 0;
    while index < records.len() {
        let status_token = records[index];
        index += 1;
        let code = status_token.chars().next().unwrap_or('?');
        if code == 'R' || code == 'C' {
            let old_path = records.get(index).map(|value| (*value).to_owned());
            let new_path = records.get(index + 1).map(|value| (*value).to_owned());
            index += 2;
            if let Some(new_path) = new_path {
                out.push(ChangedFileSummary {
                    path: new_path,
                    status: code.to_string(),
                    additions: 0,
                    deletions: 0,
                    old_path,
                });
            }
        } else if let Some(path) = records.get(index) {
            index += 1;
            out.push(ChangedFileSummary {
                path: (*path).to_owned(),
                status: status_token.trim().to_owned(),
                additions: 0,
                deletions: 0,
                old_path: None,
            });
        }
    }
    out
}

fn count_diff_lines(content: &str) -> (usize, usize) {
    let mut additions = 0;
    let mut deletions = 0;
    for line in content.lines() {
        if line.starts_with("+++") || line.starts_with("---") {
            continue;
        }
        if line.starts_with('+') {
            additions += 1;
        } else if line.starts_with('-') {
            deletions += 1;
        }
    }
    (additions, deletions)
}

async fn synthesize_untracked_diff(repo_path: &Path, file_path: &str) -> ArgmaxResult<String> {
    let absolute_path = validate_relative_review_path(repo_path, file_path)?;
    let metadata = tokio::fs::symlink_metadata(&absolute_path)
        .await
        .map_err(fs_error)?;

    if metadata.file_type().is_symlink() {
        let target = tokio::fs::read_link(&absolute_path)
            .await
            .map_err(fs_error)?;
        return Ok(synthesize_untracked_symlink_diff(
            file_path,
            &target.display().to_string(),
        ));
    }
    if metadata.is_dir() {
        return Ok(String::new());
    }
    if metadata.len() as usize > PER_FILE_DIFF_CAP_BYTES {
        return Ok(synthesize_skipped_untracked_diff(
            file_path,
            metadata.len(),
            "file exceeds diff preview cap",
        ));
    }

    let content = match tokio::fs::read_to_string(&absolute_path).await {
        Ok(content) => content,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::IsADirectory | std::io::ErrorKind::NotFound
            ) =>
        {
            return Ok(String::new());
        }
        Err(error) => return Err(fs_error(error)),
    };
    if content.contains('\0') {
        return Ok(synthesize_skipped_untracked_diff(
            file_path,
            metadata.len(),
            "binary file skipped",
        ));
    }

    Ok(synthesize_untracked_text_diff(file_path, &content))
}

fn synthesize_untracked_text_diff(file_path: &str, content: &str) -> String {
    let mut lines: Vec<_> = content.split('\n').collect();
    let has_trailing_newline = content.ends_with('\n');
    if has_trailing_newline {
        lines.pop();
    }
    let body = lines
        .iter()
        .map(|line| format!("+{line}"))
        .collect::<Vec<_>>()
        .join("\n");
    let no_newline_marker = if has_trailing_newline {
        ""
    } else {
        "\n\\ No newline at end of file"
    };
    [
        format!("diff --git a/{file_path} b/{file_path}"),
        "new file mode 100644".to_owned(),
        "index 0000000..0000000".to_owned(),
        "--- /dev/null".to_owned(),
        format!("+++ b/{file_path}"),
        format!("@@ -0,0 +1,{} @@", lines.len()),
        format!("{body}{no_newline_marker}"),
    ]
    .join("\n")
}

fn synthesize_skipped_untracked_diff(file_path: &str, size_bytes: u64, reason: &str) -> String {
    [
        format!("diff --git a/{file_path} b/{file_path}"),
        "new file mode 100644".to_owned(),
        "index 0000000..0000000".to_owned(),
        "--- /dev/null".to_owned(),
        format!("+++ b/{file_path}"),
        "@@ -0,0 +1 @@".to_owned(),
        format!("+[untracked file not loaded: {reason}; size {size_bytes} bytes]"),
        "\\ No newline at end of file".to_owned(),
    ]
    .join("\n")
}

fn synthesize_untracked_symlink_diff(file_path: &str, target: &str) -> String {
    [
        format!("diff --git a/{file_path} b/{file_path}"),
        "new file mode 120000".to_owned(),
        "index 0000000..0000000".to_owned(),
        "--- /dev/null".to_owned(),
        format!("+++ b/{file_path}"),
        "@@ -0,0 +1 @@".to_owned(),
        format!("+{target}"),
        "\\ No newline at end of file".to_owned(),
    ]
    .join("\n")
}

fn cap_diff(content: String) -> String {
    if content.len() <= PER_FILE_DIFF_CAP_BYTES {
        return content;
    }
    // Walk back to a UTF-8 char boundary: a raw byte slice at the cap can land
    // in the middle of a multi-byte codepoint (emoji, CJK) and panic.
    let mut cap = PER_FILE_DIFF_CAP_BYTES;
    while cap > 0 && !content.is_char_boundary(cap) {
        cap -= 1;
    }
    let dropped_bytes = content.len() - cap;
    format!(
        "{}\n[diff truncated at {} bytes; dropped {} bytes]\n",
        &content[..cap],
        cap,
        dropped_bytes
    )
}

fn validate_repo_path(repo_path: &Path) -> ArgmaxResult<PathBuf> {
    resolve_inside(repo_path, Path::new(".")).map_err(path_error)
}

fn validate_relative_review_path(repo_path: &Path, file_path: &str) -> ArgmaxResult<PathBuf> {
    let candidate = Path::new(file_path);
    let parent = candidate
        .parent()
        .filter(|path| !path.as_os_str().is_empty());
    let parent = parent.unwrap_or_else(|| Path::new("."));
    let parent = resolve_inside(repo_path, parent).map_err(path_error)?;
    let file_name = candidate
        .file_name()
        .ok_or_else(|| ArgmaxError::service("REVIEW_PATH_INVALID", "file path has no file name"))?;
    Ok(parent.join(file_name))
}

fn path_error(error: PathError) -> ArgmaxError {
    ArgmaxError::service("WORKSPACE_PATH_INVALID", error.to_string())
}

fn fs_error(error: std::io::Error) -> ArgmaxError {
    ArgmaxError::service("WORKSPACE_FILE_IO", error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_status_parses_modify_add_delete() {
        // `M\0a\0A\0b\0D\0c` — three single-path records.
        let parsed = parse_name_status_z("M\0src/a.rs\0A\0src/b.rs\0D\0src/c.rs\0");
        assert_eq!(parsed.len(), 3);
        assert_eq!((parsed[0].status.as_str(), parsed[0].path.as_str()), ("M", "src/a.rs"));
        assert_eq!((parsed[1].status.as_str(), parsed[1].path.as_str()), ("A", "src/b.rs"));
        assert_eq!((parsed[2].status.as_str(), parsed[2].path.as_str()), ("D", "src/c.rs"));
        assert!(parsed.iter().all(|file| file.old_path.is_none()));
    }

    #[test]
    fn name_status_parses_rename_with_old_and_new_paths() {
        // `R100\0old\0new` — score token plus two paths; status normalizes to `R`.
        let parsed = parse_name_status_z("R100\0src/old.rs\0src/new.rs\0M\0README.md\0");
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].status, "R");
        assert_eq!(parsed[0].path, "src/new.rs");
        assert_eq!(parsed[0].old_path.as_deref(), Some("src/old.rs"));
        assert_eq!((parsed[1].status.as_str(), parsed[1].path.as_str()), ("M", "README.md"));
    }

    #[test]
    fn name_status_empty_input_is_empty() {
        assert!(parse_name_status_z("").is_empty());
    }
}
