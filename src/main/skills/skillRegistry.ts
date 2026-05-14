import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { logger } from "../../shared/logger.js";
import type { ProviderId, SkillSource, SkillSummary } from "../../shared/types.js";
import { tryFileSize, tryIsDirectory, tryReaddir, tryReadFile } from "../util/safeFs.js";

/**
 * Skill registry — discovers slash-invokable skills/prompts on disk for a
 * given provider and workspace.
 *
 * Sources per provider:
 *   claude:
 *     - ~/.claude/skills/<name>/SKILL.md                              (user)
 *     - ~/.claude/plugins/cache/<dist>/<plugin>/<v>/skills/<name>/    (plugin)
 *     - <workspaceCwd>/.claude/skills/<name>/SKILL.md                 (workspace)
 *   codex:
 *     - ~/.codex/skills/<name>/SKILL.md (excluding .system)           (user)
 *     - ~/.codex/skills/.system/<name>/SKILL.md                       (system)
 *     - ~/.codex/prompts/<name>.md                                    (codex-prompt)
 *     - ~/.codex/plugins/cache/<dist>/<plugin>/<v>/skills/<name>/     (plugin)
 *     - <workspaceCwd>/.codex/skills/<name>/SKILL.md                  (workspace)
 *   cursor:
 *     - ~/.cursor/skills/<name>/SKILL.md                              (user)
 *     - ~/.cursor/plugins/cache/<dist>/<plugin>/<v>/skills/<name>/    (plugin)
 *     - <workspaceCwd>/.cursor/skills/<name>/SKILL.md                 (workspace)
 *
 * Precedence on name collision: workspace > user > codex-prompt > system > plugin.
 * Skills are slash-invokable in different ways across CLIs (Codex prompts are
 * literal slash dispatch; Anthropic-format skills are model-triggered) but
 * the registry surfaces all of them so the user can discover what exists.
 */

interface ListSkillsInput {
  provider: ProviderId;
  workspaceCwd: string | null;
}

const cache = new Map<string, SkillSummary[]>();

const SKILL_FILE_SIZE_CAP_BYTES = 262_144;

