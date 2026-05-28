use std::{
    ffi::{OsStr, OsString},
    path::Path,
    process::{ExitStatus, Stdio},
    time::Duration,
};

use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    time,
};

use crate::error::{ArgmaxError, ArgmaxResult};

pub const GIT_DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
pub const GIT_STDOUT_CAP_BYTES: usize = 8 * 1024 * 1024;
const GIT_STDERR_CAP_BYTES: usize = 64 * 1024;
const ERROR_DETAIL_CAP_BYTES: usize = 4096;

#[derive(Debug, Clone)]
pub struct GitExecOptions {
    pub timeout: Duration,
    pub stdout_cap_bytes: usize,
    /// Extra env vars layered onto git's environment. Used by the
    /// checkpoint service to inject `GIT_INDEX_FILE` for a scratch index.
    pub env: Vec<(OsString, OsString)>,
}

impl Default for GitExecOptions {
    fn default() -> Self {
        Self {
            timeout: GIT_DEFAULT_TIMEOUT,
            stdout_cap_bytes: GIT_STDOUT_CAP_BYTES,
            env: Vec::new(),
        }
    }
}

impl GitExecOptions {
    pub fn with_env<K: Into<OsString>, V: Into<OsString>>(mut self, key: K, value: V) -> Self {
        self.env.push((key.into(), value.into()));
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitExit {
    pub stdout: String,
    pub exit_code: i32,
}

#[derive(Debug)]
struct GitCommandOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

pub async fn run_git_text<P, I, S>(
    workspace_path: P,
    args: I,
    timeout: Duration,
) -> ArgmaxResult<String>
where
    P: AsRef<Path>,
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = run_git_output(
        workspace_path.as_ref(),
        args,
        GitExecOptions {
            timeout,
            ..GitExecOptions::default()
        },
    )
    .await?;
    String::from_utf8(output).map_err(|error| {
        ArgmaxError::service(
            "GIT_STDOUT_NOT_UTF8",
            format!("git stdout was not valid UTF-8: {error}"),
        )
    })
}

pub async fn run_git_text_with_allowed_exit_codes<P, I, S>(
    workspace_path: P,
    args: I,
    allowed_exit_codes: &[i32],
    timeout: Duration,
) -> ArgmaxResult<GitExit>
where
    P: AsRef<Path>,
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let args = collect_args(args);
    validate_pathspec_args(&args)?;
    let output = run_git_command(
        workspace_path.as_ref(),
        &args,
        GitExecOptions {
            timeout,
            ..GitExecOptions::default()
        },
    )
    .await?;
    let stdout = decode_stdout(output.stdout)?;
    let exit_code = output.status.code().unwrap_or(-1);

    if output.status.success() || allowed_exit_codes.contains(&exit_code) {
        return Ok(GitExit { stdout, exit_code });
    }

    Err(non_zero_error(exit_code, &output.stderr))
}

pub async fn run_git_buffer<P, I, S>(
    workspace_path: P,
    args: I,
    timeout: Duration,
) -> ArgmaxResult<Vec<u8>>
where
    P: AsRef<Path>,
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    run_git_output(
        workspace_path.as_ref(),
        args,
        GitExecOptions {
            timeout,
            ..GitExecOptions::default()
        },
    )
    .await
}

pub async fn run_git_buffer_with_options<P, I, S>(
    workspace_path: P,
    args: I,
    options: GitExecOptions,
) -> ArgmaxResult<Vec<u8>>
where
    P: AsRef<Path>,
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    run_git_output(workspace_path.as_ref(), args, options).await
}

pub fn reject_leading_dash(field: &'static str, value: &str) -> ArgmaxResult<()> {
    if value.starts_with('-') {
        return Err(ArgmaxError::service(
            "GIT_ARG_LEADING_DASH",
            format!("{field} must not start with '-'"),
        ));
    }
    Ok(())
}

async fn run_git_output<I, S>(
    workspace_path: &Path,
    args: I,
    options: GitExecOptions,
) -> ArgmaxResult<Vec<u8>>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let args = collect_args(args);
    validate_pathspec_args(&args)?;
    let output = run_git_command(workspace_path, &args, options.clone()).await?;
    let exit_code = output.status.code().unwrap_or(-1);

    if !output.status.success() {
        return Err(non_zero_error(exit_code, &output.stderr));
    }
    if output.stdout.len() > options.stdout_cap_bytes {
        return Err(ArgmaxError::service(
            "GIT_STDOUT_TOO_LARGE",
            format!(
                "git stdout exceeded {} bytes (received {} bytes)",
                options.stdout_cap_bytes,
                output.stdout.len()
            ),
        ));
    }

    Ok(output.stdout)
}

