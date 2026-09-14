use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;

#[derive(Debug)]
struct Token {
    text: String,
    quoted: bool,
}

#[derive(Debug)]
struct Heredoc {
    delimiter: String,
    strip_tabs: bool,
    /// The body is a Python program read from stdin, not opaque data.
    python: bool,
}

/// Returns the files a shell command writes through a heredoc.
///
/// Two shapes count. `cat > path <<'EOF'` names its target in the shell. A
/// `python3 - <<'PY'` body is a program, and rewriting a file through one is
/// how an agent edits when it has a shell and no edit tool, so a body that
/// calls a write with a literal path reports that path. Every other heredoc
/// body stays opaque, and a computed path yields an edit with no target rather
/// than a guessed one.
///
/// `Some(vec![])` therefore means a write happened whose target we cannot name.
/// A line this does not model ends the scan instead of voiding it: a later
/// build step cannot un-write the file a earlier line already wrote.
pub(super) fn file_write_targets(command: &str) -> Option<Vec<String>> {
    if !command.contains("<<") {
        return None;
    }
    let lines: Vec<&str> = command.lines().collect();
    let mut line_index = 0;
    let mut directory: Option<String> = None;
    let mut saw_non_cd_command = false;
    let mut targets = Vec::new();
    let mut wrote = false;

    'lines: while line_index < lines.len() {
        let Some(tokens) = shell_tokens(lines[line_index].trim_end_matches('\r')) else {
            break;
        };
        if reject_unsupported_syntax(&tokens).is_none() {
            break;
        }

        if tokens.first().is_some_and(|token| token.text == "cd") {
            if saw_non_cd_command
                || tokens.len() < 4
                || tokens[2].text != "&&"
                || tokens[2].quoted
                || !is_literal_directory(&tokens[1].text)
            {
                break;
            }
            directory = Some(qualify_path(directory.as_deref(), &tokens[1].text));
        }

        for segment in command_segments(&tokens) {
            if segment.is_empty() {
                continue;
            }

            if segment[0].text == "cd" {
                if segment.as_ptr() != tokens.as_ptr() || segment.len() != 2 {
                    break 'lines;
                }
                continue;
            }

            saw_non_cd_command = true;
            if segment[0].text != "cat" || !has_quoted_heredoc(segment) {
                continue;
            }

            let Some(redirects) = redirected_output_targets(segment) else {
                break 'lines;
            };
            for target in redirects {
                if target == "/dev/null" {
                    continue;
                }
                wrote = true;
                push_target(&mut targets, directory.as_deref(), &target);
            }
        }

        let Some(heredocs) = heredocs(&tokens) else {
            break;
        };
        line_index += 1;
        for heredoc in heredocs {
            let mut body = String::new();
            let mut found_delimiter = false;
            while line_index < lines.len() {
                let line = lines[line_index].trim_end_matches('\r');
                let candidate = if heredoc.strip_tabs {
                    line.trim_start_matches('\t')
                } else {
                    line
                };
                line_index += 1;
                if candidate == heredoc.delimiter {
                    found_delimiter = true;
                    break;
                }
                if heredoc.python {
                    body.push_str(candidate);
                    body.push('\n');
                }
            }
            // An unterminated heredoc means the rest of these "lines" are body
            // content, so nothing read so far is trustworthy.
            if !found_delimiter {
                return None;
            }
            if let Some(written) = heredoc
                .python
                .then(|| python_write_targets(&body))
                .flatten()
            {
                wrote = true;
                for target in written {
                    push_target(&mut targets, directory.as_deref(), &target);
                }
            }
        }
    }

    wrote.then_some(targets)
}

fn push_target(targets: &mut Vec<String>, directory: Option<&str>, target: &str) {
    let target = qualify_path(directory, target);
    if !targets.contains(&target) {
        targets.push(target);
    }
}

