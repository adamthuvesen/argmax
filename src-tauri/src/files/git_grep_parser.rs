// Parse `git grep -n --null -z` output into the renderer's
// `WorkspaceContentSearchResult` shape.
//
// With `-z --null`, git emits NUL between every output field AND between
// match records. One match looks like:
//
//     <path>\0<lineNumber>\0<lineContent>\0
//
// Earlier git versions used `\0<line>\0:<content>` with a leading colon on
// the content field; modern git ≥2.43 drops it. We defensively strip a
// leading colon to cover both shapes.

use serde::Serialize;
use specta::Type;

/// Cap on the per-line snippet shipped to the renderer. Long minified
/// lines would otherwise blow the IPC envelope and the UI cell.
const MAX_PREVIEW_CHARS: usize = 320;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContentSearchMatch {
    pub line: i64,
    pub preview: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContentSearchFile {
    pub path: String,
    pub matches: Vec<WorkspaceContentSearchMatch>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContentSearchResult {
    pub files: Vec<WorkspaceContentSearchFile>,
    pub truncated: bool,
}

pub struct GrepParseOptions {
    pub max_files: usize,
    pub max_matches_per_file: usize,
}

pub fn parse_git_grep_output(
    raw: &str,
    options: &GrepParseOptions,
) -> WorkspaceContentSearchResult {
    if raw.is_empty() {
        return WorkspaceContentSearchResult {
            files: Vec::new(),
            truncated: false,
        };
    }
    let mut fields: Vec<&str> = raw.split('\0').collect();
    // Trailing NUL adds one trailing empty string; drop it.
    if matches!(fields.last(), Some(&"")) {
        fields.pop();
    }

    // Preserve emit order: git emits matches in path-sorted order with
    // multiple matches per file contiguous. We rely on insertion order
    // when building the result, so a Vec<(path, file)> keyed lookup is
    // fine.
    let mut files: Vec<WorkspaceContentSearchFile> = Vec::new();
    let mut truncated = false;

    let mut i = 0;
    while i + 2 < fields.len() {
        let path = fields[i];
        let line_raw = fields[i + 1];
        let preview_raw = fields[i + 2];

        let line = match line_raw.parse::<i64>() {
            Ok(line) => line,
            Err(_) => {
                // Not a valid record — skip one field and try again.
                i += 1;
                continue;
            }
        };
        let preview = if let Some(stripped) = preview_raw.strip_prefix(':') {
            stripped
        } else {
            preview_raw
        };
        let preview: String = preview.chars().take(MAX_PREVIEW_CHARS).collect();

        let bucket_index = files.iter().position(|file| file.path == path);
        let bucket_index = match bucket_index {
            Some(index) => index,
            None => {
                if files.len() >= options.max_files {
                    truncated = true;
                    i += 3;
                    continue;
                }
                files.push(WorkspaceContentSearchFile {
                    path: path.to_string(),
                    matches: Vec::new(),
                });
                files.len() - 1
            }
        };
        if files[bucket_index].matches.len() < options.max_matches_per_file {
            files[bucket_index]
                .matches
                .push(WorkspaceContentSearchMatch { line, preview });
        } else {
            truncated = true;
        }
        i += 3;
    }

    WorkspaceContentSearchResult { files, truncated }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> GrepParseOptions {
        GrepParseOptions {
            max_files: 50,
            max_matches_per_file: 10,
        }
    }

    #[test]
    fn parses_empty_input() {
        let parsed = parse_git_grep_output("", &options());
        assert!(parsed.files.is_empty());
        assert!(!parsed.truncated);
    }

    #[test]
    fn parses_single_match() {
        let raw = "src/foo.rs\0\x31\x32\0fn hello() {\0";
        let parsed = parse_git_grep_output(raw, &options());
        assert_eq!(parsed.files.len(), 1);
        assert_eq!(parsed.files[0].path, "src/foo.rs");
        assert_eq!(parsed.files[0].matches.len(), 1);
        assert_eq!(parsed.files[0].matches[0].line, 12);
        assert_eq!(parsed.files[0].matches[0].preview, "fn hello() {");
        assert!(!parsed.truncated);
    }

    #[test]
    fn strips_leading_colon_from_legacy_records() {
        let raw = "src/foo.rs\0\x31\0:legacy content\0";
        let parsed = parse_git_grep_output(raw, &options());
        assert_eq!(parsed.files[0].matches[0].preview, "legacy content");
    }

    #[test]
    fn truncates_files_beyond_cap() {
        let opts = GrepParseOptions {
            max_files: 1,
            max_matches_per_file: 10,
        };
        let raw = "a.rs\x00\x31\x00aa\x00b.rs\x00\x31\x00bb\x00";
        let parsed = parse_git_grep_output(raw, &opts);
        assert_eq!(parsed.files.len(), 1);
        assert!(parsed.truncated);
    }

    #[test]
    fn truncates_matches_beyond_per_file_cap() {
        let opts = GrepParseOptions {
            max_files: 50,
            max_matches_per_file: 1,
        };
        let raw = "a.rs\x00\x31\x00first\x00a.rs\x00\x32\x00second\x00";
        let parsed = parse_git_grep_output(raw, &opts);
        assert_eq!(parsed.files[0].matches.len(), 1);
        assert!(parsed.truncated);
    }

    #[test]
    fn long_preview_is_capped() {
        let long = "x".repeat(1000);
        let raw = format!("a.rs\x00\x31\x00{long}\x00");
        let parsed = parse_git_grep_output(&raw, &options());
        assert_eq!(parsed.files[0].matches[0].preview.chars().count(), 320);
    }
}
