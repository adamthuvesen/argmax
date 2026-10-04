// Branch names for new isolated workspaces (docs/workspaces.md#branch-name-templates).
//
// A template is literal text plus placeholders. It is validated when saved,
// and a name is rendered locally at launch: no model call, no network. Only a
// workspace created after the template is saved is affected; an existing
// branch keeps the name it was given.

use crate::error::{ArgmaxError, ArgmaxResult, InvalidInputIssue};

/// What a launch gets when neither the project nor the app sets a template.
/// It is the name Argmax has always generated, so an unset template changes
/// nothing.
pub const DEFAULT_BRANCH_TEMPLATE: &str = "argmax/{word}-{id}";

/// What `{type}` renders to. Nothing in a launch classifies the work, and a
/// classifier call would put model latency and spend on chat startup.
pub const DEFAULT_BRANCH_TYPE: &str = "feat";

pub const MAX_BRANCH_TEMPLATE_CHARS: usize = 100;
/// Longest slug a `{slug}` placeholder inserts.
const MAX_SLUG_CHARS: usize = 40;
/// Numeric suffixes tried (`-2`, `-3`, …) before a launch falls back to a name
/// with its random id.
pub const MAX_COLLISION_SUFFIX: u32 = 30;

const PLACEHOLDERS: &[&str] = &["type", "slug", "word", "id", "date"];

/// The values a launch can put into a template.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchNameParts {
    /// Always `feat`. Argmax cannot know the kind of work without a model
    /// call, and naming never waits for one, so `{type}` is a fixed default.
    pub kind: &'static str,
    /// The task label, reduced to a short lowercase slug.
    pub slug: String,
    /// A random word from Argmax's worktree word list.
    pub word: String,
    /// Eight hex characters, unique per launch.
    pub id: String,
    /// UTC `YYYYMMDD`.
    pub date: String,
}

impl BranchNameParts {
    pub fn new(task_label: &str, word: &str, id: &str, date: &str) -> Self {
        let slug = slugify(task_label);
        Self {
            kind: DEFAULT_BRANCH_TYPE,
            // An empty slug (a label of emoji or punctuation) falls back to a
            // name that is still unique and readable.
            slug: if slug.is_empty() {
                word.to_owned()
            } else {
                slug
            },
            word: word.to_owned(),
            id: id.to_owned(),
            date: date.to_owned(),
        }
    }
}

/// The branch to try for `attempt` (0 is the plain render, 1 and up append
/// `-2`, `-3`, …). A template that renders to an invalid Git name falls back
/// to the default, so a launch always gets a usable branch.
pub fn render_branch_name(template: &str, parts: &BranchNameParts, attempt: u32) -> String {
    let suffix = if attempt == 0 {
        String::new()
    } else {
        format!("-{}", attempt + 1)
    };
    with_default_fallback(template, parts, &suffix)
}

fn with_default_fallback(template: &str, parts: &BranchNameParts, suffix: &str) -> String {
    let rendered = format!("{}{suffix}", fill(template, parts));
    if is_valid_branch_name(&rendered) {
        return rendered;
    }
    // A stored template can render to an invalid name for some labels (`a.{slug}`
    // with the label "lock"). Say so, since the user's template was not used.
    tracing::warn!(
        template,
        rendered = %rendered,
        "branch template rendered an invalid name; using the built-in template"
    );
    format!("{}{suffix}", fill(DEFAULT_BRANCH_TEMPLATE, parts))
}

/// One name to try for a new branch, in the order a launch tries them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BranchStep {
    /// The template as rendered (`0`), then `-2`, `-3`, … up to
    /// [`MAX_COLLISION_SUFFIX`].
    Numbered(u32),
    /// The template plus the launch's random id. Unique per launch, so it ends
    /// a run of taken numbered names.
    Unique,
    /// The built-in template, which sits under its own `argmax/` prefix. It is
    /// the way out when the template's prefix is blocked by an existing branch
    /// (a branch `adam/fix` forbids every `adam/fix/…`), where no suffix helps.
    Fallback,
}