fn reject_unsupported_syntax(tokens: &[Token]) -> Option<()> {
    const UNSUPPORTED_COMMANDS: &[&str] = &[
        "break", "case", "continue", "do", "done", "elif", "else", "esac", "exit", "fi", "for",
        "function", "if", "return", "select", "then", "until", "while",
    ];

    if tokens
        .iter()
        .any(|token| token.text == "||" && !token.quoted)
    {
        return None;
    }

    for segment in command_segments(tokens) {
        let Some(command) = segment.first() else {
            continue;
        };
        if UNSUPPORTED_COMMANDS.contains(&command.text.as_str()) {
            return None;
        }
        if segment.iter().any(|token| {
            !token.quoted
                && (token.text == "{"
                    || token.text == "}"
                    || token.text.contains("()")
                    || token.text.starts_with('(')
                    || token.text.ends_with(')'))
        }) {
            return None;
        }
    }
    Some(())
}

fn command_segments(tokens: &[Token]) -> impl Iterator<Item = &[Token]> {
    tokens.split(|token| !token.quoted && matches!(token.text.as_str(), ";" | "&&" | "|" | "&"))
}

fn has_quoted_heredoc(tokens: &[Token]) -> bool {
    tokens
        .windows(2)
        .any(|pair| pair[0].text == "<<" && !pair[0].quoted && pair[1].quoted)
}

fn redirected_output_targets(tokens: &[Token]) -> Option<Vec<String>> {
    let mut targets = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        if !tokens[index].quoted && matches!(tokens[index].text.as_str(), ">" | ">>") {
            // `2>&1` duplicates a file descriptor. The tokenizer splits `>&`
            // into two tokens, so the `&` and the fd number after it would
            // otherwise read as a literal path named "&".
            if tokens
                .get(index + 1)
                .is_some_and(|t| !t.quoted && t.text == "&")
            {
                index += 3;
                continue;
            }
            let target = tokens.get(index + 1)?;
            if !is_literal_path(&target.text) || (target.text.starts_with('~') && target.quoted) {
                return None;
            }
            targets.push(target.text.clone());
            index += 2;
        } else {
            index += 1;
        }
    }
    Some(targets)
}

/// Every heredoc on the line, in the order the shell consumes their bodies.
/// Walking the segments rather than the raw tokens is what lets a body be
/// attributed to the command that reads it.
fn heredocs(tokens: &[Token]) -> Option<Vec<Heredoc>> {
    let mut heredocs = Vec::new();
    for segment in command_segments(tokens) {
        let python = is_stdin_python(segment);
        let mut index = 0;
        while index < segment.len() {
            let strip_tabs = segment[index].text == "<<-" && !segment[index].quoted;
            if (segment[index].text == "<<" && !segment[index].quoted) || strip_tabs {
                let delimiter = segment.get(index + 1)?;
                if delimiter.text.is_empty() {
                    return None;
                }
                heredocs.push(Heredoc {
                    delimiter: delimiter.text.clone(),
                    strip_tabs,
                    // An unquoted delimiter lets the shell expand the body, so
                    // the text we would read is not the program that ran.
                    python: python && delimiter.quoted,
                });
                index += 2;
            } else {
                index += 1;
            }
        }
    }
    Some(heredocs)
}

/// True for `python3 - <<'PY'`, where the heredoc is the program. A script
/// argument (`python3 render.py <<'DATA'`) makes the body data instead, and
/// its writes belong to a file we never saw.
fn is_stdin_python(segment: &[Token]) -> bool {
    let Some(command) = segment.first() else {
        return false;
    };
    if command.quoted {
        return false;
    }
    let name = command.text.rsplit('/').next().unwrap_or(&command.text);
    if name != "python" && !name.starts_with("python3") {
        return false;
    }
    segment[1..]
        .iter()
        .take_while(|token| !matches!(token.text.as_str(), "<<" | "<<-"))
        .all(|token| !token.quoted && (token.text == "-" || token.text.starts_with('-')))
}

