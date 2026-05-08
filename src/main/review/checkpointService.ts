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
    const branch = (await gitText(workspace.path, ["branch", "--show-current"])).trim() || workspace.branch;
    const gitRef = (await gitText(workspace.path, ["rev-parse", "HEAD"])).trim() || null;
    // `git diff --binary HEAD` emits patch text containing base64-encoded
    // binary hunks. We capture it as a Buffer so utf-8 decoding cannot
    // corrupt the binary segments before we write the patch to disk.
    // 256 MiB ceiling is intentionally generous: a checkpoint patch can
    // legitimately include large new binaries until truncation strategies
    // ship in a follow-up.
    const diff = await gitBuffer(workspace.path, ["diff", "--binary", "HEAD"]);
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

async function gitText(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
    encoding: "utf8"
  });
  return stdout;
}

async function gitBuffer(cwd: string, args: string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: 60_000,
    maxBuffer: 256 * 1024 * 1024,
    encoding: "buffer"
  });
  return stdout as Buffer;
}
