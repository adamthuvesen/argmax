import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { getDataDirectory } from "../paths.js";
import type { MaestroDatabase } from "../persistence/database.js";
import type { Checkpoint } from "../../shared/types.js";

const execFileAsync = promisify(execFile);

export interface CreateCheckpointInput {
  workspaceId: string;
  label: string;
}

export class CheckpointService {
  constructor(
    private readonly database: MaestroDatabase,
    private readonly checkpointDirectory = join(getDataDirectory(), "checkpoints")
  ) {}

  async createCheckpoint(input: CreateCheckpointInput): Promise<Checkpoint> {
    const workspace = this.database.getWorkspace(input.workspaceId);
    const id = randomUUID();
    const branch = (await git(workspace.path, ["branch", "--show-current"])).trim() || workspace.branch;
    const gitRef = (await git(workspace.path, ["rev-parse", "HEAD"])).trim() || null;
    const diff = await git(workspace.path, ["diff", "--binary", "HEAD"]);
    const patchPath = join(this.checkpointDirectory, `${id}.patch`);

    await mkdir(this.checkpointDirectory, { recursive: true });
    await writeFile(patchPath, diff, "utf8");

    return this.database.persistCheckpoint({
      id,
      workspaceId: workspace.id,
      label: input.label,
      branch,
      gitRef,
      patchPath
    });
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout;
}
