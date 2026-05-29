use std::fmt;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::error::InvalidInputIssue;

pub const MAX_STREAM_CHUNK_BYTES: usize = 64 * 1024;
pub const MAX_FILE_CONTENT_BYTES: usize = 4 * 1024 * 1024;
pub const ATTACHMENT_BYTE_CAP: usize = 10 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ProviderId {
    Claude,
    Codex,
    Cursor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningEffort {
    Low,
    Medium,
    High,
    Xhigh,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum AgentMode {
    Auto,
    Plan,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum PermissionMode {
    #[serde(rename = "auto-approve")]
    AutoApprove,
    #[serde(rename = "ask-each-time")]
    AskEachTime,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum AttachmentMimeType {
    #[serde(rename = "image/png")]
    ImagePng,
    #[serde(rename = "image/jpeg")]
    ImageJpeg,
    #[serde(rename = "image/gif")]
    ImageGif,
    #[serde(rename = "image/webp")]
    ImageWebp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum IdeId {
    Vscode,
    Cursor,
    Windsurf,
    Zed,
    Terminal,
    Iterm,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    Light,
    Dark,
    System,
}

macro_rules! string_newtype {
    ($name:ident) => {
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Type)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn as_str(&self) -> &str {
                &self.0
            }

            pub fn into_string(self) -> String {
                self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.fmt(f)
            }
        }
    };
}

string_newtype!(ProjectId);
string_newtype!(WorkspaceId);
string_newtype!(SessionId);
string_newtype!(ApprovalId);
string_newtype!(TerminalId);
string_newtype!(McpAuthSessionId);
string_newtype!(Prompt);
string_newtype!(BaseRef);
string_newtype!(BranchName);
string_newtype!(RelativePath);
string_newtype!(AbsolutePath);
string_newtype!(RepoPath);
string_newtype!(AttachmentPath);
string_newtype!(OpenPath);
string_newtype!(SearchQuery);
string_newtype!(TaskLabel);
string_newtype!(StreamChunk);
string_newtype!(FileContent);
string_newtype!(CommandText);
string_newtype!(GitCommitMessage);
string_newtype!(Base64ImageData);
string_newtype!(NonEmptyString);

macro_rules! try_from_string {
    ($name:ident, $validator:expr) => {
        impl TryFrom<String> for $name {
            type Error = InvalidInputIssue;

            fn try_from(value: String) -> Result<Self, Self::Error> {
                $validator(value).map($name)
            }
        }
    };
}

try_from_string!(ProjectId, |value| bounded_id("projectId", value));
try_from_string!(WorkspaceId, |value| bounded_id("workspaceId", value));
try_from_string!(SessionId, |value| bounded_id("sessionId", value));
try_from_string!(ApprovalId, |value| bounded_id("approvalId", value));
try_from_string!(TerminalId, |value| non_empty("terminalId", value));
try_from_string!(McpAuthSessionId, |value| non_empty("sessionId", value));
try_from_string!(Prompt, validate_prompt);
try_from_string!(BaseRef, |value| validate_git_ref("baseRef", value));
try_from_string!(BranchName, |value| validate_git_ref("branch", value));
try_from_string!(RelativePath, |value| validate_relative_path(
    "filePath", value
));
try_from_string!(AbsolutePath, |value| validate_absolute_path("path", value));
try_from_string!(RepoPath, |value| validate_absolute_path("repoPath", value));
try_from_string!(AttachmentPath, validate_attachment_path);
try_from_string!(OpenPath, validate_open_path);
try_from_string!(SearchQuery, |value| validate_byte_cap("query", value, 256)
    .and_then(|value| non_empty("query", value)));
try_from_string!(TaskLabel, |value| validate_byte_cap(
    "taskLabel",
    value,
    200
)
.and_then(|value| non_empty("taskLabel", value)));
try_from_string!(StreamChunk, |value| validate_byte_cap(
    "data",
    value,
    MAX_STREAM_CHUNK_BYTES
));
try_from_string!(FileContent, |value| validate_byte_cap(
    "content",
    value,
    MAX_FILE_CONTENT_BYTES
));
try_from_string!(CommandText, |value| validate_byte_cap(
    "command", value, 8192
)
.and_then(|value| non_empty("command", value)));
try_from_string!(GitCommitMessage, |value| validate_byte_cap(
    "message",
    value,
    64 * 1024
)
.and_then(|value| {
    if value.trim().is_empty() {
        Err(issue("message", "STRING_BLANK", "message cannot be blank"))
    } else {
        Ok(value)
    }
}));
try_from_string!(NonEmptyString, |value| non_empty("value", value));

impl TryFrom<String> for Base64ImageData {
    type Error = InvalidInputIssue;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.is_empty() {
            return Err(issue("dataBase64", "STRING_EMPTY", "must not be empty"));
        }
        if value.len() > 14 * 1024 * 1024 {
            return Err(issue(
                "dataBase64",
                "STRING_TOO_LONG",
                "dataBase64 exceeds maximum length",
            ));
        }
        if !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'+' | b'/' | b'=' | b' ' | b'\n' | b'\r' | b'\t')
        }) {
            return Err(issue(
                "dataBase64",
                "BASE64_INVALID",
                "dataBase64 must be base64-encoded",
            ));
        }
        Ok(Self(value))
    }
}

