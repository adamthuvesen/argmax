import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { MaestroDatabase } from "../persistence/database.js";
import type { ProjectSettings, ProjectSummary, RegisterProjectInput, UpdateProjectSettingsInput } from "../../shared/types.js";

const execFileAsync = promisify(execFile);

const registerProjectInput = z.object({
  repoPath: z.string().min(1)
});

const projectSettingsInput = z.object({
  defaultProvider: z.enum(["claude", "codex"]),
  defaultModelLabel: z.string().min(1),
  worktreeLocation: z.string().min(1),
  setupCommand: z.string(),
  checkCommands: z.array(z.string().min(1))
});

const updateProjectSettingsInput = z.object({
  projectId: z.string().min(1),
  settings: projectSettingsInput
});

interface GitMetadata {
  repoPath: string;
  currentBranch: string;
  defaultBranch: string | null;
}

export class ProjectRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectRegistrationError";
  }
}

export class ProjectService {
  constructor(private readonly database: MaestroDatabase) {}

  async registerProject(rawInput: RegisterProjectInput): Promise<ProjectSummary> {
    const input = registerProjectInput.parse(rawInput);
    const canonicalPath = await canonicalizeRepoPath(input.repoPath);
    const metadata = await readGitMetadata(canonicalPath);
    // Validate baseRef-style refs at registration: catches ref strings the
    // zod boundary cannot detect (e.g. "@", trailing slashes) before they
    // ever flow into argv. defaultBranch is the only ref persisted here.
    if (metadata.defaultBranch) {
      await assertValidRefName(metadata.repoPath, metadata.defaultBranch);
    }
    const settings = defaultSettings(metadata.repoPath);

    return this.database.persistProject({
      id: randomUUID(),
      name: basename(metadata.repoPath),
      repoPath: metadata.repoPath,
      currentBranch: metadata.currentBranch,
      defaultBranch: metadata.defaultBranch,
      settings
    });
  }

  updateSettings(rawInput: UpdateProjectSettingsInput): ProjectSummary {
    const input = updateProjectSettingsInput.parse(rawInput);
    return this.database.updateProjectSettings(input.projectId, input.settings);
  }
}

async function canonicalizeRepoPath(candidatePath: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(candidatePath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown filesystem error";
    throw new ProjectRegistrationError(`Maestro could not resolve ${candidatePath}. ${detail}`);
  }
  let stats;
  try {
    stats = await stat(resolved);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown filesystem error";
    throw new ProjectRegistrationError(`Maestro could not stat ${resolved}. ${detail}`);
  }
  if (!stats.isDirectory()) {
    throw new ProjectRegistrationError(`${resolved} is not a directory.`);
  }
  // Require a `.git` entry — file (worktree linked) or directory — so we
  // refuse paths that just happen to live inside a repo but are not the
  // repo root. `git rev-parse --show-toplevel` below will canonicalize to
  // the actual root.
  try {
    await stat(join(resolved, ".git"));
  } catch {
    throw new ProjectRegistrationError(`${resolved} is not a git repository (.git missing).`);
  }
  return resolved;
}

async function assertValidRefName(repoPath: string, ref: string): Promise<void> {
  // `--allow-onelevel` permits short branch names (e.g. "main"); without it
  // `check-ref-format` would reject any ref without a slash. We deliberately
  // avoid `--branch` because that triggers DWIM expansion and we want
  // to refuse refs like `@{-1}` that resolve to historical state.
  try {
    await execFileAsync("git", ["-C", repoPath, "check-ref-format", "--allow-onelevel", ref]);
  } catch {
    throw new ProjectRegistrationError(`Invalid git ref name: ${ref}`);
  }
}

async function readGitMetadata(candidatePath: string): Promise<GitMetadata> {
  try {
    const root = (await git(candidatePath, ["rev-parse", "--show-toplevel"])).trim();
    const currentBranch = (await git(root, ["branch", "--show-current"])).trim() || "HEAD";
    const defaultBranch = await discoverDefaultBranch(root, currentBranch);

    return {
      repoPath: root,
      currentBranch,
      defaultBranch
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown git error";
    throw new ProjectRegistrationError(`Maestro requires a local git repository. ${detail}`);
  }
}

async function discoverDefaultBranch(repoPath: string, currentBranch: string): Promise<string | null> {
  const originHead = await gitMaybe(repoPath, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead) {
    return originHead.replace(/^origin\//, "");
  }

  for (const branch of ["main", "master", "trunk"]) {
    const exists = await gitMaybe(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (exists !== null) {
      return branch;
    }
  }

  return currentBranch === "HEAD" ? null : currentBranch;
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args]);
  return stdout;
}

async function gitMaybe(repoPath: string, args: string[]): Promise<string | null> {
  try {
    return await git(repoPath, args);
  } catch {
    return null;
  }
}

function defaultSettings(repoPath: string): ProjectSettings {
  return {
    defaultProvider: "codex",
    defaultModelLabel: "GPT-5 Codex",
    worktreeLocation: join(repoPath, ".maestro", "worktrees"),
    setupCommand: "",
    checkCommands: []
  };
}
