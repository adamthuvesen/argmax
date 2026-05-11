import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { ArgmaxDatabase } from "../persistence/database.js";
import { PROVIDER_MODEL_DEFAULTS } from "../../shared/providerModels.js";
import type { ProjectSettings, ProjectSummary, RegisterProjectInput, UpdateProjectSettingsInput } from "../../shared/types.js";
import { runGitMaybe, runGitText } from "../git/exec.js";

const execFileAsync = promisify(execFile);

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
  constructor(private readonly database: ArgmaxDatabase) {}

  async registerProject(input: RegisterProjectInput): Promise<ProjectSummary> {
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

  updateSettings(input: UpdateProjectSettingsInput): ProjectSummary {
    return this.database.updateProjectSettings(input.projectId, input.settings);
  }
}

async function canonicalizeRepoPath(candidatePath: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(candidatePath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown filesystem error";
    throw new ProjectRegistrationError(`Argmax could not resolve ${candidatePath}. ${detail}`);
  }
  let stats;
  try {
    stats = await stat(resolved);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown filesystem error";
    throw new ProjectRegistrationError(`Argmax could not stat ${resolved}. ${detail}`);
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
    const root = (await runGitText(candidatePath, ["rev-parse", "--show-toplevel"])).trim();
    const currentBranch = (await runGitText(root, ["branch", "--show-current"])).trim() || "HEAD";
    const defaultBranch = await discoverDefaultBranch(root, currentBranch);

    return {
      repoPath: root,
      currentBranch,
      defaultBranch
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown git error";
    throw new ProjectRegistrationError(`Argmax requires a local git repository. ${detail}`);
  }
}

async function discoverDefaultBranch(repoPath: string, currentBranch: string): Promise<string | null> {
  const originHead = await runGitMaybe(repoPath, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead) {
    return originHead.trim().replace(/^origin\//, "");
  }

  for (const branch of ["main", "master", "trunk"]) {
    const exists = await runGitMaybe(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (exists !== null) {
      return branch;
    }
  }

  return currentBranch === "HEAD" ? null : currentBranch;
}

function defaultSettings(repoPath: string): ProjectSettings {
  return {
    defaultProvider: "codex",
    defaultModelLabel: PROVIDER_MODEL_DEFAULTS.codex.label,
    worktreeLocation: join(repoPath, ".argmax", "worktrees"),
    setupCommand: "",
    checkCommands: []
  };
}