impl BranchStep {
    /// Every step in order, `Fallback` last.
    pub fn all() -> Vec<BranchStep> {
        (0..=MAX_COLLISION_SUFFIX)
            .map(BranchStep::Numbered)
            .chain([BranchStep::Unique, BranchStep::Fallback])
            .collect()
    }
}

pub fn render_branch_step(template: &str, parts: &BranchNameParts, step: BranchStep) -> String {
    match step {
        BranchStep::Numbered(attempt) => render_branch_name(template, parts, attempt),
        BranchStep::Unique => with_default_fallback(template, parts, &format!("-{}", parts.id)),
        BranchStep::Fallback => fill(DEFAULT_BRANCH_TEMPLATE, parts),
    }
}

fn fill(template: &str, parts: &BranchNameParts) -> String {
    let mut out = String::with_capacity(template.len() + 24);
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let Some(close) = rest[open..].find('}') else {
            out.push_str(&rest[open..]);
            return out;
        };
        let name = &rest[open + 1..open + close];
        match name {
            "type" => out.push_str(parts.kind),
            "slug" => out.push_str(&parts.slug),
            "word" => out.push_str(&parts.word),
            "id" => out.push_str(&parts.id),
            "date" => out.push_str(&parts.date),
            other => {
                out.push('{');
                out.push_str(other);
                out.push('}');
            }
        }
        rest = &rest[open + close + 1..];
    }
    out.push_str(rest);
    out
}

