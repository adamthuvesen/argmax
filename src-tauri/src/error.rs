// Domain error model.
//
// `ArgmaxError` is the single error type that Tauri commands return. It
// serializes with a stable top-level `code` string so the renderer's
// `error.code === "INVALID_INPUT"` branches keep working unchanged from
// the Electron build.
//
// The Zod-era `InvalidInputIssue` shape (path / code / message per issue)
// is preserved verbatim so renderer error renderers don't have to learn
// a new envelope.

use serde::Serialize;
use thiserror::Error;

pub type ArgmaxResult<T> = Result<T, ArgmaxError>;

#[derive(Debug, Clone, Error, Serialize)]
#[serde(tag = "code", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ArgmaxError {
    #[error("invalid input ({})", .issues.len())]
    InvalidInput { issues: Vec<InvalidInputIssue> },

    #[error("{kind} not found: {id}")]
    RecordNotFound { kind: String, id: String },

    #[error("migration drift detected: {detail}")]
    MigrationDrift { detail: String },

    #[error("{message}")]
    ServiceError {
        // Sub-code lets callers distinguish failures within the
        // SERVICE_ERROR family without inventing a new top-level variant
        // for every leaf (e.g., GH_RATE_LIMITED, PTY_SPAWN_FAILED).
        sub_code: String,
        message: String,
    },
}

impl ArgmaxError {
    /// Convenience constructor for the common case of a single issue.
    pub fn invalid(issue: InvalidInputIssue) -> Self {
        Self::InvalidInput {
            issues: vec![issue],
        }
    }

    pub fn record_not_found(kind: impl Into<String>, id: impl Into<String>) -> Self {
        Self::RecordNotFound {
            kind: kind.into(),
            id: id.into(),
        }
    }

    pub fn service(sub_code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::ServiceError {
            sub_code: sub_code.into(),
            message: message.into(),
        }
    }
}

/// A single boundary-validation failure. Mirrors today's Zod
/// `InvalidInputIssue { path, code, message }` shape.
#[derive(Debug, Clone, Serialize)]
pub struct InvalidInputIssue {
    pub path: Vec<String>,
    pub code: &'static str,
    pub message: String,
}

impl InvalidInputIssue {
    pub fn at(path: Vec<String>, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            path,
            code,
            message: message.into(),
        }
    }

    pub fn prompt_leading_dash() -> Self {
        Self::at(
            vec!["prompt".into()],
            "PROMPT_LEADING_DASH",
            "prompt must not start with '-' (looks like a CLI flag)",
        )
    }

    pub fn prompt_contains_newline() -> Self {
        Self::at(
            vec!["prompt".into()],
            "PROMPT_CONTAINS_NEWLINE",
            "prompt must not contain newline characters",
        )
    }

    pub fn file_path_absolute(field: &'static str) -> Self {
        Self::at(
            vec![field.into()],
            "FILE_PATH_ABSOLUTE",
            "file path must be relative to the workspace root",
        )
    }

    pub fn file_path_traversal(field: &'static str) -> Self {
        Self::at(
            vec![field.into()],
            "FILE_PATH_TRAVERSAL",
            "file path must not contain `..` segments",
        )
    }

    pub fn file_path_null_byte(field: &'static str) -> Self {
        Self::at(
            vec![field.into()],
            "FILE_PATH_NULL_BYTE",
            "file path must not contain null bytes",
        )
    }

    pub fn file_path_too_long(field: &'static str) -> Self {
        Self::at(
            vec![field.into()],
            "FILE_PATH_TOO_LONG",
            "file path exceeds the maximum byte length",
        )
    }

    pub fn git_ref_invalid(field: &'static str) -> Self {
        Self::at(
            vec![field.into()],
            "GIT_REF_INVALID",
            "git ref contains characters that are not allowed",
        )
    }

    pub fn git_ref_leading_dash(field: &'static str) -> Self {
        Self::at(
            vec![field.into()],
            "GIT_REF_LEADING_DASH",
            "git ref must not start with '-' (looks like a CLI flag)",
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_input_serializes_with_top_level_code() {
        let err = ArgmaxError::invalid(InvalidInputIssue::prompt_leading_dash());
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["code"], "INVALID_INPUT");
        let issues = json["issues"].as_array().expect("issues array");
        assert_eq!(issues[0]["code"], "PROMPT_LEADING_DASH");
        assert_eq!(issues[0]["path"][0], "prompt");
    }

    #[test]
    fn record_not_found_serializes_with_top_level_code() {
        let err = ArgmaxError::record_not_found("session", "abc-123");
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["code"], "RECORD_NOT_FOUND");
        assert_eq!(json["kind"], "session");
        assert_eq!(json["id"], "abc-123");
    }

    #[test]
    fn service_error_carries_sub_code() {
        let err = ArgmaxError::service("PTY_SPAWN_FAILED", "no tty");
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["code"], "SERVICE_ERROR");
        assert_eq!(json["sub_code"], "PTY_SPAWN_FAILED");
    }
}
