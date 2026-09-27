use crate::util::sync::LockOrRecover;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::Serialize;
use specta::Type;

use crate::ipc::validation::ProviderId;

pub const SKILL_FILE_SIZE_CAP_BYTES: u64 = 262_144;

/// How long a listing stays cached. The registry now lives for the whole
/// process, so an unbounded cache would hide a skill the user adds while
/// Argmax is running until the next restart. Slash autocomplete asks on every
/// `/` keystroke and each miss walks three skill trees synchronously, so the
/// window only has to outlast a burst of typing.
const CACHE_TTL: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum SkillSource {
    User,
    Workspace,
    CodexPrompt,
    Plugin,
    System,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    pub name: String,
    pub description: String,
    pub source: SkillSource,
}

/// Internal routing input. The public `/` menu still receives only summaries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillInstructions {
    pub name: String,
    pub text: String,
    pub complete: bool,
}

#[derive(Debug, Clone)]
struct DiscoveredSkill {
    summary: SkillSummary,
    path: PathBuf,
}

#[derive(Debug)]
pub struct SkillRegistry {
    home_dir: PathBuf,
    cache: Mutex<BTreeMap<String, (Instant, Vec<DiscoveredSkill>)>>,
}

impl SkillRegistry {
    pub fn from_env() -> Self {
        let home_dir = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        Self::new(home_dir)
    }

    pub fn new(home_dir: impl AsRef<Path>) -> Self {
        Self {
            home_dir: home_dir.as_ref().to_path_buf(),
            cache: Mutex::new(BTreeMap::new()),
        }
    }

    pub fn clear_cache(&self) {
        self.cache.lock_or_recover("skills cache").clear();
    }

    pub fn list_skills(
        &self,
        provider: ProviderId,
        workspace_cwd: Option<&Path>,
    ) -> Vec<SkillSummary> {
        self.discover_skills(provider, workspace_cwd)
            .into_iter().map(|skill| skill.summary).collect()
    }

    fn discover_skills(
        &self,
        provider: ProviderId,
        workspace_cwd: Option<&Path>,
    ) -> Vec<DiscoveredSkill> {
        let cache_key = format!(
            "{provider:?}::{}",
            workspace_cwd
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_default()
        );
        if let Some((stored_at, cached)) = self
            .cache
            .lock_or_recover("skills cache")
            .get(&cache_key)
            .cloned()
        {
            if stored_at.elapsed() < CACHE_TTL {
                return cached;
            }
        }

        let mut collected = BTreeMap::<String, DiscoveredSkill>::new();
        for source in self.resolve_sources(provider, workspace_cwd) {
            for skill in load_source(&source) {
                collected
                    .entry(skill.summary.name.to_ascii_lowercase())
                    .or_insert(skill);
            }
        }
        let result = collected.into_values().collect::<Vec<_>>();
        self.cache
            .lock_or_recover("skills cache")
            .insert(cache_key, (Instant::now(), result.clone()));
        result
    }

    /// Reads only explicitly invoked names, using the same source order and
    /// first-wins discovery as autocomplete. Missing names stay visible to the
    /// caller so they cannot be mistaken for a simple task.
    pub fn invoked_instructions(
        &self,
        provider: ProviderId,
        workspace_cwd: Option<&Path>,
        names: &[String],
        max_chars: usize,
    ) -> Vec<SkillInstructions> {
        let mut wanted = names.iter().map(|name| name.to_ascii_lowercase()).collect::<Vec<_>>();
        wanted.sort();
        wanted.dedup();
        let mut found = BTreeMap::<String, SkillInstructions>::new();
        for skill in self.discover_skills(provider, workspace_cwd) {
            let key = skill.summary.name.to_ascii_lowercase();
            if !wanted.contains(&key) || found.contains_key(&key) {
                continue;
            }
            if !fs::metadata(&skill.path).ok().is_some_and(|metadata| metadata.len() <= SKILL_FILE_SIZE_CAP_BYTES) {
                continue;
            }
            let Some(text) = fs::read_to_string(&skill.path).ok() else {
                continue;
            };
            let (text, complete) = bounded_instructions(&skill.path, &text, max_chars);
            found.insert(key, SkillInstructions { name: skill.summary.name, text, complete });
        }
        names.iter().map(|name| {
            found.get(&name.to_ascii_lowercase()).cloned().unwrap_or_else(|| SkillInstructions {
                name: name.clone(), text: String::new(), complete: false,
            })
        }).collect()
    }

