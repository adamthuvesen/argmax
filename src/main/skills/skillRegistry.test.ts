// @vitest-environment node
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readLogBuffer, resetLogBufferForTesting } from "../../shared/logger.js";

const fakeHome = mkdtempSync(join(tmpdir(), "argmax-skills-home-"));

vi.mock("node:os", async () => {
  const actual = await vi.importActual("node:os");
  return {
    ...(actual as Record<string, unknown>),
    homedir: () => fakeHome
  };
});

import { clearSkillsCache, listSkills, parseFrontmatter } from "./skillRegistry.js";

const claudeSkillsDir = join(fakeHome, ".claude", "skills");
const claudePluginCache = join(fakeHome, ".claude", "plugins", "cache");
const codexSkillsDir = join(fakeHome, ".codex", "skills");
const codexPromptsDir = join(fakeHome, ".codex", "prompts");
const codexPluginCache = join(fakeHome, ".codex", "plugins", "cache");
const cursorSkillsDir = join(fakeHome, ".cursor", "skills");
const cursorPluginCache = join(fakeHome, ".cursor", "plugins", "cache");

let workspaceCwd: string;

function writeSkill(root: string, name: string, frontmatter: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\nbody\n`);
}

function writePromptFile(name: string, frontmatter: string): void {
  mkdirSync(codexPromptsDir, { recursive: true });
  writeFileSync(join(codexPromptsDir, `${name}.md`), `---\n${frontmatter}\n---\n\nbody\n`);
}

function writePluginSkill(
  cacheRoot: string,
  distribution: string,
  plugin: string,
  version: string,
  skillName: string,
  frontmatter: string
): void {
  const skillsRoot = join(cacheRoot, distribution, plugin, version, "skills");
  writeSkill(skillsRoot, skillName, frontmatter);
}

beforeEach(() => {
  clearSkillsCache();
  workspaceCwd = mkdtempSync(join(tmpdir(), "argmax-skills-ws-"));
  mkdirSync(claudeSkillsDir, { recursive: true });
  mkdirSync(claudePluginCache, { recursive: true });
  mkdirSync(codexSkillsDir, { recursive: true });
  mkdirSync(codexPromptsDir, { recursive: true });
  mkdirSync(codexPluginCache, { recursive: true });
  mkdirSync(cursorSkillsDir, { recursive: true });
  mkdirSync(cursorPluginCache, { recursive: true });
});

afterEach(() => {
  rmSync(join(fakeHome, ".claude"), { recursive: true, force: true });
  rmSync(join(fakeHome, ".codex"), { recursive: true, force: true });
  rmSync(join(fakeHome, ".cursor"), { recursive: true, force: true });
  rmSync(workspaceCwd, { recursive: true, force: true });
  clearSkillsCache();
});

describe("parseFrontmatter", () => {
  it("extracts name and description", () => {
    expect(
      parseFrontmatter(`---\nname: impl\ndescription: Implement code from a written plan\n---\n`)
    ).toEqual({ name: "impl", description: "Implement code from a written plan" });
  });

  it("handles quoted values", () => {
    expect(parseFrontmatter(`---\nname: "impl"\ndescription: 'do a thing'\n---\n`)).toEqual({
      name: "impl",
      description: "do a thing"
    });
  });

  it("returns nulls when no frontmatter is present", () => {
    expect(parseFrontmatter(`# Heading\n\nbody`)).toEqual({ name: null, description: null });
  });
});

