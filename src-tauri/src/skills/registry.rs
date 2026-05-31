use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::Serialize;
use specta::Type;

use crate::ipc::validation::ProviderId;

pub const SKILL_FILE_SIZE_CAP_BYTES: u64 = 262_144;

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

#[derive(Debug)]
pub struct SkillRegistry {
    home_dir: PathBuf,
    cache: Mutex<BTreeMap<String, Vec<SkillSummary>>>,
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
        self.cache.lock().expect("skills cache poisoned").clear();
    }

    pub fn list_skills(
        &self,
        provider: ProviderId,
        workspace_cwd: Option<&Path>,
    ) -> Vec<SkillSummary> {
        let cache_key = format!(
            "{provider:?}::{}",
            workspace_cwd
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_default()
        );
        if let Some(cached) = self
            .cache
            .lock()
            .expect("skills cache poisoned")
            .get(&cache_key)
            .cloned()
        {
            return cached;
        }

        let mut collected = BTreeMap::<String, SkillSummary>::new();
        for source in self.resolve_sources(provider, workspace_cwd) {
            for skill in load_source(&source) {
                collected.entry(skill.name.clone()).or_insert(skill);
            }
        }
        let result = collected.into_values().collect::<Vec<_>>();
        self.cache
            .lock()
            .expect("skills cache poisoned")
            .insert(cache_key, result.clone());
        result
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
                }
                sources.push(
                    SourceDescriptor::skill_dir(
                        self.home_dir.join(".claude/skills"),
                        SkillSource::User,
                    )
                    .exclude_dot_dirs(),
                );
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
                }
                sources.push(
                    SourceDescriptor::skill_dir(
                        self.home_dir.join(".codex/skills"),
                        SkillSource::User,
                    )
                    .exclude_dot_dirs(),
                );
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
                }
                sources.push(
                    SourceDescriptor::skill_dir(
                        self.home_dir.join(".cursor/skills"),
                        SkillSource::User,
                    )
                    .exclude_dot_dirs(),
                );
                sources.push(SourceDescriptor::plugin_cache(
                    self.home_dir.join(".cursor/plugins/cache"),
                    SkillSource::Plugin,
                ));
            }
        }
        sources
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SourceKind {
    SkillDir,
    PromptDir,
    PluginCache,
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

    fn exclude_dot_dirs(mut self) -> Self {
        self.exclude_dot_dirs = true;
        self
    }
}

fn load_source(source: &SourceDescriptor) -> Vec<SkillSummary> {
    match source.kind {
        SourceKind::SkillDir => {
            load_skill_dir(&source.root, source.source, source.exclude_dot_dirs)
        }
        SourceKind::PromptDir => load_prompt_dir(&source.root, source.source),
        SourceKind::PluginCache => load_plugin_cache(&source.root, source.source),
    }
}

fn load_skill_dir(root: &Path, source: SkillSource, exclude_dot_dirs: bool) -> Vec<SkillSummary> {
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

fn load_prompt_dir(root: &Path, source: SkillSource) -> Vec<SkillSummary> {
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

fn load_plugin_cache(root: &Path, source: SkillSource) -> Vec<SkillSummary> {
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
) -> Option<SkillSummary> {
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
    Some(SkillSummary {
        name: frontmatter.name.unwrap_or_else(|| fallback_name.to_owned()),
        description: frontmatter.description.unwrap_or_default(),
        source,
    })
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

    fn names<const N: usize>(skills: &[SkillSummary]) -> [String; N] {
        skills
            .iter()
            .map(|skill| skill.name.clone())
            .collect::<Vec<_>>()
            .try_into()
            .expect("expected fixed number of names")
    }
}
