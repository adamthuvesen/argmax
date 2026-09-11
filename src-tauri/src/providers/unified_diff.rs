//! A unified diff built from a before/after pair of file texts.
//!
//! Cursor's ACP stream is the reason this exists: it reports a write as the
//! file's *whole* text before and after, so a one-line change to a 60-line
//! file arrives as 60 lines on each side. Handed to the chat as a before/after
//! pair that would render as a file where every line changed, which is both
//! unreadable and a wrong `+60 −60`. Reducing the pair to a diff here is what
//! makes the row honest.
//!
//! Only hunks are emitted, no `---`/`+++` file header: the consumer already
//! knows the path, and the renderer's parser keys on `@@` either way.

use std::fmt::Write as _;

/// Context lines around each change, matching git's own default so a chat
/// diff and a review-panel diff read the same.
pub const DEFAULT_CONTEXT: usize = 3;

/// Cells in the longest-common-subsequence table. A changed region larger
/// than this on both sides is a rewrite rather than an edit, and is reported
/// as one replaced block instead of matched line by line.
const MAX_MATCH_CELLS: usize = 1_000_000;

/// One line's fate. `Delete` consumes a before line, `Insert` an after line,
/// `Equal` one of each.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Op {
    Equal,
    Delete,
    Insert,
}

/// The diff from `before` to `after`, or `None` when the two are identical.
///
/// `max_bytes` is the ceiling on the result: past it the diff is a file
/// rewrite, where the payload cost is real and the per-line account stops
/// being what a reader wants, and `None` is returned so the caller reports no
/// diff rather than a truncated one.
pub fn unified_diff(before: &str, after: &str, context: usize, max_bytes: usize) -> Option<String> {
    let old = split_lines(before);
    let new = split_lines(after);
    if old == new {
        // The logical lines match, but the raw texts differ, so only the final
        // newline changed. Keep it visible as a replacement of the last line.
        // The renderer does not draw `\ No newline at end of file` markers,
        // and dropping the write entirely is worse than repeating that line.
        return final_newline_diff(&old, before, after, context, max_bytes);
    }
    let rows = rows(&old, &new);
    let mut diff = String::new();
    for (first, last) in change_groups(&rows, context) {
        let start = first.saturating_sub(context);
        let end = (last + context).min(rows.len() - 1);
        let window = &rows[start..=end];
        let old_count = window.iter().filter(|row| row.op != Op::Insert).count();
        let new_count = window.iter().filter(|row| row.op != Op::Delete).count();
        // A hunk with no line on one side starts *at* what it consumed rather
        // than after it, which is how git writes `-0,0` for a created file.
        let old_start = window[0].old_before + usize::from(old_count > 0);
        let new_start = window[0].new_before + usize::from(new_count > 0);
        let _ = writeln!(
            diff,
            "@@ -{old_start},{old_count} +{new_start},{new_count} @@"
        );
        for row in window {
            let marker = match row.op {
                Op::Equal => ' ',
                Op::Delete => '-',
                Op::Insert => '+',
            };
            let _ = writeln!(diff, "{marker}{}", row.text);
        }
        if diff.len() > max_bytes {
            return None;
        }
    }
    (!diff.is_empty()).then(|| {
        diff.pop();
        diff
    })
}

fn final_newline_diff(
    lines: &[&str],
    before: &str,
    after: &str,
    context: usize,
    max_bytes: usize,
) -> Option<String> {
    if before == after || lines.is_empty() {
        return None;
    }
    let changed = lines.len() - 1;
    let start = changed.saturating_sub(context);
    let window = &lines[start..];
    let mut diff = format!(
        "@@ -{},{} +{},{} @@\n",
        start + 1,
        window.len(),
        start + 1,
        window.len()
    );
    for line in &window[..window.len() - 1] {
        let _ = writeln!(diff, " {line}");
    }
    let _ = writeln!(diff, "-{}", lines[changed]);
    let _ = write!(diff, "+{}", lines[changed]);
    (diff.len() <= max_bytes).then_some(diff)
}

/// One diffed line, carrying how many lines each side had consumed before it
/// so a hunk header can be written without a second pass.
struct Row<'a> {
    op: Op,
    text: &'a str,
    old_before: usize,
    new_before: usize,
}

