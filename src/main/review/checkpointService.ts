import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDataDirectory } from "../paths.js";
import type { MaestroDatabase } from "../persistence/database.js";
import type { Checkpoint } from "../../shared/types.js";
import { runGitBuffer, runGitText } from "../git/exec.js";

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
    // Independent reads — fan out so the slow binary diff doesn't gate the metadata calls.
    const [branchRaw, gitRefRaw, diff] = await Promise.all([
      runGitText(workspace.path, ["branch", "--show-current"]),
      runGitText(workspace.path, ["rev-parse", "HEAD"]),
      runGitBuffer(workspace.path, ["diff", "--binary", "HEAD"])
    ]);
    const branch = branchRaw.trim() || workspace.branch;
    const gitRef = gitRefRaw.trim() || null;
    const patchPath = join(this.checkpointDirectory, `${id}.patch`);

    await mkdir(this.checkpointDirectory, { recursive: true });
    await writeFile(patchPath, diff);

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