impl<'de> Deserialize<'de> for ProjectId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        ProjectId::try_from(String::deserialize(deserializer)?).map_err(de_error)
    }
}

impl<'de> Deserialize<'de> for WorkspaceId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        WorkspaceId::try_from(String::deserialize(deserializer)?).map_err(de_error)
    }
}

impl<'de> Deserialize<'de> for SessionId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        SessionId::try_from(String::deserialize(deserializer)?).map_err(de_error)
    }
}

impl<'de> Deserialize<'de> for ApprovalId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        ApprovalId::try_from(String::deserialize(deserializer)?).map_err(de_error)
    }
}

impl<'de> Deserialize<'de> for TerminalId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        TerminalId::try_from(String::deserialize(deserializer)?).map_err(de_error)
    }
}

impl<'de> Deserialize<'de> for McpAuthSessionId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        McpAuthSessionId::try_from(String::deserialize(deserializer)?).map_err(de_error)
    }
}

impl<'de> Deserialize<'de> for Prompt {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Prompt::try_from(String::deserialize(deserializer)?).map_err(de_error)
    }
}

impl<'de> Deserialize<'de> for BaseRef {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        BaseRef::try_from(String::deserialize(deserializer)?).map_err(de_error)
    }
}

impl<'de> Deserialize<'de> for BranchName {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        BranchName::try_from(String::deserialize(deserializer)?).map_err(de_error)
    }
}

impl<'de> Deserialize<'de> for RelativePath {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        RelativePath::try_from(String::deserialize(deserializer)?).map_err(de_error)
    }
}

impl<'de> Deserialize<'de> for AbsolutePath {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        AbsolutePath::try_from(String::deserialize(deserializer)?).map_err(de_error)
    }
}

impl<'de> Deserialize<'de> for RepoPath {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        RepoPath::try_from(String::deserialize(deserializer)?).map_err(de_error)
    }
}

impl<'de> Deserialize<'de> for AttachmentPath {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        AttachmentPath::try_from(String::deserialize(deserializer)?).map_err(de_error)
    }
}

impl<'de> Deserialize<'de> for OpenPath {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        OpenPath::try_from(String::deserialize(deserializer)?).map_err(de_error)
    }
}

impl<'de> Deserialize<'de> for SearchQuery {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        SearchQuery::try_from(String::deserialize(deserializer)?).map_err(de_error)
    }
}

impl<'de> Deserialize<'de> for TaskLabel {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        TaskLabel::try_from(String::deserialize(deserializer)?).map_err(de_error)
    }
}

impl<'de> Deserialize<'de> for StreamChunk {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        StreamChunk::try_from(String::deserialize(deserializer)?).map_err(de_error)
    }
}

impl<'de> Deserialize<'de> for FileContent {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        FileContent::try_from(String::deserialize(deserializer)?).map_err(de_error)
    }
}

impl<'de> Deserialize<'de> for CommandText {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        CommandText::try_from(String::deserialize(deserializer)?).map_err(de_error)
    }
}

impl<'de> Deserialize<'de> for GitCommitMessage {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        GitCommitMessage::try_from(String::deserialize(deserializer)?).map_err(de_error)
    }
}