export async function listSkills(input: ListSkillsInput): Promise<SkillSummary[]> {
  const cacheKey = `${input.provider}::${input.workspaceCwd ?? ""}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  // Highest precedence first; Map.set with skipIfPresent semantics retains it.
  const collected = new Map<string, SkillSummary>();
  const sources = resolveSources(input);
  const perSource = await Promise.all(sources.map((source) => loadSource(source)));

  for (const found of perSource) {
    for (const skill of found) {
      if (!collected.has(skill.name)) {
        collected.set(skill.name, skill);
      }
    }
  }

  const result = Array.from(collected.values()).sort((left, right) =>
    left.name.localeCompare(right.name)
  );
  cache.set(cacheKey, result);
  return result;
}

export function clearSkillsCache(): void {
  cache.clear();
}

type SourceKind = "skill-dir" | "prompt-file" | "plugin-cache";

interface SourceDescriptor {
  kind: SourceKind;
  /** Root directory to scan. Semantics depend on kind. */
  root: string;
  source: SkillSource;
  /**
   * For "skill-dir" only: when true, skip directory entries beginning with
   * a dot (used to exclude `.system/` from the user-skills walk so we can
   * re-walk it as a separate "system" source).
   */
  excludeDotDirs?: boolean;
  /** For "skill-dir" only: scan only this single dotted dir (for .system). */
  onlyDotDir?: string;
}

function resolveSources(input: ListSkillsInput): SourceDescriptor[] {
  const home = homedir();
  const sources: SourceDescriptor[] = [];

  if (input.provider === "claude") {
    if (input.workspaceCwd) {
      sources.push({
        kind: "skill-dir",
        root: join(input.workspaceCwd, ".claude", "skills"),
        source: "workspace"
      });
    }
    sources.push({
      kind: "skill-dir",
      root: join(home, ".claude", "skills"),
      source: "user",
      excludeDotDirs: true
    });
    sources.push({
      kind: "plugin-cache",
      root: join(home, ".claude", "plugins", "cache"),
      source: "plugin"
    });
  } else if (input.provider === "codex") {
    if (input.workspaceCwd) {
      sources.push({
        kind: "skill-dir",
        root: join(input.workspaceCwd, ".codex", "skills"),
        source: "workspace"
      });
    }
    sources.push({
      kind: "skill-dir",
      root: join(home, ".codex", "skills"),
      source: "user",
      excludeDotDirs: true
    });
    sources.push({
      kind: "prompt-file",
      root: join(home, ".codex", "prompts"),
      source: "codex-prompt"
    });
    sources.push({
      kind: "skill-dir",
      root: join(home, ".codex", "skills"),
      source: "system",
      onlyDotDir: ".system"
    });
    sources.push({
      kind: "plugin-cache",
      root: join(home, ".codex", "plugins", "cache"),
      source: "plugin"
    });
  } else if (input.provider === "cursor") {
    if (input.workspaceCwd) {
      sources.push({
        kind: "skill-dir",
        root: join(input.workspaceCwd, ".cursor", "skills"),
        source: "workspace"
      });
    }
    sources.push({
      kind: "skill-dir",
      root: join(home, ".cursor", "skills"),
      source: "user",
      excludeDotDirs: true
    });
    sources.push({
      kind: "plugin-cache",
      root: join(home, ".cursor", "plugins", "cache"),
      source: "plugin"
    });
  }

  return sources;
}

async function loadSource(source: SourceDescriptor): Promise<SkillSummary[]> {
  if (source.kind === "plugin-cache") {
    return loadPluginCache(source.root, source.source);
  }
  if (source.kind === "skill-dir" && source.onlyDotDir) {
    const subdir = join(source.root, source.onlyDotDir);
    return loadSkillDir(subdir, source.source, false);
  }
  if (source.kind === "skill-dir") {
    return loadSkillDir(source.root, source.source, source.excludeDotDirs ?? false);
  }
  return loadPromptDir(source.root, source.source);
}

async function loadSkillDir(
  root: string,
  sourceKind: SkillSource,
  excludeDotDirs: boolean
): Promise<SkillSummary[]> {
  const entries = await tryReaddir(root);
  const candidates = excludeDotDirs ? entries.filter((entry) => !entry.startsWith(".")) : entries;
  const results = await Promise.all(
    candidates.map(async (entry) => {
      const dirPath = join(root, entry);
      if (!(await tryIsDirectory(dirPath))) {
        return null;
      }
      return parseSkillFile(join(dirPath, "SKILL.md"), entry, sourceKind);
    })
  );
  return results.filter((summary): summary is SkillSummary => summary !== null);
}

async function loadPromptDir(root: string, sourceKind: SkillSource): Promise<SkillSummary[]> {
  const entries = await tryReaddir(root);
  const markdownEntries = entries.filter((entry) => extname(entry).toLowerCase() === ".md");
  const results = await Promise.all(
    markdownEntries.map((entry) =>
      parseSkillFile(join(root, entry), basename(entry, extname(entry)), sourceKind)
    )
  );
  return results.filter((summary): summary is SkillSummary => summary !== null);
}

/**
 * Walks `<distribution>/<plugin>/<version>/skills/<name>/SKILL.md` under the
 * plugin cache root. Tolerates missing directories at any level.
 */
async function loadPluginCache(root: string, sourceKind: SkillSource): Promise<SkillSummary[]> {
  const distributions = await tryReaddir(root);
  const distSummaries = await Promise.all(
    distributions.map(async (dist) => {
      const distPath = join(root, dist);
      if (!(await tryIsDirectory(distPath))) {
        return [] as SkillSummary[];
      }
      const plugins = await tryReaddir(distPath);
      const pluginSummaries = await Promise.all(
        plugins.map(async (plugin) => {
          const pluginPath = join(distPath, plugin);
          if (!(await tryIsDirectory(pluginPath))) {
            return [] as SkillSummary[];
          }
          const versions = await tryReaddir(pluginPath);
          const versionSummaries = await Promise.all(
            versions.map(async (version) => {
              const skillsRoot = join(pluginPath, version, "skills");
              if (!(await tryIsDirectory(skillsRoot))) {
                return [] as SkillSummary[];
              }
              return loadSkillDir(skillsRoot, sourceKind, false);
            })
          );
          return versionSummaries.flat();
        })
      );
      return pluginSummaries.flat();
    })
  );
  return distSummaries.flat();
}

async function parseSkillFile(
  filePath: string,
  fallbackName: string,
  sourceKind: SkillSource
): Promise<SkillSummary | null> {
  // Stat first so a pathological multi-MiB SKILL.md cannot blow up the
  // discovery walk. Anything over the cap is skipped with a warning rather
  // than rejected loudly — discovery should still surface other skills.
  const size = await tryFileSize(filePath);
  if (size === null) {
    return null;
  }
  if (size > SKILL_FILE_SIZE_CAP_BYTES) {
    logger.warn("skills.registry", "skill file oversized", {
      filePath,
      size,
      cap: SKILL_FILE_SIZE_CAP_BYTES
    });
    return null;
  }
  const content = await tryReadFile(filePath);
  if (content === null) {
    return null;
  }

  const { name, description } = parseFrontmatter(content);
  return {
    name: name ?? fallbackName,
    description: description ?? "",
    source: sourceKind
  };
}

/**
 * Minimal YAML-ish frontmatter parser for skill files. Reads only the
 * top-level `name:` and `description:` keys from the leading `---`-fenced
 * block. Handles single-line values and quoted strings; does not attempt
 * multi-line YAML, anchors, or nested structures.
 */
export function parseFrontmatter(content: string): { name: string | null; description: string | null } {
  if (!content.startsWith("---")) {
    return { name: null, description: null };
  }
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return { name: null, description: null };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return { name: null, description: null };
  }

  let name: string | null = null;
  let description: string | null = null;
  for (let i = 1; i < end; i += 1) {
    const line = lines[i];
    if (!line) {
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const key = match[1];
    const rawValue = match[2] ?? "";
    if (key !== "name" && key !== "description") {
      continue;
    }
    const value = unquote(rawValue.trim());
    if (key === "name") {
      name = value || null;
    } else {
      description = value || null;
    }
  }
  return { name, description };
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

