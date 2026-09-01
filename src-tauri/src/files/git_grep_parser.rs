// Parse `git grep -n --null` output into the renderer's
// `WorkspaceContentSearchResult` shape.
//
// `--null` only NUL-separates the fields *within* a record; each record is
// still terminated by a newline. One match looks like:
//
//     <path>\0<lineNumber>\0<lineContent>\n
//
// Some git versions prefix the content field with a colon. We defensively
// strip a leading colon to cover both shapes.

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
    // Preserve emit order: git emits matches in path-sorted order with
    // multiple matches per file contiguous. We rely on insertion order
    // when building the result, so a Vec keyed by a linear scan is fine.
    let mut files: Vec<WorkspaceContentSearchFile> = Vec::new();
    let mut truncated = false;

    for record in raw.split('\n') {
        if record.is_empty() {
            continue;
        }
        let mut fields = record.splitn(3, '\0');
        let (Some(path), Some(line_raw), Some(preview_raw)) =
            (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let Ok(line) = line_raw.parse::<i64>() else {
            continue;
        };
        let preview = preview_raw.strip_prefix(':').unwrap_or(preview_raw);
        let preview: String = preview.chars().take(MAX_PREVIEW_CHARS).collect();

        let bucket_index = match files.iter().position(|file| file.path == path) {
            Some(index) => index,
            None => {
                if files.len() >= options.max_files {
                    truncated = true;
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
        let raw = "src/foo.rs\x0012\x00fn hello() {\n";
        let parsed = parse_git_grep_output(raw, &options());
        assert_eq!(parsed.files.len(), 1);
        assert_eq!(parsed.files[0].path, "src/foo.rs");
        assert_eq!(parsed.files[0].matches.len(), 1);
        assert_eq!(parsed.files[0].matches[0].line, 12);
        assert_eq!(parsed.files[0].matches[0].preview, "fn hello() {");
        assert!(!parsed.truncated);
    }

    // Real `git grep -n --null` output: NUL between the fields of a record,
    // newline between records. Getting this backwards let one record's
    // content swallow the next record's path.
    #[test]
    fn keeps_records_separate_across_files_and_matches() {
        let raw = "a.txt\x001\x00hello a\na.txt\x002\x00hello b\nb.txt\x001\x00hello c\n";
        let parsed = parse_git_grep_output(raw, &options());
        assert_eq!(parsed.files.len(), 2);
        assert_eq!(parsed.files[0].path, "a.txt");
        assert_eq!(
            parsed.files[0]
                .matches
                .iter()
                .map(|m| (m.line, m.preview.as_str()))
                .collect::<Vec<_>>(),
            vec![(1, "hello a"), (2, "hello b")]
        );
        assert_eq!(parsed.files[1].path, "b.txt");
        assert_eq!(parsed.files[1].matches[0].preview, "hello c");
        assert!(!parsed.truncated);
    }

    // A matched line may itself contain NULs only in binary files, which
    // `-I` skips, but it can contain colons and separators; everything past
    // the second NUL is content.
    #[test]
    fn content_may_contain_nul_separators() {
        let raw = "a.txt\x003\x00let x = a\x00b;\n";
        let parsed = parse_git_grep_output(raw, &options());
        assert_eq!(parsed.files[0].matches[0].preview, "let x = a\u{0}b;");
    }

    #[test]
    fn strips_leading_colon_from_match_preview() {
        let raw = "src/foo.rs\x001\x00:matched content\n";
        let parsed = parse_git_grep_output(raw, &options());
        assert_eq!(parsed.files[0].matches[0].preview, "matched content");
    }

    #[test]
    fn truncates_files_beyond_cap() {
        let opts = GrepParseOptions {
            max_files: 1,
            max_matches_per_file: 10,
        };
        let raw = "a.rs\x001\x00aa\nb.rs\x001\x00bb\n";
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
        let raw = "a.rs\x001\x00first\na.rs\x002\x00second\n";
        let parsed = parse_git_grep_output(raw, &opts);
        assert_eq!(parsed.files[0].matches.len(), 1);
        assert!(parsed.truncated);
    }

    #[test]
    fn long_preview_is_capped() {
        let long = "x".repeat(1000);
        let raw = format!("a.rs\x001\x00{long}\n");
        let parsed = parse_git_grep_output(&raw, &options());
        assert_eq!(parsed.files[0].matches[0].preview.chars().count(), 320);
    }
}