impl<'de> Deserialize<'de> for Base64ImageData {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Base64ImageData::try_from(String::deserialize(deserializer)?).map_err(de_error)
    }
}

impl<'de> Deserialize<'de> for NonEmptyString {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        NonEmptyString::try_from(String::deserialize(deserializer)?).map_err(de_error)
    }
}

pub fn validate_prompt(value: String) -> Result<String, InvalidInputIssue> {
    non_empty("prompt", value).and_then(|value| {
        if value.starts_with('-') {
            Err(InvalidInputIssue::prompt_leading_dash())
        } else if value.contains('\n') || value.contains('\r') {
            Err(InvalidInputIssue::prompt_contains_newline())
        } else if value.contains('\0') {
            Err(issue(
                "prompt",
                "STRING_NULL_BYTE",
                "prompt must not contain null bytes",
            ))
        } else {
            Ok(value)
        }
    })
}

pub fn validate_relative_path(
    field: &'static str,
    value: String,
) -> Result<String, InvalidInputIssue> {
    non_empty(field, value).and_then(|value| {
        if value.starts_with('/') {
            Err(InvalidInputIssue::file_path_absolute(field))
        } else if value.starts_with('-') {
            Err(issue(
                field,
                "FILE_PATH_LEADING_DASH",
                "file path must not start with '-'",
            ))
        } else if value.split(['/', '\\']).any(|segment| segment == "..") {
            Err(InvalidInputIssue::file_path_traversal(field))
        } else if value.contains('\0') {
            Err(InvalidInputIssue::file_path_null_byte(field))
        } else if value.len() > 4096 {
            Err(InvalidInputIssue::file_path_too_long(field))
        } else {
            Ok(value)
        }
    })
}

pub fn validate_git_ref(field: &'static str, value: String) -> Result<String, InvalidInputIssue> {
    non_empty(field, value).and_then(|value| {
        if value.starts_with('-') {
            return Err(InvalidInputIssue::git_ref_leading_dash(field));
        }
        if value.len() > 255
            || !value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'/' | b'-')
            })
        {
            return Err(InvalidInputIssue::git_ref_invalid(field));
        }
        if value.contains('\0') {
            return Err(issue(
                field,
                "STRING_NULL_BYTE",
                "git ref must not contain null bytes",
            ));
        }
        // Pin git's own refname rules so a value that passes the byte
        // allowlist can't be reinterpreted as a revision range (`a..b`)
        // or rejected by git later in the pipeline (`topic.lock`,
        // `feat/`, leading `.`). See `git check-ref-format`.
        if value.contains("..")
            || value.ends_with('/')
            || value.ends_with(".lock")
            || value.split('/').any(|segment| {
                segment.is_empty() || segment.starts_with('.') || segment.ends_with(".lock")
            })
        {
            return Err(InvalidInputIssue::git_ref_invalid(field));
        }
        Ok(value)
    })
}

fn validate_absolute_path(field: &'static str, value: String) -> Result<String, InvalidInputIssue> {
    non_empty(field, value).and_then(|value| {
        if !value.starts_with('/') {
            Err(issue(field, "PATH_NOT_ABSOLUTE", "path must be absolute"))
        } else if value.contains('\0') {
            Err(issue(
                field,
                "PATH_NULL_BYTE",
                "path must not contain null bytes",
            ))
        } else {
            Ok(value)
        }
    })
}

fn validate_attachment_path(value: String) -> Result<String, InvalidInputIssue> {
    validate_absolute_path("filePath", value).and_then(|value| {
        if value.len() > 2048 {
            Err(issue(
                "filePath",
                "PATH_TOO_LONG",
                "filePath exceeds maximum length",
            ))
        } else {
            Ok(value)
        }
    })
}

fn validate_open_path(value: String) -> Result<String, InvalidInputIssue> {
    non_empty("path", value).and_then(|value| {
        if value.starts_with('-') {
            Err(issue(
                "path",
                "PATH_LEADING_DASH",
                "path cannot start with '-'",
            ))
        } else if value.contains('\0') {
            Err(issue(
                "path",
                "PATH_NULL_BYTE",
                "path must not contain null bytes",
            ))
        } else if value.split(['/', '\\']).any(|segment| segment == "..") {
            // Defense in depth: `system:open-path` resolves canonically when
            // the target exists, but missing targets fall through unchecked.
            // Reject `..` syntactically so traversal can't reach the OS opener.
            Err(issue(
                "path",
                "PATH_TRAVERSAL",
                "path must not contain '..' segments",
            ))
        } else {
            Ok(value)
        }
    })
}

