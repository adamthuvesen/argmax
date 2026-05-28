mod support;

use std::time::Duration;

use argmax_lib::git::exec::{
    reject_leading_dash, run_git_buffer, run_git_buffer_with_options, run_git_text,
    run_git_text_with_allowed_exit_codes, GitExecOptions,
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
async fn pathspecs_after_separator_reject_leading_dash() {
    let repo = seed_git_repo(&[("file.txt", "needle\n")]);

    let err = run_git_text(
        repo.path(),
        ["diff", "HEAD", "--", "-looks-like-flag"],
        Duration::from_secs(5),
    )
    .await
    .expect_err("flag-like pathspec rejected");
    let json = serde_json::to_value(&err).expect("serialize error");

    assert_eq!(json["sub_code"], "GIT_ARG_LEADING_DASH");
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
