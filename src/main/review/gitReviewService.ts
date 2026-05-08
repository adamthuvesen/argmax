import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MaestroDatabase } from "../persistence/database.js";
import type { ChangedFileSummary, WorkspaceDiff } from "../../shared/types.js";

const execFileAsync = promisify(execFile);

export class GitReviewService {
  constructor(private readonly database: MaestroDatabase) {}

  async listChangedFiles(workspaceId: string): Promise<ChangedFileSummary[]> {
    const workspace = this.database.getWorkspace(workspaceId);
    const porcelain = await git(workspace.path, ["status", "--porcelain"]);

    return porcelain
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => ({
        status: line.slice(0, 2).trim() || "?",
        path: parsePorcelainPath(line)
      }));
  }

  async loadDiff(workspaceId: string, filePath?: string): Promise<WorkspaceDiff> {
    const workspace = this.database.getWorkspace(workspaceId);
    const args = filePath ? ["diff", "--", filePath] : ["diff"];
    const content = await git(workspace.path, args);

    return {
      workspaceId,
      filePath: filePath ?? null,
      content
    };
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout;
}

function parsePorcelainPath(line: string): string {
  const rawPath = line.slice(3);
  const renameSeparator = " -> ";
  if (rawPath.includes(renameSeparator)) {
    return rawPath.slice(rawPath.indexOf(renameSeparator) + renameSeparator.length);
  }
  return rawPath;
}
