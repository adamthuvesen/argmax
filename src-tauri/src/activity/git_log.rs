//! Parser for the `git log --numstat` output the Activity scanner reads.
//!
//! The format is built so a commit header can never be confused with a
//! numstat row: every header starts with an ASCII record separator (0x1E) and
//! separates its fields with NULs, so neither a filename with a tab in it nor
//! a commit message can be mistaken for structure.

use std::collections::HashSet;

/// `git log --format=` argument. `%x1e` marks the header, `%x00` the fields:
/// SHA, author email, author date, committer date.
pub const LOG_FORMAT: &str = "%x1e%H%x00%ae%x00%aI%x00%cI";

const RECORD: char = '\u{1e}';

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedCommit {
    pub sha: String,
    pub author_email: String,
    /// ISO 8601 strict, as git printed it (`%aI` / `%cI`).
    pub author_at: String,
    pub committed_at: String,
    pub lines_added: i64,
    pub lines_removed: i64,
    pub files_changed: i64,
}

/// Parse one `git log` run. `allowed_emails` re-checks what `--author` already
/// filtered on: `--author` matches a substring of "Name <email>", so a
/// colleague whose address contains ours would otherwise slip through. Matching
/// is case-insensitive, since git preserves whatever case was configured.
///
/// A SHA seen twice — the same commit reachable from two refs, or two
/// `--author` passes over the same repository — is kept once.
pub fn parse_log(stdout: &str, allowed_emails: &HashSet<String>) -> Vec<ParsedCommit> {
    let mut commits = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut current: Option<ParsedCommit> = None;

    for line in stdout.lines() {
        if let Some(header) = line.strip_prefix(RECORD) {
            if let Some(commit) = current.take() {
                push(&mut commits, &mut seen, commit);
            }
            current = parse_header(header, allowed_emails);
            continue;
        }
        // Numstat rows only count when they belong to a commit we kept; the
        // rows of a filtered-out author are skipped along with their header.
        let Some(commit) = current.as_mut() else {
            continue;
        };
        if let Some((added, removed)) = parse_numstat(line) {
            commit.lines_added += added;
            commit.lines_removed += removed;
            commit.files_changed += 1;
        }
    }
    if let Some(commit) = current.take() {
        push(&mut commits, &mut seen, commit);
    }
    commits
}

fn push(commits: &mut Vec<ParsedCommit>, seen: &mut HashSet<String>, commit: ParsedCommit) {
    if seen.insert(commit.sha.clone()) {
        commits.push(commit);
    }
}

fn parse_header(header: &str, allowed_emails: &HashSet<String>) -> Option<ParsedCommit> {
    let mut fields = header.split('\u{0}');
    let sha = fields.next()?.trim();
    let author_email = fields.next()?.trim();
    let author_at = fields.next()?.trim();
    let committed_at = fields.next()?.trim();
    if sha.is_empty() || author_email.is_empty() || committed_at.is_empty() {
        return None;
    }
    if !allowed_emails.contains(&author_email.to_ascii_lowercase()) {
        return None;
    }
    Some(ParsedCommit {
        sha: sha.to_string(),
        author_email: author_email.to_string(),
        author_at: author_at.to_string(),
        committed_at: committed_at.to_string(),
        lines_added: 0,
        lines_removed: 0,
        files_changed: 0,
    })
}

/// One numstat row: `<added>\t<removed>\t<path>`. A binary file reports `-` for
/// both counts — it changed a file but no lines, so it is one file and zero
/// lines. A rename prints its path as `src/{a => b}.rs`, which the counts
/// ignore.
fn parse_numstat(line: &str) -> Option<(i64, i64)> {
    if line.trim().is_empty() {
        return None;
    }
    let mut fields = line.splitn(3, '\t');
    let added = fields.next()?;
    let removed = fields.next()?;
    // A row without the path field is not a numstat row at all.
    fields.next()?;
    Some((parse_count(added)?, parse_count(removed)?))
}

fn parse_count(value: &str) -> Option<i64> {
    if value == "-" {
        return Some(0);
    }
    value.parse::<i64>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn emails(values: &[&str]) -> HashSet<String> {
        values
            .iter()
            .map(|value| value.to_ascii_lowercase())
            .collect()
    }

    /// Two commits by us and one by someone else, with a binary file, a rename
    /// row, a tab inside a filename, and an empty commit that touches nothing.
    const FIXTURE: &str = concat!(
        "\u{1e}aaa1\u{0}me@example.com\u{0}2026-09-01T10:00:00+02:00\u{0}2026-09-01T10:05:00+02:00\n",
        "\n",
        "12\t3\tsrc/lib.rs\n",
        "-\t-\tassets/icon.png\n",
        "4\t4\tsrc/{old => new}.rs\n",
        "1\t0\tweird\tname.txt\n",
        "\u{1e}bbb2\u{0}other@example.com\u{0}2026-09-01T11:00:00+02:00\u{0}2026-09-01T11:00:00+02:00\n",
        "\n",
        "900\t900\tsrc/theirs.rs\n",
        "\u{1e}ccc3\u{0}Me@Example.com\u{0}2026-09-02T09:00:00+02:00\u{0}2026-09-02T09:00:00+02:00\n",
        "\n",
    );

    #[test]
    fn parses_numstat_counts_and_skips_other_authors() {
        let commits = parse_log(FIXTURE, &emails(&["me@example.com"]));

        assert_eq!(
            commits
                .iter()
                .map(|commit| commit.sha.as_str())
                .collect::<Vec<_>>(),
            vec!["aaa1", "ccc3"]
        );
        let first = &commits[0];
        // 12 + 0 (binary) + 4 + 1 added; 3 + 0 + 4 + 0 removed; four files.
        assert_eq!(
            (first.lines_added, first.lines_removed, first.files_changed),
            (17, 7, 4)
        );
        assert_eq!(first.author_at, "2026-09-01T10:00:00+02:00");
        assert_eq!(first.committed_at, "2026-09-01T10:05:00+02:00");
        // An empty commit is still a commit, with nothing changed.
        assert_eq!(
            (
                commits[1].lines_added,
                commits[1].lines_removed,
                commits[1].files_changed
            ),
            (0, 0, 0)
        );
    }

    #[test]
    fn matches_the_author_email_case_insensitively() {
        let commits = parse_log(FIXTURE, &emails(&["ME@EXAMPLE.COM"]));
        assert_eq!(commits.len(), 2);
    }

    #[test]
    fn keeps_one_row_per_sha_across_refs() {
        let doubled = format!("{FIXTURE}{FIXTURE}");
        let commits = parse_log(&doubled, &emails(&["me@example.com"]));

        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].lines_added, 17);
    }

    #[test]
    fn ignores_output_that_is_not_a_header_or_a_numstat_row() {
        let noise = concat!(
            "fatal: something on stderr leaked into stdout\n",
            "\u{1e}aaa1\u{0}me@example.com\u{0}2026-09-01T10:00:00Z\u{0}2026-09-01T10:00:00Z\n",
            "\n",
            "not a numstat row at all\n",
            "5\t5\tsrc/lib.rs\n",
        );
        let commits = parse_log(noise, &emails(&["me@example.com"]));

        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].files_changed, 1);
        assert_eq!(commits[0].lines_added, 5);
    }

    #[test]
    fn drops_a_header_that_lost_fields() {
        let truncated = "\u{1e}aaa1\u{0}me@example.com\n";
        assert!(parse_log(truncated, &emails(&["me@example.com"])).is_empty());
    }
}