/// A write call in a Python program, paired with the path it names when that
/// path is a literal. The capture is the path expression.
static PYTHON_WRITE_CALLS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![
        // open(p, "w"), open("a.rs", "a"), with open(p, "wb") as handle
        Regex::new(r#"open\(\s*([^,()]+?)\s*,\s*['"][wax]"#).expect("literal pattern"),
        // Path("a.rs").write_text(…), target.write_bytes(…)
        Regex::new(r#"Path\(\s*([^(),]+?)\s*\)\s*\.\s*write_(?:text|bytes)\("#)
            .expect("literal pattern"),
        Regex::new(r"(\w+)\s*\.\s*write_(?:text|bytes)\(").expect("literal pattern"),
        // os.replace(src, dst), Path(p).unlink(), shutil.move(a, b)
        Regex::new(r"os\s*\.\s*(?:replace|rename|remove|unlink)\(\s*([^,()]*?)\s*[,)]")
            .expect("literal pattern"),
        Regex::new(r"shutil\s*\.\s*(?:copy2?|copyfile|move|rmtree)\(\s*([^,()]*?)\s*[,)]")
            .expect("literal pattern"),
        Regex::new(r"Path\(\s*([^(),]+?)\s*\)\s*\.\s*unlink\(").expect("literal pattern"),
    ]
});

/// `name = "literal"` or `name = Path("literal")`, the two forms that let a
/// later `open(p, "w")` or `p.write_text(…)` name the file it changed.
static PYTHON_PATH_ASSIGNMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?m)(?:^|;)\s*(\w+)\s*=\s*(?:pathlib\s*\.\s*)?(?:Path\(\s*)?['"]([^'"]*)['"]"#)
        .expect("literal pattern")
});

/// The files a Python program writes, or `None` when it only reads.
///
/// This reads source without running it, so it claims a path only when the
/// path is a literal at the call or in the single assignment to the name the
/// call uses. Anything else is a write with no target.
fn python_write_targets(body: &str) -> Option<Vec<String>> {
    // `p = "a.swift"; … open(p, "w") … p = "b.swift"; … open(p, "w")` is one
    // script editing two files, so a name resolves to its latest assignment
    // above the call rather than to the whole body's worth of values.
    let assignments = PYTHON_PATH_ASSIGNMENT
        .captures_iter(body)
        .filter_map(|capture| {
            let name = capture.get(1)?;
            let value = capture.get(2)?;
            Some((name.start(), name.as_str(), value.as_str()))
        })
        .collect::<Vec<_>>();

    let mut wrote = false;
    let mut targets = Vec::new();
    for pattern in PYTHON_WRITE_CALLS.iter() {
        for capture in pattern.captures_iter(body) {
            let call = capture.get(0).map_or(0, |group| group.start());
            let expression = capture.get(1).map(|group| group.as_str().trim());
            // `sys.stdout.write` is the program talking, not a file change.
            if expression.is_some_and(|expression| expression.starts_with("sys.")) {
                continue;
            }
            wrote = true;
            let Some(target) = expression.and_then(|expression| {
                literal_string(expression).or_else(|| {
                    assignments
                        .iter()
                        .rev()
                        .find(|(offset, name, _)| *name == expression && *offset < call)
                        .map(|(_, _, value)| *value)
                })
            }) else {
                continue;
            };
            if target.is_empty() || target == "/dev/null" || !is_literal_path(target) {
                continue;
            }
            let target = target.to_owned();
            if !targets.contains(&target) {
                targets.push(target);
            }
        }
    }
    wrote.then_some(targets)
}

fn literal_string(expression: &str) -> Option<&str> {
    let quote = expression.chars().next()?;
    if quote != '\'' && quote != '"' {
        return None;
    }
    expression
        .strip_prefix(quote)
        .and_then(|rest| rest.strip_suffix(quote))
        .filter(|value| !value.contains(quote))
}