describe("listSkills", () => {
  it("returns Claude user skills + plugin skills, excluding Codex content", async () => {
    writeSkill(claudeSkillsDir, "impl", "name: impl\ndescription: Implement");
    writeSkill(claudeSkillsDir, "plan", "name: plan\ndescription: Plan a task");
    writePluginSkill(
      claudePluginCache,
      "claude-plugins-official",
      "vercel",
      "0.40.1",
      "vercel-agent",
      "name: vercel-agent\ndescription: Vercel guidance"
    );
    writeSkill(codexSkillsDir, "codex-only", "name: codex-only\ndescription: Codex thing");

    const result = await listSkills({ provider: "claude", workspaceCwd: null });

    expect(result.map((s) => s.name)).toEqual(["impl", "plan", "vercel-agent"]);
    expect(result.find((s) => s.name === "vercel-agent")?.source).toBe("plugin");
  });

  it("returns Codex user skills, prompts, .system, and plugin skills together", async () => {
    writeSkill(codexSkillsDir, "user-skill", "name: user-skill\ndescription: user-level");
    writePromptFile("opsx-apply", "description: Apply a change");
    // .system skills must be reached through the .system subdirectory.
    const systemRoot = join(codexSkillsDir, ".system");
    writeSkill(systemRoot, "imagegen", "name: imagegen\ndescription: Generate images");
    writePluginSkill(
      codexPluginCache,
      "openai-curated",
      "github",
      "63976030",
      "gh-fix-ci",
      "name: gh-fix-ci\ndescription: Fix CI"
    );
    writeSkill(claudeSkillsDir, "impl", "name: impl\ndescription: claude only");

    const result = await listSkills({ provider: "codex", workspaceCwd: null });

    expect(result.map((s) => s.name).sort()).toEqual([
      "gh-fix-ci",
      "imagegen",
      "opsx-apply",
      "user-skill"
    ]);
    expect(result.find((s) => s.name === "imagegen")?.source).toBe("system");
    expect(result.find((s) => s.name === "gh-fix-ci")?.source).toBe("plugin");
    expect(result.find((s) => s.name === "opsx-apply")?.source).toBe("codex-prompt");
  });

  it("excludes the .system directory from the user-skills walk to avoid double-listing", async () => {
    const systemRoot = join(codexSkillsDir, ".system");
    writeSkill(systemRoot, "imagegen", "name: imagegen\ndescription: from system");

    const result = await listSkills({ provider: "codex", workspaceCwd: null });

    // imagegen appears exactly once and is sourced as "system", not "user".
    const imagegens = result.filter((s) => s.name === "imagegen");
    expect(imagegens).toHaveLength(1);
    expect(imagegens[0]?.source).toBe("system");
  });

  it("falls back to directory/file basename when frontmatter has no name", async () => {
    writeSkill(claudeSkillsDir, "no-name", "description: missing name field");

    const result = await listSkills({ provider: "claude", workspaceCwd: null });

    expect(result).toContainEqual({ name: "no-name", description: "missing name field", source: "user" });
  });

  it("workspace-local skills win over user, user wins over plugin on name collision", async () => {
    writePluginSkill(
      claudePluginCache,
      "marketplace",
      "things",
      "1.0.0",
      "impl",
      "name: impl\ndescription: from plugin"
    );
    writeSkill(claudeSkillsDir, "impl", "name: impl\ndescription: from user");
    const wsClaude = join(workspaceCwd, ".claude", "skills");
    writeSkill(wsClaude, "impl", "name: impl\ndescription: from workspace");

    const result = await listSkills({ provider: "claude", workspaceCwd });
    const impl = result.find((s) => s.name === "impl");
    expect(impl?.description).toBe("from workspace");
    expect(impl?.source).toBe("workspace");

    // Without a workspace, user wins over plugin.
    clearSkillsCache();
    const noWs = await listSkills({ provider: "claude", workspaceCwd: null });
    const impl2 = noWs.find((s) => s.name === "impl");
    expect(impl2?.description).toBe("from user");
    expect(impl2?.source).toBe("user");
  });

  it("skips oversized SKILL.md files with a warn and continues discovering siblings", async () => {
    // 257 KB body — just past the 256 KB cap.
    const oversizedBody = "x".repeat(257 * 1024);
    writeSkill(claudeSkillsDir, "huge", `name: huge\ndescription: too big\n---\n${oversizedBody}`);
    writeSkill(claudeSkillsDir, "small", "name: small\ndescription: fine");
    resetLogBufferForTesting();

    const result = await listSkills({ provider: "claude", workspaceCwd: null });

    expect(result.map((s) => s.name)).toEqual(["small"]);
    const warns = readLogBuffer().filter((entry) => entry.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]?.scope).toBe("skills.registry");
    expect(warns[0]?.message).toBe("skill file oversized");
    expect(warns[0]?.fields.cap).toBe(262_144);
  });

  it("returns empty list when source directories are missing", async () => {
    rmSync(claudeSkillsDir, { recursive: true, force: true });
    rmSync(claudePluginCache, { recursive: true, force: true });

    const result = await listSkills({ provider: "claude", workspaceCwd: null });

    expect(result).toEqual([]);
  });

  it("returns Cursor user, workspace, and plugin skills together", async () => {
    writeSkill(cursorSkillsDir, "impl", "name: impl\ndescription: cursor impl");
    writePluginSkill(
      cursorPluginCache,
      "cursor-public",
      "notion",
      "abc123",
      "create-page",
      "name: create-page\ndescription: Notion page"
    );
    const wsCursor = join(workspaceCwd, ".cursor", "skills");
    writeSkill(wsCursor, "ship", "name: ship\ndescription: workspace ship");
    // Claude skill must not bleed in when provider is cursor.
    writeSkill(claudeSkillsDir, "claude-only", "name: claude-only\ndescription: claude");

    const result = await listSkills({ provider: "cursor", workspaceCwd });

    expect(result.map((s) => s.name)).toEqual(["create-page", "impl", "ship"]);
    expect(result.find((s) => s.name === "impl")?.source).toBe("user");
    expect(result.find((s) => s.name === "ship")?.source).toBe("workspace");
    expect(result.find((s) => s.name === "create-page")?.source).toBe("plugin");
  });
});