fn rows<'a>(old: &[&'a str], new: &[&'a str]) -> Vec<Row<'a>> {
    let mut rows = Vec::new();
    let (mut old_index, mut new_index) = (0, 0);
    for op in diff_ops(old, new) {
        let text = match op {
            Op::Insert => new[new_index],
            _ => old[old_index],
        };
        rows.push(Row {
            op,
            text,
            old_before: old_index,
            new_before: new_index,
        });
        if op != Op::Insert {
            old_index += 1;
        }
        if op != Op::Delete {
            new_index += 1;
        }
    }
    rows
}

/// Runs of changed lines, already merged when they are close enough that their
/// context windows would touch — two hunks sharing lines read as one.
fn change_groups(rows: &[Row<'_>], context: usize) -> Vec<(usize, usize)> {
    let mut groups: Vec<(usize, usize)> = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        if row.op == Op::Equal {
            continue;
        }
        match groups.last_mut() {
            Some(group) if index <= group.1 + 2 * context + 1 => group.1 = index,
            _ => groups.push((index, index)),
        }
    }
    groups
}

/// The edit script, common prefix and suffix taken off first. That trim is
/// what keeps the quadratic match below to the region that actually changed,
/// which for an ordinary edit is a handful of lines out of a whole file.
fn diff_ops(old: &[&str], new: &[&str]) -> Vec<Op> {
    let prefix = old
        .iter()
        .zip(new.iter())
        .take_while(|(left, right)| left == right)
        .count();
    let suffix = old[prefix..]
        .iter()
        .rev()
        .zip(new[prefix..].iter().rev())
        .take_while(|(left, right)| left == right)
        .count();
    let old_middle = &old[prefix..old.len() - suffix];
    let new_middle = &new[prefix..new.len() - suffix];

    let mut ops = vec![Op::Equal; prefix];
    if old_middle.len().saturating_mul(new_middle.len()) > MAX_MATCH_CELLS {
        ops.extend(std::iter::repeat_n(Op::Delete, old_middle.len()));
        ops.extend(std::iter::repeat_n(Op::Insert, new_middle.len()));
    } else {
        ops.extend(match_middle(old_middle, new_middle));
    }
    ops.extend(std::iter::repeat_n(Op::Equal, suffix));
    ops
}

fn match_middle(old: &[&str], new: &[&str]) -> Vec<Op> {
    let columns = new.len() + 1;
    let mut common = vec![0u32; (old.len() + 1) * columns];
    for left in (0..old.len()).rev() {
        for right in (0..new.len()).rev() {
            common[left * columns + right] = if old[left] == new[right] {
                common[(left + 1) * columns + right + 1] + 1
            } else {
                common[(left + 1) * columns + right].max(common[left * columns + right + 1])
            };
        }
    }

    let mut ops = Vec::new();
    let (mut left, mut right) = (0, 0);
    while left < old.len() && right < new.len() {
        if old[left] == new[right] {
            ops.push(Op::Equal);
            left += 1;
            right += 1;
        // A tie goes to the deletion so a replaced line reads `-old` then
        // `+new` rather than the other way round.
        } else if common[(left + 1) * columns + right] >= common[left * columns + right + 1] {
            ops.push(Op::Delete);
            left += 1;
        } else {
            ops.push(Op::Insert);
            right += 1;
        }
    }
    ops.extend(std::iter::repeat_n(Op::Delete, old.len() - left));
    ops.extend(std::iter::repeat_n(Op::Insert, new.len() - right));
    ops
}

/// Lines without the trailing empty one a final newline produces, so a file
/// ending in a newline is not read as having one more line than it has.
fn split_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    text.strip_suffix('\n')
        .unwrap_or(text)
        .split('\n')
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const CAP: usize = 128 * 1024;

    fn diff(before: &str, after: &str) -> Option<String> {
        unified_diff(before, after, DEFAULT_CONTEXT, CAP)
    }

    #[test]
    fn an_unchanged_file_has_no_diff() {
        assert!(diff("one\ntwo\n", "one\ntwo\n").is_none());
        assert!(diff("", "").is_none());
    }

    // The case Cursor sends: whole-file before and after around a one-line
    // change. Only the changed line and its context may appear, or the chat
    // reports every line of the file as rewritten.
    #[test]
    fn a_one_line_change_in_a_long_file_diffs_only_that_line() {
        let before = (1..=60)
            .map(|n| format!("line {n}"))
            .collect::<Vec<_>>()
            .join("\n");
        let after = before.replace("line 30", "line thirty");
        let diff = diff(&before, &after).expect("a changed file has a diff");
        assert_eq!(
            diff,
            "@@ -27,7 +27,7 @@\n line 27\n line 28\n line 29\n-line 30\n+line thirty\n line 31\n line 32\n line 33"
        );
    }

    #[test]
    fn two_distant_changes_are_two_hunks() {
        let before = (1..=40)
            .map(|n| format!("line {n}"))
            .collect::<Vec<_>>()
            .join("\n");
        let after = before
            .replace("line 5", "five")
            .replace("line 35", "thirty five");
        let diff = diff(&before, &after).expect("diff");
        assert_eq!(diff.matches("@@ ").count(), 2, "{diff}");
        assert!(diff.contains("-line 5\n+five"), "{diff}");
        assert!(diff.contains("-line 35\n+thirty five"), "{diff}");
        assert!(
            !diff.contains("line 20"),
            "untouched lines stay out:\n{diff}"
        );
    }

    #[test]
    fn changes_closer_than_their_context_merge_into_one_hunk() {
        let before = "a\nb\nc\nd\ne\nf\n";
        let after = "A\nb\nc\nd\ne\nF\n";
        let diff = diff(before, after).expect("diff");
        assert_eq!(diff.matches("@@ ").count(), 1, "{diff}");
    }

    #[test]
    fn a_created_file_is_an_all_addition_hunk_from_line_zero() {
        let diff = diff("", "alpha\nbeta\n").expect("diff");
        assert_eq!(diff, "@@ -0,0 +1,2 @@\n+alpha\n+beta");
    }

    #[test]
    fn an_emptied_file_is_an_all_deletion_hunk() {
        let diff = diff("alpha\nbeta\n", "").expect("diff");
        assert_eq!(diff, "@@ -1,2 +0,0 @@\n-alpha\n-beta");
    }

    #[test]
    fn an_insertion_keeps_the_surrounding_lines_as_context() {
        let diff = diff("one\ntwo\n", "one\nmiddle\ntwo\n").expect("diff");
        assert_eq!(diff, "@@ -1,2 +1,3 @@\n one\n+middle\n two");
    }

    #[test]
    fn a_diff_over_the_cap_is_reported_as_no_diff_at_all() {
        let before = (1..=500)
            .map(|n| format!("line {n}"))
            .collect::<Vec<_>>()
            .join("\n");
        let after = (1..=500)
            .map(|n| format!("other {n}"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(unified_diff(&before, &after, DEFAULT_CONTEXT, 256).is_none());
    }

    // Past the match ceiling the two sides are reported as one replaced
    // block. Every line is still accounted for; only the pairing is dropped.
    #[test]
    fn a_rewrite_past_the_match_ceiling_still_accounts_for_every_line() {
        let lines = MAX_MATCH_CELLS / 1000 + 200;
        let before = (0..lines)
            .map(|n| format!("before {n}"))
            .collect::<Vec<_>>()
            .join("\n");
        let after = (0..lines)
            .map(|n| format!("after {n}"))
            .collect::<Vec<_>>()
            .join("\n");
        let diff = unified_diff(&before, &after, DEFAULT_CONTEXT, usize::MAX).expect("diff");
        assert_eq!(
            diff.lines().filter(|line| line.starts_with('-')).count(),
            lines
        );
        assert_eq!(
            diff.lines().filter(|line| line.starts_with('+')).count(),
            lines
        );
    }

    #[test]
    fn a_file_with_no_trailing_newline_is_not_given_an_extra_line() {
        let diff = diff("one\ntwo", "one\ntwo\nthree").expect("diff");
        assert_eq!(diff, "@@ -1,2 +1,3 @@\n one\n two\n+three");
    }

    #[test]
    fn changing_only_the_final_newline_stays_visible() {
        let added = diff("one\ntwo", "one\ntwo\n").expect("diff");
        assert_eq!(added, "@@ -1,2 +1,2 @@\n one\n-two\n+two");

        let removed = diff("one\ntwo\n", "one\ntwo").expect("diff");
        assert_eq!(removed, added);
    }
}