fn qualify_path(directory: Option<&str>, target: &str) -> String {
    if Path::new(target).is_absolute() || target.starts_with('~') {
        return target.to_owned();
    }
    directory
        .map(|directory| PathBuf::from(directory).join(target))
        .unwrap_or_else(|| PathBuf::from(target))
        .to_string_lossy()
        .into_owned()
}

fn is_literal_path(value: &str) -> bool {
    !value.is_empty()
        && value != "-"
        && !value
            .chars()
            .any(|character| matches!(character, '$' | '*' | '?' | '[' | ']' | '{' | '}'))
}

fn is_literal_directory(value: &str) -> bool {
    !value.starts_with('~') && is_literal_path(value)
}

fn shell_tokens(line: &str) -> Option<Vec<Token>> {
    let characters: Vec<char> = line.chars().collect();
    let mut tokens = Vec::new();
    let mut text = String::new();
    let mut quoted = false;
    let mut quote = None;
    let mut index = 0;

    while index < characters.len() {
        let character = characters[index];
        if let Some(active_quote) = quote {
            if character == active_quote {
                quote = None;
                quoted = true;
                index += 1;
                continue;
            }
            if active_quote == '"' && character == '\\' {
                index += 1;
                text.push(*characters.get(index)?);
                index += 1;
                continue;
            }
            if active_quote == '"' && is_substitution_start(&characters, index) {
                return None;
            }
            text.push(character);
            index += 1;
            continue;
        }

        if character == '\'' || character == '"' {
            quote = Some(character);
            quoted = true;
            index += 1;
            continue;
        }
        if character == '\\' {
            index += 1;
            text.push(*characters.get(index)?);
            quoted = true;
            index += 1;
            continue;
        }
        if is_substitution_start(&characters, index) {
            return None;
        }
        if character.is_whitespace() {
            push_token(&mut tokens, &mut text, &mut quoted);
            index += 1;
            continue;
        }
        if character == '#' && text.is_empty() {
            break;
        }
        if let Some(operator) = shell_operator(&characters, index) {
            push_token(&mut tokens, &mut text, &mut quoted);
            tokens.push(Token {
                text: operator.to_owned(),
                quoted: false,
            });
            index += operator.chars().count();
            continue;
        }

        text.push(character);
        index += 1;
    }

    if quote.is_some() {
        return None;
    }
    push_token(&mut tokens, &mut text, &mut quoted);
    Some(tokens)
}

fn is_substitution_start(characters: &[char], index: usize) -> bool {
    characters[index] == '`'
        || (characters[index] == '$' && characters.get(index + 1) == Some(&'('))
        || (matches!(characters[index], '<' | '>') && characters.get(index + 1) == Some(&'('))
}

fn shell_operator(characters: &[char], index: usize) -> Option<&'static str> {
    let first = characters[index];
    let second = characters.get(index + 1).copied();
    let third = characters.get(index + 2).copied();
    match (first, second, third) {
        ('<', Some('<'), Some('-')) => Some("<<-"),
        ('<', Some('<'), _) => Some("<<"),
        ('>', Some('>'), _) => Some(">>"),
        ('&', Some('&'), _) => Some("&&"),
        ('|', Some('|'), _) => Some("||"),
        ('>', _, _) => Some(">"),
        (';', _, _) => Some(";"),
        ('|', _, _) => Some("|"),
        ('&', _, _) => Some("&"),
        _ => None,
    }
}

fn push_token(tokens: &mut Vec<Token>, text: &mut String, quoted: &mut bool) {
    if text.is_empty() && !*quoted {
        return;
    }
    tokens.push(Token {
        text: std::mem::take(text),
        quoted: *quoted,
    });
    *quoted = false;
}

#[cfg(test)]
mod tests {
    use super::file_write_targets;

