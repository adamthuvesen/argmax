mod support;

use std::time::Duration;

use argmax_lib::git::exec::{
    reject_leading_dash, run_git_buffer, run_git_buffer_with_options, run_git_text,
    run_git_text_with_allowed_exit_codes, run_git_text_with_options, GitExecOptions,
};
use support::git_repo::{run_git, seed_git_repo};

#[tokio::test]
async fn run_git_text_returns_stdout() {
    let repo = seed_git_repo(&[("file.txt", "needle\n")]);

    let stdout = run_git_text(
        repo.path(),
        ["status", "--porcelain=v1"],
        Duration::from_secs(5),
    )
    .await
    .expect("git status succeeds");

    assert_eq!(stdout, "");
}

#[tokio::test]
async fn run_git_buffer_preserves_raw_stdout() {
    let repo = seed_git_repo(&[("file.bin", "hello")]);

    let stdout = run_git_buffer(
        repo.path(),
        ["show", "HEAD:file.bin"],
        Duration::from_secs(5),
    )
    .await
    .expect("git show succeeds");

    assert_eq!(stdout, b"hello");
}

#[tokio::test]
async fn non_zero_exit_surfaces_stderr() {
    let repo = seed_git_repo(&[("file.txt", "needle\n")]);

    let err = run_git_text(repo.path(), ["not-a-command"], Duration::from_secs(5))
        .await
        .expect_err("unknown git command fails");
    let json = serde_json::to_value(&err).expect("serialize error");

    assert_eq!(json["code"], "SERVICE_ERROR");
    assert_eq!(json["sub_code"], "GIT_NON_ZERO_EXIT");
    assert!(json["message"]
        .as_str()
        .expect("message")
        .contains("not-a-command"));
}

#[tokio::test]
async fn allowed_exit_codes_return_stdout() {
    let repo = seed_git_repo(&[("file.txt", "needle\n")]);

    let result = run_git_text_with_allowed_exit_codes(
        repo.path(),
        ["grep", "-n", "missing"],
        &[1],
        Duration::from_secs(5),
    )
    .await
    .expect("allowed grep miss");

    assert_eq!(result.exit_code, 1);
    assert_eq!(result.stdout, "");
}

#[tokio::test]
async fn stdout_cap_is_enforced() {
    let repo = seed_git_repo(&[("file.txt", "needle\n")]);

    let err = run_git_buffer(
        repo.path(),
        ["show", "HEAD:file.txt"],
        Duration::from_secs(5),
    )
    .await
    .expect("baseline command succeeds");
    assert!(err.len() > 1);

    let err = run_git_buffer_with_options(
        repo.path(),
        ["show", "HEAD:file.txt"],
        GitExecOptions {
            timeout: Duration::from_secs(5),
            stdout_cap_bytes: 1,
            env: Vec::new(),
        },
    )
    .await
    .expect_err("stdout cap rejects output");
    let json = serde_json::to_value(&err).expect("serialize error");
    assert_eq!(json["sub_code"], "GIT_STDOUT_TOO_LARGE");
}

#[tokio::test]
async fn times_out_and_kills_slow_git_process() {
    let repo = seed_git_repo(&[("file.txt", "needle\n")]);

    let err = run_git_text(
        repo.path(),
        ["-c", "alias.slow=!sh -c 'sleep 2; echo nope'", "slow"],
        Duration::from_millis(50),
    )
    .await
    .expect_err("slow command times out");
    let json = serde_json::to_value(&err).expect("serialize error");

    assert_eq!(json["sub_code"], "GIT_TIMEOUT");
}

#[tokio::test]
async fn pathspecs_after_separator_allow_leading_dash_file_names() {
    let repo = seed_git_repo(&[("-looks-like-flag", "needle\n")]);

    let stdout = run_git_text(
        repo.path(),
        ["diff", "HEAD", "--", "-looks-like-flag"],
        Duration::from_secs(5),
    )
    .await
    .expect("dash-prefixed pathspec is data after --");

    assert_eq!(stdout, "");
}

#[test]
fn explicit_user_arg_guard_rejects_leading_dash() {
    let err = reject_leading_dash("baseRef", "-main").expect_err("rejects leading dash");
    let json = serde_json::to_value(&err).expect("serialize error");

    assert_eq!(json["sub_code"], "GIT_ARG_LEADING_DASH");
    assert!(json["message"]
        .as_str()
        .expect("message")
        .contains("baseRef"));
}

