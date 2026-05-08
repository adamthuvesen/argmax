import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { MaestroDatabase } from "../persistence/database.js";
import type { CheckRun } from "../../shared/types.js";

export interface RunWorkspaceCheckInput {
  workspaceId: string;
  command: string;
  onOutput?: (chunk: string) => void;
}

export class CheckService {
  constructor(private readonly database: MaestroDatabase) {}

  async runWorkspaceCheck(input: RunWorkspaceCheckInput): Promise<CheckRun> {
    const workspace = this.database.getWorkspace(input.workspaceId);
    const check = this.database.persistCheck({
      id: randomUUID(),
      workspaceId: workspace.id,
      command: input.command,
      status: "running"
    });

    const output: string[] = [];
    const exitCode = await new Promise<number>((resolve) => {
      const child = spawn(input.command, {
        cwd: workspace.path,
        shell: true,
        env: process.env
      });

      const capture = (chunk: Buffer): void => {
        const text = chunk.toString();
        output.push(text);
        input.onOutput?.(text);
      };

      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      child.on("error", (error) => {
        output.push(error.message);
        resolve(1);
      });
      child.on("exit", (code) => resolve(code ?? 1));
    });

    return this.database.updateCheck(check.id, {
      status: exitCode === 0 ? "passed" : "failed",
      exitCode,
      summary: summarizeOutput(output.join(""))
    });
  }
}

function summarizeOutput(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) {
    return "No output.";
  }

  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  return lines.slice(-8).join("\n");
}
