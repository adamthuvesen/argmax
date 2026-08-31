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
    persistence::workspaces::{find_workspace_by_id, WorkspaceSummary},
    util::workspace_paths::{resolve_inside, PathError},
    workspaces::WorkspaceTargetKind,
};

pub const DIFF_FANOUT_LIMIT: usize = 8;
pub const PER_FILE_DIFF_CAP_BYTES: usize = 1_048_576;
const GIT_TIMEOUT: Duration = Duration::from_secs(30);

/// Which baseline the review diff is computed against.
///
/// `WorkingTree` is the historical behavior: working tree vs `HEAD` (whatever is
/// uncommitted). `Branch` shows the whole delta from the base branch — committed
/// *and* uncommitted *and* untracked — computed from `merge-base(base_ref, HEAD)`
/// to the working tree, i.e. "everything different from main". `Committed` is
/// `Branch` minus the working tree: merge-base to `HEAD`, so it answers "what
/// has actually landed as commits on this branch".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ReviewComparison {
    #[default]
    WorkingTree,
    Branch,
    Committed,
}

/// Diff endpoints for one review request, with the base branch already resolved
/// by the caller. `Branch`/`Committed` carry the ref to take the merge-base
/// against.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReviewBaseline<'a> {
    WorkingTree,
    Branch(&'a str),
    Committed(&'a str),
}

/// The diff baseline resolved for a single request. `diff_base` is the revision
/// argument the per-file `git diff` runs against: `HEAD` for working-tree mode,
/// the merge-base sha for branch mode, and a `<merge-base>..HEAD` range for
/// committed mode. `branch_mode` selects how the file list is gathered.
struct ResolvedComparison {
    diff_base: String,
    branch_mode: bool,
    /// Committed mode excludes the working tree, so untracked files never
    /// belong in the list and a dirty file must not be read as an untracked add.
    committed_only: bool,
}

async fn resolve_comparison(
    repo_path: &Path,
    baseline: ReviewBaseline<'_>,
) -> ArgmaxResult<ResolvedComparison> {
    match baseline {
        ReviewBaseline::WorkingTree => Ok(ResolvedComparison {
            diff_base: "HEAD".to_owned(),
            branch_mode: false,
            committed_only: false,
        }),
        ReviewBaseline::Branch(base_ref) => Ok(ResolvedComparison {
            diff_base: compute_merge_base(repo_path, base_ref).await?,
            branch_mode: true,
            committed_only: false,
        }),
        ReviewBaseline::Committed(base_ref) => {
            let merge_base = compute_merge_base(repo_path, base_ref).await?;
            Ok(ResolvedComparison {
                // `git diff A..HEAD` is `git diff A HEAD`, so every existing
                // `["diff", diff_base, ...]` call site keeps working unchanged.
                diff_base: format!("{merge_base}..HEAD"),
                branch_mode: true,
                committed_only: true,
            })
        }
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
    kind: WorkspaceTargetKind,
    id: &str,
    comparison: ReviewComparison,
) -> ArgmaxResult<Vec<ChangedFileSummary>> {
    if kind == WorkspaceTargetKind::Project {
        return list_changed_files_for_project(database, id, comparison).await;
    }
    let workspace_id = id;
    let (workspace, default_branch) = load_workspace_with_default_branch(database, workspace_id)?;
    let base_ref = pick_review_base(
        Path::new(&workspace.path),
        comparison,
        &workspace.base_ref,
        default_branch.as_deref(),
    )
    .await;
    list_changed_files_at_path(
        &workspace.path,
        baseline_for(comparison, base_ref.as_deref()),
    )
    .await
}

pub async fn load_diff(
    database: &Database,
    kind: WorkspaceTargetKind,
    id: &str,
    file_path: Option<&str>,
    comparison: ReviewComparison,
    context_lines: Option<u32>,
) -> ArgmaxResult<WorkspaceDiff> {
    if kind == WorkspaceTargetKind::Project {
        return load_diff_for_project(database, id, file_path, comparison, context_lines).await;
    }
    let workspace_id = id;
    let (workspace, default_branch) = load_workspace_with_default_branch(database, workspace_id)?;
    let base_ref = pick_review_base(
        Path::new(&workspace.path),
        comparison,
        &workspace.base_ref,
        default_branch.as_deref(),
    )
    .await;
    load_diff_at_path(
        workspace.path,
        workspace_id.to_owned(),
        file_path,
        baseline_for(comparison, base_ref.as_deref()),
        context_lines,
    )
    .await
}

async fn list_changed_files_for_project(
    database: &Database,
    project_id: &str,
    comparison: ReviewComparison,
) -> ArgmaxResult<Vec<ChangedFileSummary>> {
    let project = {
        let connection = database.connection();
        require_project(&connection, project_id)?
    };
    let primary = project_base_ref(&project.default_branch, &project.current_branch);
    let project_base = pick_review_base(
        Path::new(&project.repo_path),
        comparison,
        primary,
        project.default_branch.as_deref(),
    )
    .await;
    list_changed_files_at_path(
        project.repo_path,
        baseline_for(comparison, project_base.as_deref()),
    )
    .await
}

async fn load_diff_for_project(
    database: &Database,
    project_id: &str,
    file_path: Option<&str>,
    comparison: ReviewComparison,
    context_lines: Option<u32>,
) -> ArgmaxResult<WorkspaceDiff> {
    let project = {
        let connection = database.connection();
        require_project(&connection, project_id)?
    };
    let primary = project_base_ref(&project.default_branch, &project.current_branch);
    let project_base = pick_review_base(
        Path::new(&project.repo_path),
        comparison,
        primary,
        project.default_branch.as_deref(),
    )
    .await;
    // The WorkspaceDiff response shape still uses `workspaceId` as the key —
    // we reuse it for the project's repoPath-rooted view; renderer never
    // round-trips this id back, so keeping the type unchanged is safer than
    // forking the shape.
    load_diff_at_path(
        project.repo_path,
        project_id.to_owned(),
        file_path,
        baseline_for(comparison, project_base.as_deref()),
        context_lines,
    )
    .await
}

/// Pair the requested comparison with the base ref that survived resolution.
/// `base_ref: None` means no usable base branch, so every mode downgrades to
/// the working tree rather than failing on a ref that no longer exists.
fn baseline_for(comparison: ReviewComparison, base_ref: Option<&str>) -> ReviewBaseline<'_> {
    match (comparison, base_ref) {
        (ReviewComparison::WorkingTree, _) | (_, None) => ReviewBaseline::WorkingTree,
        (ReviewComparison::Branch, Some(base_ref)) => ReviewBaseline::Branch(base_ref),
        (ReviewComparison::Committed, Some(base_ref)) => ReviewBaseline::Committed(base_ref),
    }
}

/// A project's review baseline is its default branch, falling back to the
/// currently checked-out branch when no default is recorded.
fn project_base_ref<'a>(default_branch: &'a Option<String>, current_branch: &'a str) -> &'a str {
    default_branch.as_deref().unwrap_or(current_branch)
}

/// Load a workspace plus its project's recorded default branch (if any). The
/// default branch is the fallback base when the workspace's own base_ref no
/// longer resolves.
fn load_workspace_with_default_branch(
    database: &Database,
    workspace_id: &str,
) -> ArgmaxResult<(WorkspaceSummary, Option<String>)> {
    let connection = database.connection();
    let workspace = find_workspace_by_id(&connection, workspace_id)?;
    let default_branch = require_project(&connection, &workspace.project_id)
        .ok()
        .and_then(|project| project.default_branch);
    Ok((workspace, default_branch))
}

/// Choose a branch/committed comparison base that is not the current HEAD
/// commit. Shared-checkout sessions used to record `base_ref` as the current
/// branch, which made merge-base(HEAD, HEAD) empty. Prefer the recorded base,
/// then the project default, then `main` / `master`. For those integration
/// names, prefer `origin/<name>` when it exists, so a stale local `main`
/// does not pull already-rebased upstream commits into the review. Skip any
/// candidate that is HEAD or that has no merge-base with HEAD. If nothing
/// else exists, return the first existing related ref so a pruned base does
/// not fail the request with "not a valid object name".
async fn pick_review_base(
    repo_path: &Path,
    comparison: ReviewComparison,
    primary: &str,
    fallback: Option<&str>,
) -> Option<String> {
    if comparison == ReviewComparison::WorkingTree {
        return None;
    }
    let mut names: Vec<&str> = Vec::new();
    for name in [Some(primary), fallback, Some("main"), Some("master")]
        .into_iter()
        .flatten()
    {
        if !names.contains(&name) {
            names.push(name);
        }
    }
    let mut candidates: Vec<String> = Vec::new();
    for name in names {
        if is_integration_branch(name, fallback) {
            candidates.push(format!("origin/{name}"));
        }
        candidates.push(name.to_owned());
    }
    let mut seen: Vec<String> = Vec::new();
    let mut first_existing: Option<String> = None;
    // Every file click in the Changes panel runs this loop, so resolve HEAD
    // once and let one `rev-parse` per candidate answer both "does it exist"
    // and "is it HEAD" — the two probes issued the identical command.
    let head = rev_parse_commit(repo_path, "HEAD").await.ok();
    for candidate in candidates {
        if seen.contains(&candidate) {
            continue;
        }
        seen.push(candidate.clone());
        let Ok(resolved) = rev_parse_commit(repo_path, &candidate).await else {
            continue;
        };
        if !has_common_ancestor(repo_path, &candidate).await {
            continue;
        }
        if first_existing.is_none() {
            first_existing = Some(candidate.clone());
        }
        if head.as_deref() != Some(resolved.as_str()) {
            return Some(candidate);
        }
    }
    first_existing
}

fn is_integration_branch(name: &str, fallback: Option<&str>) -> bool {
    matches!(name, "main" | "master") || fallback == Some(name)
}

async fn has_common_ancestor(repo_path: &Path, reference: &str) -> bool {
    if reject_leading_dash("base ref", reference).is_err() {
        return false;
    }
    run_git_text_with_allowed_exit_codes(
        repo_path,
        ["merge-base", reference, "HEAD"],
        &[1],
        GIT_TIMEOUT,
    )
    .await
    .map(|exit| !exit.stdout.trim().is_empty())
    .unwrap_or(false)
}

async fn rev_parse_commit(repo_path: &Path, spec: &str) -> ArgmaxResult<String> {
    let rev = format!("{spec}^{{commit}}");
    let exit = run_git_text_with_allowed_exit_codes(
        repo_path,
        ["rev-parse", "--verify", "--quiet", rev.as_str()],
        &[1],
        GIT_TIMEOUT,
    )
    .await?;
    let sha = exit.stdout.trim();
    if sha.is_empty() {
        return Err(ArgmaxError::service(
            "REVIEW_REV_PARSE",
            format!("'{spec}' is not a commit"),
        ));
    }
    Ok(sha.to_owned())
}

pub async fn list_changed_files_at_path(
    repo_path: impl AsRef<Path>,
    baseline: ReviewBaseline<'_>,
) -> ArgmaxResult<Vec<ChangedFileSummary>> {
    let repo_path = validate_repo_path(repo_path.as_ref())?;
    let comparison = resolve_comparison(&repo_path, baseline).await?;
    let files = collect_changed_files(&repo_path, &comparison).await?;
    load_file_summaries(repo_path, files, comparison.diff_base).await
}

pub async fn load_diff_at_path(
    repo_path: impl AsRef<Path>,
    diff_workspace_id: impl Into<String>,
    file_path: Option<&str>,
    baseline: ReviewBaseline<'_>,
    context_lines: Option<u32>,
) -> ArgmaxResult<WorkspaceDiff> {
    let repo_path = validate_repo_path(repo_path.as_ref())?;
    let comparison = resolve_comparison(&repo_path, baseline).await?;
    let diff_workspace_id = diff_workspace_id.into();
    let content = match file_path {
        Some(path) => {
            validate_relative_review_path(&repo_path, path)?;
            // The working-tree status still tells us whether the file is
            // untracked (so we synthesize) versus a regular diff target; in
            // branch mode a committed-but-clean file simply won't appear here
            // and falls through to a plain `git diff <base> -- path`. Committed
            // mode skips the probe entirely: a file that is committed AND dirty
            // would come back `??`/`M` from the working tree and get diffed
            // against the wrong side.
            let file = if comparison.committed_only {
                None
            } else {
                let porcelain = run_git_text(
                    &repo_path,
                    ["status", "--porcelain=v1", "-z", "--", path],
                    GIT_TIMEOUT,
                )
                .await?;
                parse_porcelain_z(&porcelain)
                    .into_iter()
                    .find(|item| item.path == path)
            };
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
                Some(file) => {
                    load_file_diff(&repo_path, &file, &comparison.diff_base, context_lines).await?
                }
                None => {
                    let mut args = vec!["diff".to_owned()];
                    if let Some(context) = context_lines {
                        args.push(format!("-U{context}"));
                    }
                    args.push(comparison.diff_base.clone());
                    args.push("--".to_owned());
                    args.push(path.to_owned());
                    // Capped like every other diff branch. Uncapped, a large
                    // file at full context would hand the renderer megabytes.
                    cap_diff(run_git_text(&repo_path, args, GIT_TIMEOUT).await?)
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

    // Untracked files are working-tree state, so they belong to every mode that
    // includes the working tree, and to none that doesn't.
    if !comparison.committed_only {
        let seen: HashSet<String> = files.iter().map(|file| file.path.clone()).collect();
        let porcelain =
            run_git_text(repo_path, ["status", "--porcelain=v1", "-z"], GIT_TIMEOUT).await?;
        for file in parse_porcelain_z(&porcelain) {
            if file.status == "??" && !file.path.ends_with('/') && !seen.contains(&file.path) {
                files.push(file);
            }
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
            // Only the +/- lines are counted, so extra context would be pure
            // cost.
            let diff = load_file_diff(&repo_path, &file, &diff_base, None).await?;
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
            // The whole-workspace diff keeps git's default context: it fans out
            // over every changed file, and the renderer only ever expands one.
            Ok::<_, ArgmaxError>((
                index,
                load_file_diff(&repo_path, &file, &diff_base, None).await?,
            ))
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
    context_lines: Option<u32>,
) -> ArgmaxResult<String> {
    let raw = if file.status == "??" {
        // An untracked file is entirely new, so git emits one hunk covering
        // every line no matter the context setting.
        synthesize_untracked_diff(repo_path, &file.path).await?
    } else {
        let mut args = vec!["diff".to_owned()];
        if let Some(context) = context_lines {
            args.push(format!("-U{context}"));
        }
        args.push(diff_base.to_owned());
        args.push("--".to_owned());
        // Pass both sides of a rename/copy so git renders one rename diff
        // instead of an orphaned add (the old path is gone from the base side).
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
    let records: Vec<_> = value
        .split('\0')
        .filter(|entry| !entry.is_empty())
        .collect();
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
        assert_eq!(
            (parsed[0].status.as_str(), parsed[0].path.as_str()),
            ("M", "src/a.rs")
        );
        assert_eq!(
            (parsed[1].status.as_str(), parsed[1].path.as_str()),
            ("A", "src/b.rs")
        );
        assert_eq!(
            (parsed[2].status.as_str(), parsed[2].path.as_str()),
            ("D", "src/c.rs")
        );
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
        assert_eq!(
            (parsed[1].status.as_str(), parsed[1].path.as_str()),
            ("M", "README.md")
        );
    }

    #[test]
    fn name_status_empty_input_is_empty() {
        assert!(parse_name_status_z("").is_empty());
    }
}
