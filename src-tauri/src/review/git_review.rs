use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use futures_util::future::join_all;
use serde::{Deserialize, Serialize};
use specta::Type;
use tokio::{sync::Semaphore, task::JoinSet};

use crate::{
    error::{ArgmaxError, ArgmaxResult},
    git::{
        exec::{reject_leading_dash, run_git_text, run_git_text_with_allowed_exit_codes},
        ops::checkout_write_lock,
        tree_snapshot::{fingerprint_worktree, index_tree},
    },
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
    /// True when the index differs from HEAD for this path. A file can be
    /// both staged and unstaged, in which case unstage is still the safe first
    /// review action because it never overwrites the worktree.
    pub staged: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDiff {
    pub workspace_id: String,
    pub file_path: Option<String>,
    pub content: String,
    /// Stable server-generated identity for the exact, uncapped diff shown to
    /// the reviewer. Mutations must present this value so a stale screen
    /// cannot operate on a later edit in a shared checkout.
    pub revision: String,
}

pub async fn list_changed_files(
    database: &Database,
    kind: WorkspaceTargetKind,
    id: &str,
    comparison: ReviewComparison,
) -> ArgmaxResult<Vec<ChangedFileSummary>> {
    let (repo_path, base_ref) = resolve_review_target(database, kind, id, comparison).await?;
    list_changed_files_at_path(repo_path, baseline_for(comparison, base_ref.as_deref())).await
}

pub async fn load_diff(
    database: &Database,
    kind: WorkspaceTargetKind,
    id: &str,
    file_path: Option<&str>,
    comparison: ReviewComparison,
    context_lines: Option<u32>,
) -> ArgmaxResult<WorkspaceDiff> {
    let (repo_path, base_ref) = resolve_review_target(database, kind, id, comparison).await?;
    // The WorkspaceDiff response shape keys on `workspaceId`; a project review
    // reuses it for the repoPath-rooted view, and the renderer never round-trips
    // the id back.
    load_diff_at_path(
        repo_path,
        id.to_owned(),
        file_path,
        baseline_for(comparison, base_ref.as_deref()),
        context_lines,
    )
    .await
}

/// The checkout a review reads and the base ref it compares against: a
/// workspace's own path and recorded base, or a project's repo root and its
/// default branch.
async fn resolve_review_target(
    database: &Database,
    kind: WorkspaceTargetKind,
    id: &str,
    comparison: ReviewComparison,
) -> ArgmaxResult<(String, Option<String>)> {
    match kind {
        WorkspaceTargetKind::Project => {
            let project = {
                // A read-only lookup; nothing upstream just wrote this row,
                // so the reader pool is safe and avoids the writer mutex.
                let connection = database.read_connection();
                require_project(&connection, id)?
            };
            let primary = project
                .default_branch
                .as_deref()
                .unwrap_or(&project.current_branch);
            let base_ref = pick_review_base(
                Path::new(&project.repo_path),
                comparison,
                primary,
                project.default_branch.as_deref(),
            )
            .await;
            Ok((project.repo_path, base_ref))
        }
        WorkspaceTargetKind::Workspace => {
            let (workspace, default_branch) = load_workspace_with_default_branch(database, id)?;
            let base_ref = pick_review_base(
                Path::new(&workspace.path),
                comparison,
                &workspace.base_ref,
                default_branch.as_deref(),
            )
            .await;
            Ok((workspace.path, base_ref))
        }
    }
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

/// Load a workspace plus its project's recorded default branch (if any). The
/// default branch is the fallback base when the workspace's own base_ref no
/// longer resolves.
fn load_workspace_with_default_branch(
    database: &Database,
    workspace_id: &str,
) -> ArgmaxResult<(WorkspaceSummary, Option<String>)> {
    // Read-only lookup; the reader pool avoids taking the single writer mutex
    // for a plain SELECT.
    let connection = database.read_connection();
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
    candidates.retain(|candidate| {
        let fresh = !seen.contains(candidate);
        seen.push(candidate.clone());
        fresh
    });

    // Every file click in the Changes panel runs this, so resolve HEAD once and
    // let one `rev-parse` per candidate answer both "does it exist" and "is it
    // HEAD" — the two probes issued the identical command. The probes are
    // independent of each other, so they run together and the answer is picked
    // from the results in candidate order.
    let head = rev_parse_commit(repo_path, "HEAD");
    let probes = join_all(candidates.iter().map(|candidate| async move {
        let resolved = rev_parse_commit(repo_path, candidate).await.ok();
        match resolved {
            Some(resolved) if has_common_ancestor(repo_path, candidate).await => Some(resolved),
            _ => None,
        }
    }));
    let (head, probes) = tokio::join!(head, probes);
    let head = head.ok();

    let mut first_existing: Option<String> = None;
    for (candidate, resolved) in candidates.into_iter().zip(probes) {
        let Some(resolved) = resolved else { continue };
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

/// The change entry for one path, which decides how its diff is produced: the
/// working-tree status, because that is what says "untracked" and calls for a
/// synthesized diff, or — for a file already committed on the branch and clean
/// on disk — the branch-vs-base entry, which carries `old_path` so a committed
/// rename renders as one rename rather than an orphaned add. `None` leaves the
/// caller with a plain `git diff <base> -- path`.
async fn resolve_diff_file(
    repo_path: &Path,
    comparison: &ResolvedComparison,
    path: &str,
) -> ArgmaxResult<Option<ChangedFileSummary>> {
    // Committed mode never consults the working tree: a file that is committed
    // AND dirty would come back `??`/`M` and get diffed against the wrong side.
    if comparison.committed_only {
        return branch_file_entry(repo_path, comparison, path).await;
    }
    let status = working_tree_file_entry(repo_path, path);
    if !comparison.branch_mode {
        return status.await;
    }
    // Most files on a branch under review are committed and clean, so the
    // branch list is wanted more often than not. Asking for both at once spends
    // one git process on a dirty file and saves a round trip on every other.
    let (status, branch) = tokio::join!(status, branch_file_entry(repo_path, comparison, path));
    Ok(status?.or(branch?))
}

async fn working_tree_file_entry(
    repo_path: &Path,
    path: &str,
) -> ArgmaxResult<Option<ChangedFileSummary>> {
    let porcelain = run_git_text(
        repo_path,
        ["status", "--porcelain=v1", "-z", "--", path],
        GIT_TIMEOUT,
    )
    .await?;
    Ok(parse_porcelain_z(&porcelain)
        .into_iter()
        .find(|item| item.path == path))
}

/// One path's entry in the branch-vs-base list. Untracked files are absent by
/// construction — `git diff` cannot see them — and need not be recovered here:
/// an untracked file is in the working-tree status, which is consulted first.
async fn branch_file_entry(
    repo_path: &Path,
    comparison: &ResolvedComparison,
    path: &str,
) -> ArgmaxResult<Option<ChangedFileSummary>> {
    let name_status = run_git_text(
        repo_path,
        ["diff", "--name-status", "-z", comparison.diff_base.as_str()],
        GIT_TIMEOUT,
    )
    .await?;
    Ok(parse_name_status_z(&name_status)
        .into_iter()
        .find(|item| item.path == path))
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
    // Only the working-tree comparison offers staging and reverting, and the
    // revision exists to guard those. Fingerprinting HEAD, the index and the
    // whole worktree costs more than the diff itself, so a branch or committed
    // diff — which describes history nobody can act on from here — skips it
    // and is identified by its own payload below instead.
    let actionable = !comparison.branch_mode;
    let revision_before = match actionable {
        true => Some(review_revision_at_path(&repo_path).await?),
        false => None,
    };
    let diff_workspace_id = diff_workspace_id.into();
    let content = match file_path {
        Some(path) => {
            validate_relative_review_path(&repo_path, path)?;
            match resolve_diff_file(&repo_path, &comparison, path).await? {
                Some(file) => {
                    load_file_diff(&repo_path, &file, &comparison.diff_base, context_lines).await?
                }
                None => {
                    let mut args = vec!["diff".to_owned()];
                    args.push(format!("-U{}", context_lines.unwrap_or(3)));
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

    let revision = match revision_before {
        Some(before) => {
            let revision = review_revision_at_path(&repo_path).await?;
            if revision != before {
                return Err(ArgmaxError::service(
                    "REVIEW_STALE_REVISION",
                    "The checkout changed while loading this diff. Refresh before acting on it.",
                ));
            }
            revision
        }
        // A token for a payload no action accepts: `ensure_current_review_revision`
        // compares against the worktree fingerprint, so this can never unlock one.
        None => review_diff_revision(&content),
    };
    Ok(WorkspaceDiff {
        workspace_id: diff_workspace_id,
        file_path: file_path.map(ToOwned::to_owned),
        content,
        revision,
    })
}

/// A deterministic, dependency-free FNV-1a fingerprint. This is an optimistic
/// concurrency token, not a security primitive: it identifies the generated
/// review payload and is always checked while the checkout write lock is held.
pub fn review_diff_revision(content: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in content.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("r{hash:016x}")
}

async fn review_revision_at_path(repo_path: &Path) -> ArgmaxResult<String> {
    // Three independent reads of the same checkout: overlapping them costs the
    // slowest one rather than their sum, and a file click pays this twice.
    let (head, index, worktree) = tokio::try_join!(
        run_git_text(repo_path, ["rev-parse", "HEAD"], GIT_TIMEOUT),
        index_tree(repo_path),
        fingerprint_worktree(repo_path),
    )?;
    Ok(review_diff_revision(&format!(
        "{head}\0{index}\0{worktree}"
    )))
}

/// Apply a file-level index operation after confirming the review payload has
/// not changed. These operations are deliberately limited to the uncommitted
/// comparison: branch and committed diffs describe history, not mutable index
/// state.
pub async fn update_file_index(
    database: &Database,
    kind: WorkspaceTargetKind,
    id: &str,
    file_path: &str,
    revision: &str,
    stage: bool,
) -> ArgmaxResult<()> {
    let repo_path = review_target_path(database, kind, id)?;
    validate_relative_review_path(&repo_path, file_path)?;
    let lock = checkout_write_lock(&repo_path).await?;
    let _guard = lock.lock().await;
    ensure_current_review_revision(&repo_path, revision).await?;
    if stage {
        run_git_text(&repo_path, ["add", "--", file_path], GIT_TIMEOUT).await?;
    } else {
        let status =
            run_git_text(&repo_path, ["status", "--porcelain=v1", "-z"], GIT_TIMEOUT).await?;
        let files = parse_porcelain_z(&status);
        let old_path = files
            .iter()
            .find(|file| file.path == file_path)
            .and_then(|file| file.old_path.as_deref());
        let mut args = vec!["restore", "--staged", "--", file_path];
        if let Some(old_path) = old_path {
            validate_relative_review_path(&repo_path, old_path)?;
            args.push(old_path);
        }
        run_git_text(&repo_path, args, GIT_TIMEOUT).await?;
    }
    Ok(())
}

/// Reconstruct one selected hunk from the server's current diff, validate it
/// with git apply, then apply it to the real index. The caller can only name a
/// hunk number from a revision it received, never provide patch text.
#[allow(clippy::too_many_arguments)]
pub async fn update_hunk_index(
    database: &Database,
    kind: WorkspaceTargetKind,
    id: &str,
    file_path: &str,
    revision: &str,
    hunk_index: usize,
    context_lines: Option<u32>,
    stage: bool,
) -> ArgmaxResult<()> {
    let repo_path = review_target_path(database, kind, id)?;
    validate_relative_review_path(&repo_path, file_path)?;
    let lock = checkout_write_lock(&repo_path).await?;
    let _guard = lock.lock().await;
    ensure_current_review_revision(&repo_path, revision).await?;
    let status = run_git_text(
        &repo_path,
        ["status", "--porcelain=v1", "-z", "--", file_path],
        GIT_TIMEOUT,
    )
    .await?;
    if parse_porcelain_z(&status)
        .iter()
        .any(|file| file.staged && file.status.len() > 1)
    {
        return Err(ArgmaxError::service(
            "REVIEW_HUNK_UNSUPPORTED",
            "This file has both staged and unstaged changes. Use file actions to change its staging.",
        ));
    }
    let diff = current_working_tree_file_diff(&repo_path, file_path, context_lines).await?;
    let patch = extract_hunk_patch(&diff, hunk_index)?;
    apply_patch_to_index(&repo_path, &patch, !stage).await
}

fn review_target_path(
    database: &Database,
    kind: WorkspaceTargetKind,
    id: &str,
) -> ArgmaxResult<PathBuf> {
    let connection = database.connection();
    let path = match kind {
        WorkspaceTargetKind::Workspace => find_workspace_by_id(&connection, id)?.path,
        WorkspaceTargetKind::Project => require_project(&connection, id)?.repo_path,
    };
    validate_repo_path(Path::new(&path))
}

async fn ensure_current_review_revision(repo_path: &Path, revision: &str) -> ArgmaxResult<()> {
    if review_revision_at_path(repo_path).await? == revision {
        Ok(())
    } else {
        Err(stale_review_error())
    }
}

async fn current_working_tree_file_diff(
    repo_path: &Path,
    file_path: &str,
    context_lines: Option<u32>,
) -> ArgmaxResult<String> {
    let porcelain = run_git_text(
        repo_path,
        ["status", "--porcelain=v1", "-z", "--", file_path],
        GIT_TIMEOUT,
    )
    .await?;
    if parse_porcelain_z(&porcelain)
        .iter()
        .any(|file| file.status == "??")
    {
        return Err(ArgmaxError::service(
            "REVIEW_HUNK_UNSUPPORTED",
            "Use Stage file for untracked files. Hunk actions require a tracked text file.",
        ));
    }
    Ok(cap_diff(
        run_git_text(
            repo_path,
            [
                "diff",
                &format!("-U{}", context_lines.unwrap_or(3)),
                "HEAD",
                "--",
                file_path,
            ],
            GIT_TIMEOUT,
        )
        .await?,
    ))
}

/// Discard only the unstaged version of a tracked file. A recovery checkpoint
/// is captured by the IPC layer before this function is called. `git restore`
/// deliberately leaves the index alone, preserving unrelated or partially
/// staged work in the shared checkout.
pub async fn revert_unstaged_file(
    database: &Database,
    workspace_id: &str,
    file_path: &str,
    revision: &str,
) -> ArgmaxResult<()> {
    let workspace = {
        let connection = database.connection();
        find_workspace_by_id(&connection, workspace_id)?
    };
    let repo_path = validate_repo_path(Path::new(&workspace.path))?;
    validate_relative_review_path(&repo_path, file_path)?;
    let lock = checkout_write_lock(&repo_path).await?;
    let _guard = lock.lock().await;
    ensure_current_review_revision(&repo_path, revision).await?;
    let porcelain = run_git_text(
        &repo_path,
        ["status", "--porcelain=v1", "-z", "--", file_path],
        GIT_TIMEOUT,
    )
    .await?;
    if parse_porcelain_z(&porcelain)
        .iter()
        .any(|file| file.status == "??")
    {
        return Err(ArgmaxError::service(
            "REVIEW_REVERT_UNTRACKED_UNSUPPORTED",
            "Untracked files cannot be reverted from Review. Remove them from Files after saving a checkpoint.",
        ));
    }
    run_git_text(
        &repo_path,
        ["restore", "--worktree", "--", file_path],
        GIT_TIMEOUT,
    )
    .await?;
    Ok(())
}

pub async fn revert_unstaged_hunk(
    database: &Database,
    workspace_id: &str,
    file_path: &str,
    revision: &str,
    hunk_index: usize,
    context_lines: Option<u32>,
) -> ArgmaxResult<()> {
    let workspace = {
        let connection = database.connection();
        find_workspace_by_id(&connection, workspace_id)?
    };
    let repo_path = validate_repo_path(Path::new(&workspace.path))?;
    validate_relative_review_path(&repo_path, file_path)?;
    let lock = checkout_write_lock(&repo_path).await?;
    let _guard = lock.lock().await;
    ensure_current_review_revision(&repo_path, revision).await?;
    let displayed = current_working_tree_file_diff(&repo_path, file_path, context_lines).await?;
    let selected_patch = extract_hunk_patch(&displayed, hunk_index)?;
    let unstaged = run_git_text(
        &repo_path,
        [
            "diff",
            &format!("-U{}", context_lines.unwrap_or(3)),
            "--",
            file_path,
        ],
        GIT_TIMEOUT,
    )
    .await?;
    let patch = matching_hunk_patch(&unstaged, &selected_patch)?;
    apply_patch_to_worktree(&repo_path, &patch).await
}

fn matching_hunk_patch(unstaged_diff: &str, selected_patch: &str) -> ArgmaxResult<String> {
    let selected_hunk = selected_patch
        .split_once("@@ ")
        .and_then(|(_, body)| body.split_once('+').map(|(_, lines)| lines))
        .ok_or_else(|| {
            ArgmaxError::service(
                "REVIEW_HUNK_UNAVAILABLE",
                "This hunk is no longer available.",
            )
        })?;
    let mut index = 0;
    while let Ok(candidate) = extract_hunk_patch(unstaged_diff, index) {
        if candidate
            .split_once("@@ ")
            .and_then(|(_, body)| body.split_once('+').map(|(_, lines)| lines))
            == Some(selected_hunk)
        {
            return Ok(candidate);
        }
        index += 1;
    }
    Err(ArgmaxError::service(
        "REVIEW_HUNK_UNSTAGED_UNAVAILABLE",
        "This hunk is staged or changed. Refresh the diff before reverting it.",
    ))
}

fn stale_review_error() -> ArgmaxError {
    ArgmaxError::service(
        "REVIEW_STALE_REVISION",
        "This diff changed before the action ran. Refresh it and try again.",
    )
}

fn extract_hunk_patch(diff: &str, hunk_index: usize) -> ArgmaxResult<String> {
    let mut preamble = Vec::new();
    let mut hunks: Vec<Vec<&str>> = Vec::new();
    let mut active: Option<Vec<&str>> = None;
    for line in diff.lines() {
        if line.starts_with("@@ ") {
            if let Some(hunk) = active.take() {
                hunks.push(hunk);
            }
            active = Some(vec![line]);
        } else if let Some(hunk) = active.as_mut() {
            hunk.push(line);
        } else {
            preamble.push(line);
        }
    }
    if let Some(hunk) = active {
        hunks.push(hunk);
    }
    let hunk = hunks.get(hunk_index).ok_or_else(|| {
        ArgmaxError::service(
            "REVIEW_HUNK_UNAVAILABLE",
            "This hunk is no longer available.",
        )
    })?;
    if preamble
        .iter()
        .any(|line| line.starts_with("Binary files ") || line.starts_with("similarity index"))
    {
        return Err(ArgmaxError::service(
            "REVIEW_HUNK_UNSUPPORTED",
            "Hunk actions are unavailable for binary files and renames.",
        ));
    }
    let mut patch = preamble.join("\n");
    patch.push('\n');
    patch.push_str(&hunk.join("\n"));
    patch.push('\n');
    Ok(patch)
}

/// Validate a patch with `git apply --check`, then apply it for real. The two
/// invocations must see the same file, so the patch is written once.
async fn apply_patch(repo_path: &Path, patch: &str, extra_args: &[&str]) -> ArgmaxResult<()> {
    let patch_file = tempfile::NamedTempFile::new().map_err(|error| {
        ArgmaxError::service(
            "REVIEW_PATCH_TEMPFILE",
            format!("could not create patch file: {error}"),
        )
    })?;
    std::fs::write(patch_file.path(), patch).map_err(|error| {
        ArgmaxError::service(
            "REVIEW_PATCH_WRITE",
            format!("could not write patch: {error}"),
        )
    })?;
    let patch_path = patch_file.path().to_string_lossy().to_string();
    let mut args = vec!["apply"];
    args.extend_from_slice(extra_args);
    args.push("--");
    args.push(&patch_path);
    let mut checked = vec!["apply", "--check"];
    checked.extend_from_slice(&args[1..]);
    run_git_text(repo_path, &checked, GIT_TIMEOUT).await?;
    run_git_text(repo_path, &args, GIT_TIMEOUT).await?;
    Ok(())
}

async fn apply_patch_to_index(repo_path: &Path, patch: &str, reverse: bool) -> ArgmaxResult<()> {
    let extra: &[&str] = if reverse {
        &["--cached", "--reverse"]
    } else {
        &["--cached"]
    };
    apply_patch(repo_path, patch, extra).await
}

async fn apply_patch_to_worktree(repo_path: &Path, patch: &str) -> ArgmaxResult<()> {
    apply_patch(repo_path, patch, &["--reverse"]).await
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

/// Attach +/- counts to a changed-file list.
///
/// One `git diff --numstat` covers every tracked file: the renderer refetches
/// this list on each changed-file count change, so a per-file `git diff` would
/// mean one process per file per refresh. Untracked files are invisible to
/// `git diff` and still need the synthesized whole-file diff, so those alone
/// fan out.
async fn load_file_summaries(
    repo_path: PathBuf,
    files: Vec<ChangedFileSummary>,
    diff_base: String,
) -> ArgmaxResult<Vec<ChangedFileSummary>> {
    let tracked_counts = if files.iter().any(|file| file.status != "??") {
        let numstat = run_git_text(
            &repo_path,
            ["diff", "--numstat", "-z", diff_base.as_str()],
            GIT_TIMEOUT,
        )
        .await?;
        parse_numstat_z(&numstat)
    } else {
        HashMap::new()
    };

    let semaphore = Arc::new(Semaphore::new(DIFF_FANOUT_LIMIT));
    let diff_base = Arc::new(diff_base);
    let mut tasks = JoinSet::new();
    for (index, file) in files.into_iter().enumerate() {
        if file.status != "??" {
            // A path numstat never mentions has no diff against the base
            // (a mode-only change, say), which is genuinely 0/0.
            let (additions, deletions) = tracked_counts.get(&file.path).copied().unwrap_or((0, 0));
            let summary = ChangedFileSummary {
                additions,
                deletions,
                ..file
            };
            // Already resolved; goes through the JoinSet only so
            // `collect_ordered` can restore the caller's file order.
            tasks.spawn(async move { Ok::<_, ArgmaxError>((index, summary)) });
            continue;
        }
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

/// Parse `git diff --numstat -z <base>` into per-path `(additions, deletions)`.
///
/// Records are NUL-separated. A plain change is one record,
/// `<adds>\t<dels>\t<path>`; a rename/copy splits into three, the counts
/// record ending at its second tab followed by the old and new paths
/// (`<adds>\t<dels>\t\0<old>\0<new>`). Binary files report `-` for both
/// counts, which has no line meaning, so they map to 0/0.
fn parse_numstat_z(value: &str) -> HashMap<String, (usize, usize)> {
    let records: Vec<_> = value.split('\0').collect();
    let mut out = HashMap::new();
    let mut index = 0;
    while index < records.len() {
        let record = records[index];
        index += 1;
        if record.is_empty() {
            continue;
        }
        let mut parts = record.splitn(3, '\t');
        let (Some(additions), Some(deletions), Some(path)) =
            (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        // `-` marks a binary file; anything else unparseable is not a record
        // we understand, and guessing a count would be worse than zero.
        let additions = additions.parse::<usize>().unwrap_or(0);
        let deletions = deletions.parse::<usize>().unwrap_or(0);
        let path = if path.is_empty() {
            // Rename/copy: the old path is skipped, the new path is the key,
            // matching how `parse_name_status_z` names the entry.
            index += 1;
            match records.get(index) {
                Some(new_path) => {
                    index += 1;
                    (*new_path).to_owned()
                }
                None => continue,
            }
        } else {
            path.to_owned()
        };
        out.insert(path, (additions, deletions));
    }
    out
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
        args.push(format!("-U{}", context_lines.unwrap_or(3)));
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
            staged: code
                .as_bytes()
                .first()
                .copied()
                .is_some_and(|value| value != b' ' && value != b'?'),
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
                    staged: false,
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
                staged: false,
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
    untracked_diff(
        file_path,
        "100644",
        &format!("@@ -0,0 +1,{} @@", lines.len()),
        &format!("{body}{no_newline_marker}"),
    )
}

fn synthesize_skipped_untracked_diff(file_path: &str, size_bytes: u64, reason: &str) -> String {
    untracked_diff(
        file_path,
        "100644",
        "@@ -0,0 +1 @@",
        &format!("+[untracked file not loaded: {reason}; size {size_bytes} bytes]\n\\ No newline at end of file"),
    )
}

fn synthesize_untracked_symlink_diff(file_path: &str, target: &str) -> String {
    untracked_diff(
        file_path,
        "120000",
        "@@ -0,0 +1 @@",
        &format!("+{target}\n\\ No newline at end of file"),
    )
}

/// The `diff --git` envelope every synthesized untracked diff shares.
fn untracked_diff(file_path: &str, mode: &str, hunk_header: &str, body: &str) -> String {
    [
        format!("diff --git a/{file_path} b/{file_path}"),
        format!("new file mode {mode}"),
        "index 0000000..0000000".to_owned(),
        "--- /dev/null".to_owned(),
        format!("+++ b/{file_path}"),
        hunk_header.to_owned(),
        body.to_owned(),
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

    async fn test_git(repo: &Path, args: &[&str]) -> String {
        run_git_text(repo, args, GIT_TIMEOUT)
            .await
            .unwrap_or_else(|error| panic!("git {args:?} failed: {error}"))
    }

    async fn review_repo() -> tempfile::TempDir {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let repo = dir.path();
        test_git(repo, &["init", "--initial-branch=main"]).await;
        test_git(repo, &["config", "user.email", "test@example.com"]).await;
        test_git(repo, &["config", "user.name", "Test"]).await;
        std::fs::write(repo.join("staged.txt"), "staged baseline\n").expect("write");
        std::fs::write(repo.join("unstaged.txt"), "unstaged baseline\n").expect("write");
        test_git(repo, &["add", "staged.txt", "unstaged.txt"]).await;
        test_git(repo, &["commit", "-m", "baseline"]).await;
        dir
    }

    async fn real_index_path(repo: &Path) -> PathBuf {
        PathBuf::from(
            test_git(
                repo,
                &["rev-parse", "--path-format=absolute", "--git-path", "index"],
            )
            .await
            .trim(),
        )
    }

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
    fn numstat_parses_counts_renames_and_binaries() {
        // Real `git diff --numstat -z` bytes: plain records carry the path in
        // the third tab field; a rename empties it and appends old + new; a
        // binary file reports `-` for both counts.
        let parsed = parse_numstat_z(
            "3\t1\tsrc/a.rs\x00-\t-\tassets/logo.png\x005\t0\t\x00src/old.rs\x00src/new.rs\x00",
        );
        assert_eq!(parsed.get("src/a.rs"), Some(&(3, 1)));
        assert_eq!(parsed.get("assets/logo.png"), Some(&(0, 0)));
        assert_eq!(parsed.get("src/new.rs"), Some(&(5, 0)));
        assert!(!parsed.contains_key("src/old.rs"));
        assert_eq!(parsed.len(), 3);
    }

    // The counts must survive being gathered in one batch instead of one
    // `git diff` per file, untracked files included — those are invisible to
    // numstat and still need the synthesized whole-file diff.
    #[tokio::test]
    async fn load_diff_succeeds_while_the_real_index_lock_is_held() {
        let dir = review_repo().await;
        let repo = dir.path();
        std::fs::write(repo.join("staged.txt"), "staged change\n").expect("write");
        test_git(repo, &["add", "staged.txt"]).await;
        std::fs::write(repo.join("unstaged.txt"), "unstaged change\n").expect("write");
        let index_path = real_index_path(repo).await;
        let index_before = std::fs::read(&index_path).expect("read index");
        let index_lock = index_path.with_file_name("index.lock");
        std::fs::write(&index_lock, "external git owns this lock\n").expect("hold index lock");

        let diff = load_diff_at_path(
            repo,
            "workspace",
            Some("unstaged.txt"),
            ReviewBaseline::WorkingTree,
            None,
        )
        .await
        .expect("read-only diff must not need the real index lock");

        assert!(diff.content.contains("+unstaged change"));
        assert_eq!(
            std::fs::read(&index_path).expect("read index after diff"),
            index_before
        );
        assert_eq!(
            std::fs::read_to_string(&index_lock).expect("read held lock"),
            "external git owns this lock\n"
        );
    }

    #[tokio::test]
    async fn concurrent_diff_reads_share_a_revision_without_touching_the_index() {
        let dir = review_repo().await;
        let repo = dir.path();
        std::fs::write(repo.join("staged.txt"), "indexed-only-content\n").expect("write");
        test_git(repo, &["add", "staged.txt"]).await;
        std::fs::write(repo.join("unstaged.txt"), "worktree-only-content\n").expect("write");
        let index_path = real_index_path(repo).await;
        let index_before = std::fs::read(&index_path).expect("read index");

        let (staged, unstaged) = tokio::join!(
            load_diff_at_path(
                repo,
                "staged",
                Some("staged.txt"),
                ReviewBaseline::WorkingTree,
                None,
            ),
            load_diff_at_path(
                repo,
                "unstaged",
                Some("unstaged.txt"),
                ReviewBaseline::WorkingTree,
                None,
            )
        );
        let staged = staged.expect("staged diff");
        let unstaged = unstaged.expect("unstaged diff");

        assert_eq!(staged.revision, unstaged.revision);
        assert!(staged.content.contains("+indexed-only-content"));
        assert!(!staged.content.contains("worktree-only-content"));
        assert!(unstaged.content.contains("+worktree-only-content"));
        assert!(!unstaged.content.contains("indexed-only-content"));
        assert_eq!(
            std::fs::read(index_path).expect("read index after concurrent diffs"),
            index_before
        );
    }
}