    #[test]
    fn reads_both_a_python_rewrite_and_the_cat_write_after_it() {
        let command = r#"cd ios/Argmax && python3 - <<'EOF'
p="Sources/Chats/ChatRowGlyph.swift"
s=open(p).read()
open(p,"w").write(s.replace("old", "new"))
EOF
cat > Tests/ScratchChatRowShotTests.swift <<'EOF'
import XCTest
// cat > fake.swift <<'EOF'
EOF
grep -n 'Brain' Sources/Design/SessionIcon.swift | head -3; xcodegen >/dev/null 2>&1 && xcodebuild > /tmp/ios-shot.log 2>&1; echo "exit $?"
"#;

        assert_eq!(
            file_write_targets(command),
            Some(vec![
                "ios/Argmax/Sources/Chats/ChatRowGlyph.swift".to_owned(),
                "ios/Argmax/Tests/ScratchChatRowShotTests.swift".to_owned()
            ])
        );
    }

    #[test]
    fn finds_cat_write_after_mkdir_and_ignores_unknown_followups() {
        let command = r#"mkdir -p docs/design/chat-list-glyphs && cat > docs/design/chat-list-glyphs/index.html <<'EOF'
<main>Preview</main>
EOF
npm run dev -- --host 127.0.0.1 | tee /tmp/vite.log
"#;

        assert_eq!(
            file_write_targets(command),
            Some(vec!["docs/design/chat-list-glyphs/index.html".to_owned()])
        );
    }

    #[test]
    fn supports_append_and_quoted_literal_paths() {
        let command = "cat >> 'notes/working copy.md' <<\"END\"\nhello\nEND";

        assert_eq!(
            file_write_targets(command),
            Some(vec!["notes/working copy.md".to_owned()])
        );
    }

    #[test]
    fn does_not_apply_cd_prefix_to_tilde_target() {
        let command = "cd workspace && cat > ~/notes.md <<'EOF'\nhello\nEOF";

        assert_eq!(
            file_write_targets(command),
            Some(vec!["~/notes.md".to_owned()])
        );
    }

    #[test]
    fn rejects_quoted_tilde_target() {
        let command = "cd workspace && cat > '~/notes.md' <<'EOF'\nhello\nEOF";

        assert_eq!(file_write_targets(command), None);
    }

    #[test]
    fn a_python_body_reports_the_files_it_rewrites() {
        let by_name = "cd ios/Argmax && python3 - <<'PY'\np = pathlib.Path(\"Sources/Theme.swift\")\ns = p.read_text()\np.write_text(s.replace(old, new))\nPY";
        assert_eq!(
            file_write_targets(by_name),
            Some(vec!["ios/Argmax/Sources/Theme.swift".to_owned()])
        );

        // One script, two files: a name resolves to its latest assignment.
        let two_files = "python3 - <<'PY'\np=\"a.swift\"; s=open(p).read()\nopen(p,\"w\").write(s)\np=\"b.swift\"; s=open(p).read()\nopen(p,\"w\").write(s)\nPY";
        assert_eq!(
            file_write_targets(two_files),
            Some(vec!["a.swift".to_owned(), "b.swift".to_owned()])
        );

        let computed =
            "python3 - <<'PY'\nfor path in sys.argv:\n    open(path, \"w\").write(\"\")\nPY";
        assert_eq!(file_write_targets(computed), Some(Vec::new()));

        for read_only in [
            "python3 - <<'PY'\nprint(open(\"a.swift\").read())\nPY",
            // Printing is the program talking, not a file change.
            "python3 - <<'PY'\nsys.stdout.write(open(\"a.swift\").read())\nPY",
            // The heredoc is data for a script, not the program.
            "python3 render.py <<'DATA'\nopen(\"a.swift\", \"w\").write(\"x\")\nDATA",
            // An unquoted delimiter lets the shell rewrite the body first.
            "python3 - <<PY\nopen(\"a.swift\", \"w\").write(\"x\")\nPY",
            // Another interpreter's body stays opaque.
            "ruby - <<'RB'\nFile.write(\"a.swift\", \"x\")\nRB",
        ] {
            assert_eq!(file_write_targets(read_only), None, "{read_only}");
        }
    }