    fn resolve_sources(
        &self,
        provider: ProviderId,
        workspace_cwd: Option<&Path>,
    ) -> Vec<SourceDescriptor> {
        let mut sources = Vec::new();
        match provider {
            ProviderId::Claude => {
                if let Some(workspace) = workspace_cwd {
                    sources.push(SourceDescriptor::skill_dir(
                        workspace.join(".claude/skills"),
                        SkillSource::Workspace,
                    ));
                    sources.push(Self::workspace_agents_skills(workspace));
                }
                sources.push(
                    SourceDescriptor::skill_dir(
                        self.home_dir.join(".claude/skills"),
                        SkillSource::User,
                    )
                    .exclude_dot_dirs(),
                );
                sources.push(self.user_agents_skills());
                sources.push(SourceDescriptor::plugin_cache(
                    self.home_dir.join(".claude/plugins/cache"),
                    SkillSource::Plugin,
                ));
            }
            ProviderId::Codex => {
                if let Some(workspace) = workspace_cwd {
                    sources.push(SourceDescriptor::skill_dir(
                        workspace.join(".codex/skills"),
                        SkillSource::Workspace,
                    ));
                    sources.push(Self::workspace_agents_skills(workspace));
                }
                sources.push(
                    SourceDescriptor::skill_dir(
                        self.home_dir.join(".codex/skills"),
                        SkillSource::User,
                    )
                    .exclude_dot_dirs(),
                );
                sources.push(self.user_agents_skills());
                sources.push(SourceDescriptor::prompt_dir(
                    self.home_dir.join(".codex/prompts"),
                    SkillSource::CodexPrompt,
                ));
                sources.push(SourceDescriptor::skill_dir(
                    self.home_dir.join(".codex/skills/.system"),
                    SkillSource::System,
                ));
                sources.push(SourceDescriptor::plugin_cache(
                    self.home_dir.join(".codex/plugins/cache"),
                    SkillSource::Plugin,
                ));
            }
            ProviderId::Cursor => {
                if let Some(workspace) = workspace_cwd {
                    sources.push(SourceDescriptor::skill_dir(
                        workspace.join(".cursor/skills"),
                        SkillSource::Workspace,
                    ));
                    sources.push(Self::workspace_agents_skills(workspace));
                }
                sources.push(
                    SourceDescriptor::skill_dir(
                        self.home_dir.join(".cursor/skills"),
                        SkillSource::User,
                    )
                    .exclude_dot_dirs(),
                );
                sources.push(self.user_agents_skills());
                sources.push(SourceDescriptor::plugin_cache(
                    self.home_dir.join(".cursor/plugins/cache"),
                    SkillSource::Plugin,
                ));
            }
            ProviderId::Opencode => {
                if let Some(workspace) = workspace_cwd {
                    sources.push(SourceDescriptor::skill_dir(
                        workspace.join(".opencode/skills"),
                        SkillSource::Workspace,
                    ));
                    sources.push(Self::workspace_agents_skills(workspace));
                }
                sources.push(
                    SourceDescriptor::skill_dir(
                        self.home_dir.join(".config/opencode/skills"),
                        SkillSource::User,
                    )
                    .exclude_dot_dirs(),
                );
                sources.push(self.user_agents_skills());
            }
            // Grok reads its own `.grok` roots and, for compatibility, the
            // `.claude` ones alongside them (see its docs/user-guide/08-skills).
            // Bundled platform skills live in a cache Grok never writes user
            // skills into, so they come last and lose to a same-named local one.
            ProviderId::Grok => {
                if let Some(workspace) = workspace_cwd {
                    sources.push(SourceDescriptor::skill_dir(
                        workspace.join(".grok/skills"),
                        SkillSource::Workspace,
                    ));
                    sources.push(Self::workspace_agents_skills(workspace));
                    sources.push(SourceDescriptor::skill_dir(
                        workspace.join(".claude/skills"),
                        SkillSource::Workspace,
                    ));
                }
                sources.push(
                    SourceDescriptor::skill_dir(
                        self.home_dir.join(".grok/skills"),
                        SkillSource::User,
                    )
                    .exclude_dot_dirs(),
                );
                sources.push(self.user_agents_skills());
                sources.push(
                    SourceDescriptor::skill_dir(
                        self.home_dir.join(".claude/skills"),
                        SkillSource::User,
                    )
                    .exclude_dot_dirs(),
                );
                sources.push(SourceDescriptor::plugin_root(
                    self.home_dir.join(".grok/installed-plugins"),
                    SkillSource::Plugin,
                ));
                sources.push(SourceDescriptor::skill_dir(
                    self.home_dir.join(".grok/bundled/skills"),
                    SkillSource::System,
                ));
            }
        }
        sources
    }