/// Checks a template before it is stored. Reports the first problem in words a
/// settings form can show.
pub fn validate_branch_template(template: &str) -> ArgmaxResult<()> {
    let reject = |message: String| {
        Err(ArgmaxError::invalid(InvalidInputIssue::at(
            vec!["branchTemplate".to_owned()],
            "BRANCH_TEMPLATE_INVALID",
            message,
        )))
    };
    if template != template.trim() || template.is_empty() {
        return reject("A branch template must not be blank or start or end with spaces.".into());
    }
    if template.chars().count() > MAX_BRANCH_TEMPLATE_CHARS {
        return reject(format!(
            "A branch template has at most {MAX_BRANCH_TEMPLATE_CHARS} characters."
        ));
    }
    let mut rest = template;
    while let Some(open) = rest.find(['{', '}']) {
        if rest.as_bytes()[open] == b'}' {
            return reject("A '}' has no matching '{'.".into());
        }
        let Some(close) = rest[open + 1..].find(['{', '}']) else {
            return reject("A '{' has no matching '}'.".into());
        };
        if rest.as_bytes()[open + 1 + close] == b'{' {
            return reject("A '{' has no matching '}'.".into());
        }
        let name = &rest[open + 1..open + 1 + close];
        if !PLACEHOLDERS.contains(&name) {
            return reject(format!(
                "Unknown placeholder {{{name}}}. Use {}.",
                PLACEHOLDERS
                    .iter()
                    .map(|p| format!("{{{p}}}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        rest = &rest[open + close + 2..];
    }
    // Render with the longest, least friendly values a launch can produce and
    // check the result, so a template that is only invalid for some labels is
    // still caught here.
    let probe = BranchNameParts {
        kind: "feat",
        slug: "x".repeat(MAX_SLUG_CHARS),
        word: "cedar".to_owned(),
        id: "a3f92c18".to_owned(),
        date: "20260101".to_owned(),
    };
    let rendered = fill(template, &probe);
    if !is_valid_branch_name(&rendered) {
        return reject(format!(
            "It would produce '{rendered}', which Git does not accept as a branch name."
        ));
    }
    Ok(())
}

/// `git check-ref-format --branch` for a name that has no `@{-n}` shorthand,
/// without spawning git. Used for validation on save, where nothing is async.
pub fn is_valid_branch_name(name: &str) -> bool {
    // `HEAD` passes the ref-format rules but `git check-ref-format --branch`
    // refuses it, so every launch would fail.
    if name.is_empty()
        || name == "@"
        || name == "HEAD"
        || name.starts_with('-')
        || name.starts_with('/')
    {
        return false;
    }
    if name.ends_with('/') || name.ends_with('.') || name.contains("..") || name.contains("//") {
        return false;
    }
    if name.contains("@{") {
        return false;
    }
    if name
        .chars()
        .any(|c| c.is_control() || c == ' ' || "~^:?*[\\".contains(c))
    {
        return false;
    }
    name.split('/')
        .all(|component| !component.starts_with('.') && !component.ends_with(".lock"))
}

/// The label's words, lowercase, joined with `-`. A word is a run of letters
/// and digits; one with any non-ASCII letter is skipped whole, because keeping
/// its ASCII tail ("ändring" → "ndring") would name the branch after a
/// fragment. A label with no usable word has no slug, and the caller falls back.
fn slugify(label: &str) -> String {
    let mut slug = String::new();
    for word in label
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty() && word.is_ascii())
    {
        let separator = usize::from(!slug.is_empty());
        if slug.len() + separator + word.len() > MAX_SLUG_CHARS {
            // Cut at a word boundary. A single word longer than the limit is
            // truncated, because a slug with nothing in it names nothing.
            if slug.is_empty() {
                slug.push_str(&word[..MAX_SLUG_CHARS.min(word.len())].to_ascii_lowercase());
            }
            break;
        }
        if separator == 1 {
            slug.push('-');
        }
        slug.push_str(&word.to_ascii_lowercase());
    }
    slug
}

#[cfg(test)]
mod tests {
    use super::*;

    fn invalid_message(error: ArgmaxError) -> String {
        match error {
            ArgmaxError::InvalidInput { issues } => issues[0].message.clone(),
            other => panic!("expected invalid input, got {other:?}"),
        }
    }

    fn parts(label: &str) -> BranchNameParts {
        BranchNameParts::new(label, "cedar", "a3f92c18", "20261004")
    }

    #[test]
    fn default_template_matches_the_historic_name() {
        assert_eq!(
            render_branch_name(DEFAULT_BRANCH_TEMPLATE, &parts("anything"), 0),
            "argmax/cedar-a3f92c18"
        );
    }

    #[test]
    fn renders_type_and_slug_from_the_task_label() {
        // `{type}` is a fixed default: nothing classifies the label.
        let name = render_branch_name(
            "adam/{type}-{slug}",
            &parts("Fix the login redirect loop!"),
            0,
        );
        assert_eq!(name, "adam/feat-fix-the-login-redirect-loop");
        assert_eq!(
            render_branch_name("adam/{type}-{slug}", &parts("Add a billing page"), 0),
            "adam/feat-add-a-billing-page"
        );
    }

    #[test]
    fn collisions_get_a_stable_numeric_suffix() {
        let p = parts("Add a billing page");
        assert_eq!(
            render_branch_name("adam/{slug}", &p, 1),
            "adam/add-a-billing-page-2"
        );
        assert_eq!(
            render_branch_name("adam/{slug}", &p, 2),
            "adam/add-a-billing-page-3"
        );
    }

    #[test]
    fn a_word_with_non_ascii_letters_is_skipped_whole() {
        assert_eq!(parts("Fixa ändring i login").slug, "fixa-i-login");
        assert_eq!(parts("naïve cache").slug, "cache");
        // Nothing usable left: the slug is the random word.
        assert_eq!(parts("ändring").slug, "cedar");
    }

    #[test]
    fn steps_run_numbered_then_unique_then_the_builtin_fallback() {
        let p = parts("Fix CI");
        let steps = BranchStep::all();
        assert_eq!(steps.first(), Some(&BranchStep::Numbered(0)));
        assert_eq!(steps[steps.len() - 2], BranchStep::Unique);
        assert_eq!(steps.last(), Some(&BranchStep::Fallback));
        let render = |step| render_branch_step("adam/{slug}", &p, step);
        assert_eq!(render(BranchStep::Numbered(0)), "adam/fix-ci");
        assert_eq!(render(BranchStep::Numbered(1)), "adam/fix-ci-2");
        // Unique appends the launch's random id, so it never repeats a numbered name.
        assert_eq!(render(BranchStep::Unique), "adam/fix-ci-a3f92c18");
        // Fallback leaves the template's prefix, which a parent branch may block.
        assert_eq!(render(BranchStep::Fallback), "argmax/cedar-a3f92c18");
    }

    #[test]
    fn unusable_labels_still_yield_a_valid_unique_name() {
        let name = render_branch_name("adam/{slug}", &parts("🚀✨"), 0);
        assert_eq!(name, "adam/cedar");
        assert!(is_valid_branch_name(&name));
        // A long label is cut at a word boundary under the slug limit.
        let long = "implement the extremely long and descriptive task label that goes on";
        let slug = parts(long).slug;
        assert!(
            slug.len() <= MAX_SLUG_CHARS && !slug.ends_with('-'),
            "{slug}"
        );
    }

    #[test]
    fn an_invalid_render_falls_back_to_the_default_template() {
        // A stored template that is bad (edited by hand, or from an older
        // build) never blocks a launch.
        assert_eq!(
            render_branch_name("bad..name/{id}", &parts("x"), 0),
            "argmax/cedar-a3f92c18"
        );
    }

    #[test]
    fn validation_accepts_supported_placeholders() {
        for ok in [
            "adam/{type}-{slug}",
            "argmax/{word}-{id}",
            "{date}/{slug}",
            "work/{type}/{slug}-{id}",
        ] {
            assert!(validate_branch_template(ok).is_ok(), "{ok}");
        }
    }

    #[test]
    fn validation_rejects_bad_templates_with_a_reason() {
        let cases = [
            ("", "blank"),
            (" adam/{slug}", "spaces"),
            ("adam/{nope}", "Unknown placeholder {nope}"),
            ("adam/{slug", "no matching '}'"),
            ("adam/slug}", "no matching '{'"),
            ("adam/{slug}{", "no matching '}'"),
            ("-adam/{slug}", "does not accept"),
            ("adam//{slug}", "does not accept"),
            ("adam/{slug}.", "does not accept"),
            ("adam/.{slug}", "does not accept"),
            ("adam/{slug}.lock", "does not accept"),
            ("adam/a..b-{slug}", "does not accept"),
            ("adam/a b-{slug}", "does not accept"),
            ("adam/{slug}~", "does not accept"),
        ];
        for (template, needle) in cases {
            let message = invalid_message(validate_branch_template(template).expect_err(template));
            assert!(message.contains(needle), "{template}: {message}");
        }
        let too_long = "a".repeat(MAX_BRANCH_TEMPLATE_CHARS + 1);
        assert!(validate_branch_template(&too_long).is_err());
    }

    #[test]
    fn git_agrees_with_the_local_branch_name_check() {
        // The local rules stand in for `git check-ref-format --branch` on save.
        // Pin them against the real thing for the cases that matter.
        let names = [
            "adam/feat-x",
            "HEAD",
            "a",
            "a/b/c",
            "a.b",
            "a-b_c",
            "adam/.hidden",
            "a..b",
            "a b",
            "a~",
            "a^",
            "a:b",
            "a?",
            "a*",
            "a[",
            "a\\b",
            "a//b",
            "/a",
            "a/",
            "a.",
            "a.lock",
            "x/a.lock",
            "a@{b",
            "-a",
        ];
        for name in names {
            let git = std::process::Command::new("git")
                .args(["check-ref-format", "--branch", name])
                .output()
                .map(|out| out.status.success())
                .unwrap_or(false);
            assert_eq!(is_valid_branch_name(name), git, "{name}");
        }
    }
}