async fn run_git_command(
    workspace_path: &Path,
    args: &[OsString],
    options: GitExecOptions,
) -> ArgmaxResult<GitCommandOutput> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(workspace_path)
        .args(args)
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .env("LANGUAGE", "")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (key, value) in &options.env {
        command.env(key, value);
    }

    let mut child = command.spawn().map_err(|error| {
        ArgmaxError::service("GIT_SPAWN_FAILED", format!("failed to run git: {error}"))
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        ArgmaxError::service("GIT_SPAWN_FAILED", "git stdout pipe was unavailable")
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        ArgmaxError::service("GIT_SPAWN_FAILED", "git stderr pipe was unavailable")
    })?;

    let wait = async {
        time::timeout(options.timeout, child.wait())
            .await
            .map_err(|_| {
                ArgmaxError::service(
                    "GIT_TIMEOUT",
                    format!(
                        "git command timed out after {} ms",
                        options.timeout.as_millis()
                    ),
                )
            })?
            .map_err(|error| {
                ArgmaxError::service(
                    "GIT_WAIT_FAILED",
                    format!("failed to wait for git: {error}"),
                )
            })
    };
    let stdout = read_capped(stdout, options.stdout_cap_bytes, "stdout");
    let stderr = read_truncated(stderr, GIT_STDERR_CAP_BYTES);

    let (status, stdout, stderr) = tokio::try_join!(wait, stdout, stderr)?;
    Ok(GitCommandOutput {
        status,
        stdout,
        stderr,
    })
}

async fn read_capped<R>(
    mut reader: R,
    cap_bytes: usize,
    label: &'static str,
) -> ArgmaxResult<Vec<u8>>
where
    R: AsyncRead + Unpin,
{
    let mut output = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let read = reader.read(&mut buffer).await.map_err(|error| {
            ArgmaxError::service(
                "GIT_PIPE_READ_FAILED",
                format!("failed to read git {label}: {error}"),
            )
        })?;
        if read == 0 {
            return Ok(output);
        }
        if output.len() + read > cap_bytes {
            return Err(ArgmaxError::service(
                "GIT_STDOUT_TOO_LARGE",
                format!(
                    "git {label} exceeded {cap_bytes} bytes (received at least {} bytes)",
                    output.len() + read
                ),
            ));
        }
        output.extend_from_slice(&buffer[..read]);
    }
}

async fn read_truncated<R>(mut reader: R, cap_bytes: usize) -> ArgmaxResult<Vec<u8>>
where
    R: AsyncRead + Unpin,
{
    let mut output = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let read = reader.read(&mut buffer).await.map_err(|error| {
            ArgmaxError::service(
                "GIT_PIPE_READ_FAILED",
                format!("failed to read git stderr: {error}"),
            )
        })?;
        if read == 0 {
            return Ok(output);
        }
        let remaining = cap_bytes.saturating_sub(output.len());
        if remaining > 0 {
            output.extend_from_slice(&buffer[..read.min(remaining)]);
        }
    }
}

fn collect_args<I, S>(args: I) -> Vec<OsString>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    args.into_iter()
        .map(|arg| arg.as_ref().to_os_string())
        .collect()
}

fn validate_pathspec_args(args: &[OsString]) -> ArgmaxResult<()> {
    let mut after_separator = false;
    for arg in args {
        if arg == "--" {
            after_separator = true;
            continue;
        }
        if after_separator {
            let value = arg.to_string_lossy();
            reject_leading_dash("git pathspec", &value)?;
        }
    }
    Ok(())
}

fn decode_stdout(stdout: Vec<u8>) -> ArgmaxResult<String> {
    String::from_utf8(stdout).map_err(|error| {
        ArgmaxError::service(
            "GIT_STDOUT_NOT_UTF8",
            format!("git stdout was not valid UTF-8: {error}"),
        )
    })
}

fn non_zero_error(exit_code: i32, stderr: &[u8]) -> ArgmaxError {
    let detail = String::from_utf8_lossy(stderr);
    let detail = detail.trim();
    let detail = if detail.is_empty() {
        format!("git exited with status {exit_code}")
    } else {
        detail.chars().take(ERROR_DETAIL_CAP_BYTES).collect()
    };
    ArgmaxError::service("GIT_NON_ZERO_EXIT", format!("git failed: {detail}"))
}