    /// Cross-tool personal/repo skills from the skills CLI (`npx skills add -g`).
    /// Claude also gets per-skill symlinks under `~/.claude/skills`; Codex and
    /// Cursor load this directory natively. First-wins collection keeps a
    /// Claude/Cursor/Codex-specific copy when the same name exists in both.
    fn workspace_agents_skills(workspace: &Path) -> SourceDescriptor {
        SourceDescriptor::skill_dir(workspace.join(".agents/skills"), SkillSource::Workspace)
    }

    fn user_agents_skills(&self) -> SourceDescriptor {
        SourceDescriptor::skill_dir(self.home_dir.join(".agents/skills"), SkillSource::User)
            .exclude_dot_dirs()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SourceKind {
    SkillDir,
    PromptDir,
    PluginCache,
    PluginRoot,
}

#[derive(Debug, Clone)]
struct SourceDescriptor {
    kind: SourceKind,
    root: PathBuf,
    source: SkillSource,
    exclude_dot_dirs: bool,
}

impl SourceDescriptor {
    fn skill_dir(root: PathBuf, source: SkillSource) -> Self {
        Self {
            kind: SourceKind::SkillDir,
            root,
            source,
            exclude_dot_dirs: false,
        }
    }

    fn prompt_dir(root: PathBuf, source: SkillSource) -> Self {
        Self {
            kind: SourceKind::PromptDir,
            root,
            source,
            exclude_dot_dirs: false,
        }
    }

    fn plugin_cache(root: PathBuf, source: SkillSource) -> Self {
        Self {
            kind: SourceKind::PluginCache,
            root,
            source,
            exclude_dot_dirs: false,
        }
    }

    /// Grok installs each plugin flat under `~/.grok/installed-plugins/<plugin>/`
    /// with its skills at `<plugin>/skills/`, one level instead of the
    /// distribution/plugin/version nesting `plugin_cache` walks.
    fn plugin_root(root: PathBuf, source: SkillSource) -> Self {
        Self {
            kind: SourceKind::PluginRoot,
            root,
            source,
            exclude_dot_dirs: false,
        }
    }

    fn exclude_dot_dirs(mut self) -> Self {
        self.exclude_dot_dirs = true;
        self
    }
}

fn load_source(source: &SourceDescriptor) -> Vec<DiscoveredSkill> {
    match source.kind {
        SourceKind::SkillDir => {
            load_skill_dir(&source.root, source.source, source.exclude_dot_dirs)
        }
        SourceKind::PromptDir => load_prompt_dir(&source.root, source.source),
        SourceKind::PluginRoot => load_plugin_root(&source.root, source.source),
        SourceKind::PluginCache => load_plugin_cache(&source.root, source.source),
    }
}

fn load_skill_dir(root: &Path, source: SkillSource, exclude_dot_dirs: bool) -> Vec<DiscoveredSkill> {
    let mut results = Vec::new();
    for entry in read_dir_names(root) {
        if exclude_dot_dirs && entry.starts_with('.') {
            continue;
        }
        let dir_path = root.join(&entry);
        if !dir_path.is_dir() {
            continue;
        }
        if let Some(summary) = parse_skill_file(&dir_path.join("SKILL.md"), &entry, source) {
            results.push(summary);
        }
    }
    results
}

fn load_prompt_dir(root: &Path, source: SkillSource) -> Vec<DiscoveredSkill> {
    let mut results = Vec::new();
    for entry in read_dir_names(root) {
        let path = root.join(&entry);
        if path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
        {
            let fallback = path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or(&entry);
            if let Some(summary) = parse_skill_file(&path, fallback, source) {
                results.push(summary);
            }
        }
    }
    results
}

fn load_plugin_root(root: &Path, source: SkillSource) -> Vec<DiscoveredSkill> {
    let mut results = Vec::new();
    for plugin in read_dir_names(root) {
        let skills_root = root.join(plugin).join("skills");
        if skills_root.is_dir() {
            results.extend(load_skill_dir(&skills_root, source, false));
        }
    }
    results
}

fn load_plugin_cache(root: &Path, source: SkillSource) -> Vec<DiscoveredSkill> {
    let mut results = Vec::new();
    for distribution in read_dir_names(root) {
        let distribution_path = root.join(distribution);
        if !distribution_path.is_dir() {
            continue;
        }
        for plugin in read_dir_names(&distribution_path) {
            let plugin_path = distribution_path.join(plugin);
            if !plugin_path.is_dir() {
                continue;
            }
            for version in read_dir_names(&plugin_path) {
                let skills_root = plugin_path.join(version).join("skills");
                if skills_root.is_dir() {
                    results.extend(load_skill_dir(&skills_root, source, false));
                }
            }
        }
    }
    results
}

fn parse_skill_file(
    file_path: &Path,
    fallback_name: &str,
    source: SkillSource,
) -> Option<DiscoveredSkill> {
    let metadata = fs::metadata(file_path).ok()?;
    if metadata.len() > SKILL_FILE_SIZE_CAP_BYTES {
        tracing::warn!(
            target: "skills.registry",
            file_path = %file_path.display(),
            size = metadata.len(),
            cap = SKILL_FILE_SIZE_CAP_BYTES,
            "skill file oversized"
        );
        return None;
    }
    let content = fs::read_to_string(file_path).ok()?;
    let frontmatter = parse_frontmatter(&content);
    Some(DiscoveredSkill {
        summary: SkillSummary {
            name: frontmatter.name.unwrap_or_else(|| fallback_name.to_owned()),
            description: frontmatter.description.unwrap_or_default(),
            source,
        },
        path: file_path.to_path_buf(),
    })
}

fn bounded_instructions(path: &Path, body: &str, max_chars: usize) -> (String, bool) {
    let skill_dir = path.parent().unwrap_or(Path::new("."));
    let canonical_dir = skill_dir.canonicalize().ok();
    let mut references = Vec::new();
    let mut missing_reference = false;
    for word in body.split_whitespace() {
        let candidate = word.rsplit_once("](").map_or(word, |(_, path)| path)
            .trim_end_matches(|character: char| matches!(character, ')' | '.' | ',' | ';' | ':'))
            .trim_matches(|character: char| !character.is_ascii_alphanumeric() && character != '.' && character != '/' && character != '-');
        if !candidate.ends_with(".md") {
            continue;
        }
        if Path::new(candidate).is_absolute() {
            missing_reference = true;
            continue;
        }
        let reference = skill_dir.join(candidate);
        if !canonical_dir.as_ref().is_some_and(|root| {
            reference.canonicalize().ok().is_some_and(|resolved| resolved.starts_with(root))
        }) {
            missing_reference = true;
            continue;
        }
        if references.contains(&reference) {
            continue;
        }
        if references.len() == 2 {
            missing_reference = true;
            continue;
        }
        references.push(reference);
    }

    let mut text = String::new();
    let body_budget = if references.is_empty() { max_chars } else { max_chars * 3 / 5 };
    let (body_excerpt, body_complete) = take_chars(body, body_budget);
    text.push_str(&body_excerpt);
    let mut complete = body_complete && !missing_reference;
    for reference in references {
        let Ok(metadata) = fs::metadata(&reference) else {
            complete = false;
            continue;
        };
        if metadata.len() > SKILL_FILE_SIZE_CAP_BYTES {
            complete = false;
            continue;
        }
        let Ok(contents) = fs::read_to_string(&reference) else {
            complete = false;
            continue;
        };
        let remaining = max_chars.saturating_sub(text.chars().count());
        let label = format!("\nDirect reference {}:\n", reference.file_name().unwrap_or_default().to_string_lossy());
        if remaining <= label.chars().count() {
            complete = false;
            break;
        }
        text.push_str(&label);
        let (excerpt, reference_complete) = take_chars(&contents, remaining - label.chars().count());
        text.push_str(&excerpt);
        complete &= reference_complete;
    }
    (text, complete)
}

fn take_chars(text: &str, max_chars: usize) -> (String, bool) {
    let mut chars = text.chars();
    let excerpt: String = chars.by_ref().take(max_chars).collect();
    (excerpt, chars.next().is_none())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frontmatter {
    pub name: Option<String>,
    pub description: Option<String>,
}

pub fn parse_frontmatter(content: &str) -> Frontmatter {
    if !content.starts_with("---") {
        return Frontmatter {
            name: None,
            description: None,
        };
    }

    let mut lines = content.lines();
    if lines.next().map(str::trim) != Some("---") {
        return Frontmatter {
            name: None,
            description: None,
        };
    }

    let mut name = None;
    let mut description = None;
    for line in lines {
        if line.trim() == "---" {
            return Frontmatter { name, description };
        }
        let Some((key, raw_value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        if key != "name" && key != "description" {
            continue;
        }
        let value = unquote(raw_value.trim());
        if value.is_empty() {
            continue;
        }
        if key == "name" {
            name = Some(value);
        } else {
            description = Some(value);
        }
    }

    // Frontmatter with no closing `---` is technically malformed, but the
    // name/description we accumulated are still usable — return them rather than
    // silently dropping the skill's metadata.
    Frontmatter { name, description }
}

fn unquote(value: &str) -> String {
    let bytes = value.as_bytes();
    if bytes.len() >= 2
        && ((bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\''))
    {
        value[1..value.len() - 1].to_owned()
    } else {
        value.to_owned()
    }
}

fn read_dir_names(root: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_skill(root: &Path, name: &str, frontmatter: &str) {
        let dir = root.join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            format!("---\n{frontmatter}\n---\n\nbody\n"),
        )
        .unwrap();
    }

    fn write_prompt(root: &Path, name: &str, frontmatter: &str) {
        fs::create_dir_all(root).unwrap();
        fs::write(
            root.join(format!("{name}.md")),
            format!("---\n{frontmatter}\n---\n\nbody\n"),
        )
        .unwrap();
    }

    fn write_plugin_skill(
        cache_root: &Path,
        distribution: &str,
        plugin: &str,
        version: &str,
        skill_name: &str,
        frontmatter: &str,
    ) {
        write_skill(
            &cache_root
                .join(distribution)
                .join(plugin)
                .join(version)
                .join("skills"),
            skill_name,
            frontmatter,
        );
    }

    #[test]
    fn parse_frontmatter_extracts_name_and_description() {
        assert_eq!(
            parse_frontmatter("---\nname: impl\ndescription: Implement code\n---\n"),
            Frontmatter {
                name: Some("impl".to_owned()),
                description: Some("Implement code".to_owned()),
            }
        );
    }

    #[test]
    fn parse_frontmatter_handles_quoted_values() {
        assert_eq!(
            parse_frontmatter("---\nname: \"impl\"\ndescription: 'do a thing'\n---\n"),
            Frontmatter {
                name: Some("impl".to_owned()),
                description: Some("do a thing".to_owned()),
            }
        );
    }

    #[test]
    fn parse_frontmatter_returns_nulls_when_missing() {
        assert_eq!(
            parse_frontmatter("# Heading\n\nbody"),
            Frontmatter {
                name: None,
                description: None,
            }
        );
    }

    #[test]
    fn parse_frontmatter_keeps_values_without_closing_delimiter() {
        // No trailing `---`: still surface what we parsed rather than dropping it.
        assert_eq!(
            parse_frontmatter("---\nname: impl\ndescription: Implement code"),
            Frontmatter {
                name: Some("impl".to_owned()),
                description: Some("Implement code".to_owned()),
            }
        );
    }

    #[test]
    fn returns_claude_user_and_plugin_skills_excluding_codex_content() {
        let home = tempdir().unwrap();
        let registry = SkillRegistry::new(home.path());
        let claude_skills = home.path().join(".claude/skills");
        let claude_plugins = home.path().join(".claude/plugins/cache");
        let codex_skills = home.path().join(".codex/skills");
        write_skill(&claude_skills, "impl", "name: impl\ndescription: Implement");
        write_skill(&claude_skills, "plan", "name: plan\ndescription: Plan");
        write_plugin_skill(
            &claude_plugins,
            "claude-plugins-official",
            "vercel",
            "0.40.1",
            "vercel-agent",
            "name: vercel-agent\ndescription: Vercel guidance",
        );
        write_skill(
            &codex_skills,
            "codex-only",
            "name: codex-only\ndescription: Codex thing",
        );

        let result = registry.list_skills(ProviderId::Claude, None);

        assert_eq!(names(&result), ["impl", "plan", "vercel-agent"]);
        assert_eq!(
            result
                .iter()
                .find(|skill| skill.name == "vercel-agent")
                .map(|skill| skill.source),
            Some(SkillSource::Plugin)
        );
    }

    #[test]
    fn returns_codex_user_prompts_system_and_plugin_skills() {
        let home = tempdir().unwrap();
        let registry = SkillRegistry::new(home.path());
        let codex_skills = home.path().join(".codex/skills");
        let codex_prompts = home.path().join(".codex/prompts");
        let codex_plugins = home.path().join(".codex/plugins/cache");
        write_skill(
            &codex_skills,
            "user-skill",
            "name: user-skill\ndescription: user-level",
        );
        write_prompt(&codex_prompts, "opsx-apply", "description: Apply a change");
        write_skill(
            &codex_skills.join(".system"),
            "imagegen",
            "name: imagegen\ndescription: Generate images",
        );
        write_plugin_skill(
            &codex_plugins,
            "openai-curated",
            "github",
            "63976030",
            "gh-fix-ci",
            "name: gh-fix-ci\ndescription: Fix CI",
        );

        let result = registry.list_skills(ProviderId::Codex, None);

        assert_eq!(
            names(&result),
            ["gh-fix-ci", "imagegen", "opsx-apply", "user-skill"]
        );
        assert_eq!(
            result
                .iter()
                .find(|skill| skill.name == "imagegen")
                .map(|skill| skill.source),
            Some(SkillSource::System)
        );
        assert_eq!(
            result
                .iter()
                .find(|skill| skill.name == "opsx-apply")
                .map(|skill| skill.source),
            Some(SkillSource::CodexPrompt)
        );
    }

    #[test]
    fn excludes_system_directory_from_codex_user_walk() {
        let home = tempdir().unwrap();
        let registry = SkillRegistry::new(home.path());
        let codex_skills = home.path().join(".codex/skills");
        write_skill(
            &codex_skills.join(".system"),
            "imagegen",
            "name: imagegen\ndescription: from system",
        );

        let result = registry.list_skills(ProviderId::Codex, None);

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].source, SkillSource::System);
    }

    #[test]
    fn falls_back_to_directory_or_file_basename() {
        let home = tempdir().unwrap();
        let registry = SkillRegistry::new(home.path());
        let claude_skills = home.path().join(".claude/skills");
        write_skill(&claude_skills, "no-name", "description: missing name");

        let result = registry.list_skills(ProviderId::Claude, None);

        assert_eq!(
            result,
            vec![SkillSummary {
                name: "no-name".to_owned(),
                description: "missing name".to_owned(),
                source: SkillSource::User,
            }]
        );
    }

    #[test]
    fn workspace_wins_over_user_and_user_wins_over_plugin() {
        let home = tempdir().unwrap();
        let workspace = tempdir().unwrap();
        let registry = SkillRegistry::new(home.path());
        let claude_skills = home.path().join(".claude/skills");
        let claude_plugins = home.path().join(".claude/plugins/cache");
        write_plugin_skill(
            &claude_plugins,
            "marketplace",
            "things",
            "1.0.0",
            "impl",
            "name: impl\ndescription: from plugin",
        );
        write_skill(&claude_skills, "impl", "name: impl\ndescription: from user");
        write_skill(
            &workspace.path().join(".claude/skills"),
            "impl",
            "name: impl\ndescription: from workspace",
        );

        let with_workspace = registry.list_skills(ProviderId::Claude, Some(workspace.path()));
        assert_eq!(with_workspace[0].description, "from workspace");
        assert_eq!(with_workspace[0].source, SkillSource::Workspace);

        registry.clear_cache();
        let without_workspace = registry.list_skills(ProviderId::Claude, None);
        assert_eq!(without_workspace[0].description, "from user");
        assert_eq!(without_workspace[0].source, SkillSource::User);
    }

    #[test]
    fn invoked_body_uses_workspace_precedence_and_bounded_direct_reference() {
        let home = tempdir().unwrap();
        let workspace = tempdir().unwrap();
        let registry = SkillRegistry::new(home.path());
        write_skill(&home.path().join(".claude/skills"), "Ship", "name: Ship\ndescription: user");
        let workspace_skills = workspace.path().join(".claude/skills");
        write_skill(&workspace_skills, "ship", "name: ship\ndescription: workspace");
        let skill_dir = workspace_skills.join("ship");
        fs::create_dir_all(skill_dir.join("references")).unwrap();
        fs::write(skill_dir.join("SKILL.md"), "---\nname: ship\n---\nRun reviews and [babysit](references/babysit.md), then [next](next.md).\n").unwrap();
        fs::write(skill_dir.join("references/babysit.md"), "Repair CI failures before merging.").unwrap();
        fs::write(skill_dir.join("next.md"), "Confirm the merged result.").unwrap();

        assert_eq!(registry.list_skills(ProviderId::Claude, Some(workspace.path())).len(), 1);

        let instructions = registry.invoked_instructions(
            ProviderId::Claude, Some(workspace.path()), &["ship".to_string()], 2_000,
        );
        assert_eq!(instructions.len(), 1);
        assert!(instructions[0].complete);
        assert!(instructions[0].text.contains("Repair CI failures"));
        assert!(instructions[0].text.contains("Confirm the merged result"));
        assert!(!instructions[0].text.contains("description: user"));
    }

    #[test]
    fn missing_or_clipped_invoked_body_is_explicit() {
        let home = tempdir().unwrap();
        let registry = SkillRegistry::new(home.path());
        assert!(!registry.invoked_instructions(ProviderId::Claude, None, &["ship".to_string()], 100)[0].complete);
        write_skill(&home.path().join(".claude/skills"), "ship", "name: ship\ndescription: workflow");
        registry.clear_cache();
        assert!(!registry.invoked_instructions(ProviderId::Claude, None, &["ship".to_string()], 5)[0].complete);
    }

    #[test]
    fn absolute_skill_reference_does_not_look_complete() {
        let home = tempdir().unwrap();
        let registry = SkillRegistry::new(home.path());
        let skill_dir = home.path().join(".claude/skills/ship");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(skill_dir.join("SKILL.md"), "---\nname: ship\n---\nRead [next](/outside/next.md).\n").unwrap();
        let instructions = registry.invoked_instructions(ProviderId::Claude, None, &["ship".to_string()], 2_000);
        assert!(!instructions[0].complete);
    }

    #[test]
    fn skips_oversized_skill_files_and_continues() {
        let home = tempdir().unwrap();
        let registry = SkillRegistry::new(home.path());
        let claude_skills = home.path().join(".claude/skills");
        write_skill(&claude_skills, "small", "name: small\ndescription: fine");
        let huge_dir = claude_skills.join("huge");
        fs::create_dir_all(&huge_dir).unwrap();
        fs::write(
            huge_dir.join("SKILL.md"),
            format!(
                "---\nname: huge\ndescription: too big\n---\n{}",
                "x".repeat(257 * 1024)
            ),
        )
        .unwrap();

        let result = registry.list_skills(ProviderId::Claude, None);

        assert_eq!(names(&result), ["small"]);
    }

    #[test]
    fn returns_empty_when_source_directories_are_missing() {
        let home = tempdir().unwrap();
        let registry = SkillRegistry::new(home.path());

        assert_eq!(registry.list_skills(ProviderId::Claude, None), Vec::new());
    }

    #[test]
    fn returns_cursor_user_workspace_and_plugin_skills() {
        let home = tempdir().unwrap();
        let workspace = tempdir().unwrap();
        let registry = SkillRegistry::new(home.path());
        let cursor_skills = home.path().join(".cursor/skills");
        let cursor_plugins = home.path().join(".cursor/plugins/cache");
        write_skill(
            &cursor_skills,
            "impl",
            "name: impl\ndescription: cursor impl",
        );
        write_plugin_skill(
            &cursor_plugins,
            "cursor-public",
            "notion",
            "abc123",
            "create-page",
            "name: create-page\ndescription: Notion page",
        );
        write_skill(
            &workspace.path().join(".cursor/skills"),
            "ship",
            "name: ship\ndescription: workspace ship",
        );
        write_skill(
            &home.path().join(".claude/skills"),
            "claude-only",
            "name: claude-only\ndescription: claude",
        );

        let result = registry.list_skills(ProviderId::Cursor, Some(workspace.path()));

        assert_eq!(names(&result), ["create-page", "impl", "ship"]);
        assert_eq!(
            result
                .iter()
                .find(|skill| skill.name == "ship")
                .map(|skill| skill.source),
            Some(SkillSource::Workspace)
        );
    }

    #[test]
    fn lists_shared_agents_skills_for_codex_and_cursor() {
        // Personal catalog from the skills CLI lives in ~/.agents/skills.
        // Codex used to surface those names only via ~/.codex/prompts, and
        // Cursor missed them entirely because ~/.cursor/skills is often empty.
        let home = tempdir().unwrap();
        let registry = SkillRegistry::new(home.path());
        write_skill(
            &home.path().join(".agents/skills"),
            "impl",
            "name: impl\ndescription: shared impl",
        );
        write_prompt(
            &home.path().join(".codex/prompts"),
            "impl",
            "name: impl\ndescription: prompt copy",
        );

        let cursor = registry.list_skills(ProviderId::Cursor, None);
        assert_eq!(
            cursor,
            vec![SkillSummary {
                name: "impl".to_owned(),
                description: "shared impl".to_owned(),
                source: SkillSource::User,
            }]
        );

        registry.clear_cache();
        let codex = registry.list_skills(ProviderId::Codex, None);
        assert_eq!(codex.len(), 1);
        assert_eq!(codex[0].name, "impl");
        assert_eq!(codex[0].description, "shared impl");
        assert_eq!(codex[0].source, SkillSource::User);
    }

    #[test]
    fn workspace_agents_skills_win_over_user_agents_skills() {
        let home = tempdir().unwrap();
        let workspace = tempdir().unwrap();
        let registry = SkillRegistry::new(home.path());
        write_skill(
            &home.path().join(".agents/skills"),
            "impl",
            "name: impl\ndescription: user agents",
        );
        write_skill(
            &workspace.path().join(".agents/skills"),
            "impl",
            "name: impl\ndescription: workspace agents",
        );

        let result = registry.list_skills(ProviderId::Cursor, Some(workspace.path()));
        assert_eq!(result[0].description, "workspace agents");
        assert_eq!(result[0].source, SkillSource::Workspace);
    }

    #[test]
    fn claude_keeps_claude_dir_copy_over_shared_agents_skills() {
        let home = tempdir().unwrap();
        let registry = SkillRegistry::new(home.path());
        write_skill(
            &home.path().join(".claude/skills"),
            "impl",
            "name: impl\ndescription: from claude dir",
        );
        write_skill(
            &home.path().join(".agents/skills"),
            "impl",
            "name: impl\ndescription: from agents dir",
        );

        let result = registry.list_skills(ProviderId::Claude, None);
        assert_eq!(result[0].description, "from claude dir");
    }

    fn names<const N: usize>(skills: &[SkillSummary]) -> [String; N] {
        skills
            .iter()
            .map(|skill| skill.name.clone())
            .collect::<Vec<_>>()
            .try_into()
            .expect("expected fixed number of names")
    }
}