/// Argmax launched from Finder inherits launchd's stripped PATH, so a git hook
/// could not find the tools it calls. A `post-checkout` hook's exit status is
/// the command's, so `git worktree add` exited 127 and the new worktree was
/// discarded. Hooks must see the fallback entries.
#[cfg(unix)]
#[tokio::test]
async fn hooks_run_with_the_hydrated_path() {
    use std::os::unix::fs::PermissionsExt;

    let repo = seed_git_repo(&[("file.txt", "seed\n")]);
    let recorded = repo.path().join("hook-path.txt");
    let hook = repo.path().join(".git/hooks/post-commit");
    std::fs::write(
        &hook,
        format!(
            "#!/bin/sh\nprintf '%s' \"$PATH\" > {}\n",
            recorded.display()
        ),
    )
    .expect("write post-commit hook");
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755))
        .expect("make hook executable");

    std::fs::write(repo.path().join("file.txt"), "changed\n").expect("dirty the file");
    run_git_text(repo.path(), ["add", "-A"], Duration::from_secs(5))
        .await
        .expect("stage the change");
    run_git_text(
        repo.path(),
        ["commit", "-m", "trigger the hook"],
        Duration::from_secs(10),
    )
    .await
    .expect("commit succeeds");

    // Match the whole hydrated value, not just a Homebrew entry: a developer's
    // inherited PATH already has Homebrew in it, so only the full string proves
    // the child got its PATH from us. Containment rather than equality because
    // git prepends its own exec-path before handing PATH to a hook.
    let hook_path = std::fs::read_to_string(&recorded).expect("hook recorded its PATH");
    let hydrated = argmax_lib::util::login_shell::path();
    assert!(
        hook_path.contains(&hydrated),
        "hook PATH did not come from the login shell\n  hook: {hook_path}\n  want: {hydrated}"
    );
    // The entry whose absence broke `git worktree add`: `lefthook` and friends
    // live here. Meaningful even under a stripped launchd environment, which is
    // the case this whole injection exists for.
    assert!(
        hook_path.split(':').any(|entry| entry == "/opt/homebrew/bin"),
        "hook PATH is missing the Homebrew fallback: {hook_path}"
    );
}

/// The injected PATH goes on before `GitExecOptions.env`, so a caller can still
/// replace it. Proven through `git <name>`, which resolves `git-<name>` on PATH.
#[cfg(unix)]
#[tokio::test]
async fn per_call_env_overrides_the_injected_path() {
    use std::os::unix::fs::PermissionsExt;

    let repo = seed_git_repo(&[("file.txt", "seed\n")]);
    let bin_dir = tempfile::tempdir().expect("create probe bin dir");
    let probe = bin_dir.path().join("git-argmaxprobe");
    std::fs::write(&probe, "#!/bin/sh\nprintf 'probe ran'\n").expect("write probe");
    std::fs::set_permissions(&probe, std::fs::Permissions::from_mode(0o755))
        .expect("make probe executable");

    // Keep the real PATH behind the probe dir: git itself is resolved through
    // this same value, so a probe-only PATH would fail to spawn git at all.
    let path = format!(
        "{}:{}",
        bin_dir.path().display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let stdout = run_git_text_with_options(
        repo.path(),
        ["argmaxprobe"],
        GitExecOptions {
            timeout: Duration::from_secs(5),
            ..GitExecOptions::default()
        }
        .with_env("PATH", path),
    )
    .await
    .expect("git resolves the probe through the overridden PATH");

    assert_eq!(stdout, "probe ran");
}

#[tokio::test]
async fn git_fixture_helper_can_create_dirty_repo() {
    let repo = seed_git_repo(&[("file.txt", "clean\n")]);
    std::fs::write(repo.path().join("file.txt"), "dirty\n").expect("dirty file");

    let stdout = run_git_text(
        repo.path(),
        ["status", "--porcelain=v1"],
        Duration::from_secs(5),
    )
    .await
    .expect("status succeeds");

    assert!(stdout.contains("M file.txt"));
    run_git(repo.path(), &["checkout", "--", "file.txt"]);
}
