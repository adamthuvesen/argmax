use std::path::{Path, PathBuf};

#[derive(Debug)]
struct Token {
    text: String,
    quoted: bool,
}

#[derive(Debug)]
struct Heredoc {
    delimiter: String,
    strip_tabs: bool,
}

/// Returns literal files written by explicit, top-level `cat` heredocs.
///
/// Heredoc bodies are deliberately opaque. In particular, this does not try to
/// infer writes made by Python, Perl, or another interpreter embedded in one.
pub(super) fn file_write_targets(command: &str) -> Option<Vec<String>> {
    if !command.contains("<<") {
        return None;
    }
    let lines: Vec<&str> = command.lines().collect();
    let mut line_index = 0;
    let mut directory: Option<String> = None;
    let mut saw_non_cd_command = false;
    let mut targets = Vec::new();

    while line_index < lines.len() {
        let tokens = shell_tokens(lines[line_index].trim_end_matches('\r'))?;
        reject_unsupported_syntax(&tokens)?;

        if tokens.first().is_some_and(|token| token.text == "cd") {
            if saw_non_cd_command
                || tokens.len() < 4
                || tokens[2].text != "&&"
                || tokens[2].quoted
                || !is_literal_directory(&tokens[1].text)
            {
                return None;
            }
            directory = Some(qualify_path(directory.as_deref(), &tokens[1].text));
        }

        for segment in command_segments(&tokens) {
            if segment.is_empty() {
                continue;
            }

            if segment[0].text == "cd" {
                if segment.as_ptr() != tokens.as_ptr() || segment.len() != 2 {
                    return None;
                }
                continue;
            }

            saw_non_cd_command = true;
            if segment[0].text != "cat" || !has_quoted_heredoc(segment) {
                continue;
            }

            for target in redirected_output_targets(segment)? {
                if target == "/dev/null" {
                    continue;
                }
                let target = qualify_path(directory.as_deref(), &target);
                if !targets.contains(&target) {
                    targets.push(target);
                }
            }
        }

        let heredocs = heredocs(&tokens)?;
        line_index += 1;
        for heredoc in heredocs {
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
            }
            if !found_delimiter {
                return None;
            }
        }
    }

    (!targets.is_empty()).then_some(targets)
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

fn heredocs(tokens: &[Token]) -> Option<Vec<Heredoc>> {
    let mut heredocs = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        let strip_tabs = tokens[index].text == "<<-" && !tokens[index].quoted;
        if (tokens[index].text == "<<" && !tokens[index].quoted) || strip_tabs {
            let delimiter = tokens.get(index + 1)?;
            if delimiter.text.is_empty() {
                return None;
            }
            heredocs.push(Heredoc {
                delimiter: delimiter.text.clone(),
                strip_tabs,
            });
            index += 2;
        } else {
            index += 1;
        }
    }
    Some(heredocs)
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
    fn finds_literal_cat_write_after_opaque_python_heredoc() {
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