    #[test]
    fn never_scans_an_opaque_heredoc_body() {
        let command = r#"python3 - <<'PY'
print("cat > fake.txt <<'EOF'")
cat > also-fake.txt <<'EOF'
PY"#;

        assert_eq!(file_write_targets(command), None);
    }

    #[test]
    fn ignores_comments_and_quoted_examples() {
        let command = r#"# cat > comment.txt <<'EOF'
printf '%s\n' "cat > example.txt <<'EOF'"
"#;

        assert_eq!(file_write_targets(command), None);
    }

    #[test]
    fn quoted_operator_text_is_never_shell_syntax() {
        let command = "cat '>' result.txt '<<' 'EOF'\nEOF";
        let quoted_and = "cd workspace '&&' cat > result.txt <<'EOF'\nvalue\nEOF";

        assert_eq!(file_write_targets(command), None);
        assert_eq!(file_write_targets(quoted_and), None);
    }

    #[test]
    fn escaped_operator_text_is_never_shell_syntax() {
        let command = "cat \\> result.txt \\<\\< EOF\nEOF";
        let escaped_and = "cd workspace \\&\\& cat > result.txt <<'EOF'\nvalue\nEOF";

        assert_eq!(file_write_targets(command), None);
        assert_eq!(file_write_targets(escaped_and), None);
    }

    #[test]
    fn rejects_control_flow_and_functions() {
        let conditional = "if true; then\ncat > result.txt <<'EOF'\nvalue\nEOF\nfi";
        let function = "write_file() {\ncat > result.txt <<'EOF'\nvalue\nEOF\n}";

        assert_eq!(file_write_targets(conditional), None);
        assert_eq!(file_write_targets(function), None);
    }

    #[test]
    fn rejects_command_and_process_substitutions() {
        let command_substitution = "echo $(date); cat > result.txt <<'EOF'\nvalue\nEOF";
        let process_substitution = "diff <(old) <(new); cat > result.txt <<'EOF'\nvalue\nEOF";

        assert_eq!(file_write_targets(command_substitution), None);
        assert_eq!(file_write_targets(process_substitution), None);
    }

    #[test]
    fn rejects_early_exit_and_missing_delimiter() {
        let early_exit = "exit 0; cat > result.txt <<'EOF'\nvalue\nEOF";
        let conditional_exit = "cat > result.txt <<'EOF' || exit 1\nvalue\nEOF";
        let missing_delimiter = "cat > result.txt <<'EOF'\nvalue";

        assert_eq!(file_write_targets(early_exit), None);
        assert_eq!(file_write_targets(conditional_exit), None);
        assert_eq!(file_write_targets(missing_delimiter), None);
    }

    #[test]
    fn only_adopts_a_leading_cd_joined_with_and() {
        let semicolon = "cd workspace; cat > result.txt <<'EOF'\nvalue\nEOF";
        let newline = "cd workspace\ncat > result.txt <<'EOF'\nvalue\nEOF";

        assert_eq!(file_write_targets(semicolon), None);
        assert_eq!(file_write_targets(newline), None);
    }

    #[test]
    fn requires_quoted_delimiter_and_literal_non_null_target() {
        let unquoted_delimiter = "cat > result.txt <<EOF\nvalue\nEOF";
        let dynamic_target = "cat > $output <<'EOF'\nvalue\nEOF";
        let null_target = "cat > /dev/null <<'EOF'\nvalue\nEOF";

        assert_eq!(file_write_targets(unquoted_delimiter), None);
        assert_eq!(file_write_targets(dynamic_target), None);
        assert_eq!(file_write_targets(null_target), None);
    }
}
