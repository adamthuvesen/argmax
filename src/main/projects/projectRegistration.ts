import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
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
    const metadata = await readGitMetadata(input.repoPath);
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