fn bounded_id(field: &'static str, value: String) -> Result<String, InvalidInputIssue> {
    non_empty(field, value).and_then(|value| validate_byte_cap(field, value, 256))
}

fn validate_byte_cap(
    field: &'static str,
    value: String,
    max: usize,
) -> Result<String, InvalidInputIssue> {
    if value.len() > max {
        Err(issue(
            field,
            "STRING_TOO_LARGE",
            format!("must not exceed {max} bytes when encoded as UTF-8"),
        ))
    } else if value.contains('\0') {
        Err(issue(
            field,
            "STRING_NULL_BYTE",
            "value must not contain null bytes",
        ))
    } else {
        Ok(value)
    }
}

fn non_empty(field: &'static str, value: String) -> Result<String, InvalidInputIssue> {
    if value.is_empty() {
        Err(issue(field, "STRING_EMPTY", "must not be empty"))
    } else {
        Ok(value)
    }
}

fn issue(field: &'static str, code: &'static str, message: impl Into<String>) -> InvalidInputIssue {
    InvalidInputIssue::at(vec![field.into()], code, message)
}

fn de_error<E>(issue: InvalidInputIssue) -> E
where
    E: serde::de::Error,
{
    E::custom(format!("{}: {}", issue.code, issue.message))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_rejects_leading_dash_and_newline() {
        assert!(matches!(
            validate_prompt("-danger".to_owned()).unwrap_err().code,
            "PROMPT_LEADING_DASH"
        ));
        assert!(matches!(
            validate_prompt("hello\nworld".to_owned()).unwrap_err().code,
            "PROMPT_CONTAINS_NEWLINE"
        ));
    }

    #[test]
    fn relative_path_rejects_absolute_traversal_and_dash() {
        assert!(matches!(
            validate_relative_path("filePath", "/tmp/x".to_owned())
                .unwrap_err()
                .code,
            "FILE_PATH_ABSOLUTE"
        ));
        assert!(matches!(
            validate_relative_path("filePath", "a/../b".to_owned())
                .unwrap_err()
                .code,
            "FILE_PATH_TRAVERSAL"
        ));
        assert!(matches!(
            validate_relative_path("filePath", "-flag".to_owned())
                .unwrap_err()
                .code,
            "FILE_PATH_LEADING_DASH"
        ));
    }

    #[test]
    fn git_ref_rejects_leading_dash_and_bad_chars() {
        assert!(matches!(
            validate_git_ref("branch", "-main".to_owned())
                .unwrap_err()
                .code,
            "GIT_REF_LEADING_DASH"
        ));
        assert!(matches!(
            validate_git_ref("branch", "bad branch".to_owned())
                .unwrap_err()
                .code,
            "GIT_REF_INVALID"
        ));
    }

    #[test]
    fn git_ref_rejects_git_illegal_sequences() {
        for bad in [
            "feat/..",
            "..feat",
            "a..b",
            "topic.lock",
            "feat/topic.lock",
            "branch/",
            ".hidden",
            "feat/.hidden",
            "feat//double",
        ] {
            let result = validate_git_ref("branch", bad.to_owned());
            assert!(result.is_err(), "expected reject: {bad}");
            assert_eq!(result.unwrap_err().code, "GIT_REF_INVALID", "case: {bad}");
        }
        // Valid refs still pass.
        for good in ["feat/topic", "release-1.0", "v2.3.4", "user/feature-x"] {
            assert!(
                validate_git_ref("branch", good.to_owned()).is_ok(),
                "expected accept: {good}"
            );
        }
    }

    #[test]
    fn open_path_rejects_dotdot_traversal() {
        assert_eq!(
            validate_open_path("../etc/passwd".to_owned())
                .unwrap_err()
                .code,
            "PATH_TRAVERSAL"
        );
        assert_eq!(
            validate_open_path("a/b/../c".to_owned()).unwrap_err().code,
            "PATH_TRAVERSAL"
        );
    }
}
